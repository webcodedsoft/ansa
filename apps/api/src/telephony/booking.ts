import {
  bookSlot,
  SlotTaken,
  withOrganization,
  type Db,
} from "@ansa/db";
import { sayInstant, type BookingAnswer, type OfferedSlot } from "@ansa/tools";
import type { OrganizationId } from "@ansa/shared";

import { freeSlotsIn } from "../api/appointments/free-slots";
import { localDateKey, toOffsetIso } from "../api/appointments/slots";

/**
 * The two things a call does with a diary: read out what is free, and take one.
 *
 * Lifted out of the gateway rather than left in it so both can be tested against a real
 * calendar without standing up a media socket. The gateway supplies these to
 * `appointmentTools` as two closures; everything about tenancy is decided here, by
 * `withOrganization`, and nothing about it is decided in `@ansa/tools`.
 */
/** How far ahead a caller is offered times when they did not name a day. */
const OFFER_HORIZON_MS = 14 * 24 * 60 * 60_000;

/**
 * Slack around a named day, because a date is not an instant.
 *
 * "The third of March" in the diary's own zone starts somewhere between eighteen hours
 * before and eighteen hours after midnight UTC on the third, depending where the diary
 * keeps its hours. Asking wide and then filtering on the zone's own calendar date is the
 * only version of this that is right in every zone; asking for the UTC day drops the first
 * or last hours of the day the caller meant.
 */
const ZONE_SLACK_MS = 18 * 60 * 60_000;

const DAY_MS = 24 * 60 * 60_000;

/**
 * The times this diary can actually offer, as words a caller can hear.
 *
 * Past slots are dropped here rather than by the range, because a named day includes hours
 * that have already gone: it is half four and the caller asks about today. Offering half
 * two is the kind of wrong answer that survives all the way to somebody turning up.
 */
export const offerSlots = async (
  dataSource: Db,
  organizationId: OrganizationId,
  calendarId: string,
  day: string | null,
  now: Date,
): Promise<readonly OfferedSlot[]> => {
  const midnight = day === null ? 0 : Date.parse(`${day}T00:00:00Z`);
  const from = day === null ? now : new Date(midnight - ZONE_SLACK_MS);
  const to =
    day === null ? new Date(now.getTime() + OFFER_HORIZON_MS) : new Date(midnight + DAY_MS + ZONE_SLACK_MS);

  const found = await withOrganization(dataSource, organizationId, (scope) =>
    freeSlotsIn(scope, calendarId, { from, to }),
  );
  // Null is a calendar this organisation does not hold — the agent was pointed at one that
  // has since gone. Nothing free is the honest answer and the tool says so in words.
  if (found === null) return [];

  const zone = found.calendar.timezone;
  return found.slots
    .filter((slot) => slot.start.getTime() >= now.getTime())
    .filter((slot) => day === null || localDateKey(slot.start, zone) === day)
    .map((slot) => {
      const startsAt = toOffsetIso(slot.start, zone);
      return { startsAt, spoken: sayInstant(startsAt) };
    });
};

/**
 * Take a time, or say why not.
 *
 * The check that matters is the one in the middle: only an instant the diary *just offered*
 * is booked. Writing whatever instant the model produced would let a call put an appointment
 * outside opening hours, on a public holiday, or on top of somebody — the model is composing
 * a string, and none of those rules live in it. They live in `computeFreeSlots`, so the way
 * to enforce them is to ask it again and require an exact match.
 *
 * Reading it again also closes the gap between being offered a time and accepting it: a
 * caller who takes thirty seconds to say yes can lose the slot to another call, and this
 * turns that into "somebody has just taken that time" rather than a double booking.
 */
export const takeSlot = async (
  dataSource: Db,
  organizationId: OrganizationId,
  calendarId: string,
  carrierCallId: string,
  startsAt: string,
  name: string | null,
  now: Date,
): Promise<BookingAnswer> => {
  const when = new Date(Date.parse(startsAt));
  if (Number.isNaN(when.getTime())) return { booked: false, reason: "that time did not make sense" };
  if (when.getTime() < now.getTime()) return { booked: false, reason: "that time has already passed" };

  return withOrganization(dataSource, organizationId, async (scope) => {
    const found = await freeSlotsIn(scope, calendarId, { from: when, to: new Date(when.getTime() + DAY_MS) });
    if (found === null) return { booked: false, reason: "there is no diary to book into" };

    const slot = found.slots.find((entry) => entry.start.getTime() === when.getTime());
    if (slot === undefined) return { booked: false, reason: "that time is not free" };

    /* Our own call row, looked up under RLS rather than passed in: the id the socket holds is
       the carrier's, and `appointment_bookings.call_id` references `calls`. Scoped, so a
       carrier id belonging to another organisation resolves to nothing rather than to their
       call — the same mistake the contact FK made before it was fixed. */
    const rows = await scope.query<{ id: string }>(
      "select id from calls where carrier_call_id = $1 limit 1",
      [carrierCallId],
    );

    try {
      await bookSlot(scope, {
        calendarId,
        startsAt: slot.start,
        endsAt: slot.end,
        status: "booked",
        source: "call",
        callId: rows[0]?.id ?? null,
        ...(name === null ? {} : { title: name }),
      });
    } catch (error) {
      // The unique index refusing a second live row at the same instant, which is a sentence
      // to say to the caller and not an error to drop the call over.
      if (error instanceof SlotTaken) return { booked: false, reason: "somebody has just taken that time" };
      throw error;
    }

    return { booked: true, spoken: sayInstant(toOffsetIso(slot.start, found.calendar.timezone)) };
  });
};

