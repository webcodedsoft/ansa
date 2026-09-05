import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { createDataSource, type Db } from "@ansa/db";
import { asOrganizationId } from "@ansa/shared";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { offerSlots, takeSlot } from "./booking";

/**
 * What a call actually does with a diary, against a real Postgres under RLS.
 *
 * `slots.test.ts` proves the arithmetic and `appointments.test.ts` in `@ansa/tools` proves
 * the speech. Neither can prove the thing that matters here: that a caller offered a time
 * can take it, that the row lands in the right organisation's diary linked to the right
 * call, and that the two ways this goes wrong — a time nobody offered, a time somebody else
 * just took — come back as sentences instead of exceptions.
 */

const loadEnv = (): void => {
  try {
    for (const line of readFileSync(resolve(process.cwd(), "../../.env"), "utf8").split("\n")) {
      const trimmed = line.trim();
      const eq = trimmed.indexOf("=");
      if (trimmed === "" || trimmed.startsWith("#") || eq === -1) continue;
      process.env[trimmed.slice(0, eq)] ??= trimmed.slice(eq + 1);
    }
  } catch {
    // CI supplies them directly.
  }
};

loadEnv();

const ownerUrl = process.env["MIGRATION_DIRECT_URL"];
const appUrl = process.env["DATABASE_URL"];

let owner: Db;
let db: Db;

const organizationId = randomUUID();
const otherOrganizationId = randomUUID();
let calendarId: string;
let callId: string;

const CARRIER_CALL_ID = `CA${randomUUID().replace(/-/g, "")}`;

/* A Wednesday, far enough ahead that no real booking collides with it, and `now` is set two
   days before so nothing is filtered as past. Lagos keeps UTC+1 all year, so 9am there is
   always 08:00Z — no DST arithmetic hides in these expectations. */
const DAY = "2027-03-03";
const NOW = new Date("2027-03-01T09:00:00Z");

describe.skipIf(ownerUrl === undefined || appUrl === undefined)("a call taking an appointment", () => {
  beforeAll(async () => {
    owner = await createDataSource({ url: ownerUrl ?? "", poolSize: 2 }).initialize();
    db = await createDataSource({ url: appUrl ?? "", poolSize: 2 }).initialize();

    for (const [id, name] of [
      [organizationId, "Booking, the diary's organisation"],
      [otherOrganizationId, "Booking, somebody else"],
    ]) {
      await owner.query("insert into organizations (id, name) values ($1, $2)", [id, name]);
    }

    const calendar = (await owner.query(
      `insert into appointment_calendars (organization_id, name, timezone, slot_minutes, buffer_minutes)
       values ($1, 'Consulting room', 'Africa/Lagos', 30, 0) returning id`,
      [organizationId],
    )) as { id: string }[];
    calendarId = String(calendar[0]?.id);

    // Nine to five every day, so the test does not depend on which weekday the date is.
    for (let weekday = 0; weekday < 7; weekday += 1) {
      await owner.query(
        `insert into appointment_availability (organization_id, calendar_id, weekday, start_minute, end_minute)
         values ($1, $2, $3, 540, 1020)`,
        [organizationId, calendarId, weekday],
      );
    }

    const call = (await owner.query(
      "insert into calls (organization_id, carrier_call_id, dialled) values ($1, $2, '+2348000000000') returning id",
      [organizationId, CARRIER_CALL_ID],
    )) as { id: string }[];
    callId = String(call[0]?.id);
  });

  afterAll(async () => {
    await db?.destroy();
    // Only the rows this file inserted, under two organisation ids generated at run time.
    const clear = async (table: string, organization: string): Promise<void> => {
      await owner?.query(`delete from ${table} where organization_id = $1`, [organization]);
    };
    for (const organization of [organizationId, otherOrganizationId]) {
      for (const table of [
        "appointment_bookings",
        "appointment_availability",
        "appointment_calendars",
        "calls",
      ]) {
        await clear(table, organization);
      }
      await owner?.query("delete from organizations where id = $1", [organization]);
    }
    await owner?.destroy();
  });

  const offer = (day: string | null, now: Date = NOW) =>
    offerSlots(db, asOrganizationId(organizationId), calendarId, day, now);

  const take = (startsAt: string, name: string | null, now: Date = NOW) =>
    takeSlot(db, asOrganizationId(organizationId), calendarId, CARRIER_CALL_ID, startsAt, name, now);

  it("offers the day's hours in the calendar's own zone, as words", async () => {
    const slots = await offer(DAY);

    expect(slots.length).toBe(16);
    /* The offset is the calendar's, not the server's. A caller told "nine o'clock" and a row
       written at 09:00Z would be an hour apart, and nobody would notice until somebody
       arrived to an empty room. */
    expect(slots[0]?.startsAt).toBe("2027-03-03T09:00:00+01:00");
    expect(slots[0]?.spoken).toContain("9am");
    expect(slots.at(-1)?.startsAt).toBe("2027-03-03T16:30:00+01:00");
  });

  it("never offers a time that has already gone", async () => {
    // Half past two on the day itself: the morning is real, and it is over.
    const slots = await offer(DAY, new Date("2027-03-03T13:30:00Z"));

    expect(slots.length).toBeGreaterThan(0);
    expect(slots.every((slot) => !slot.startsAt.startsWith("2027-03-03T09"))).toBe(true);
    // 13:30Z is half past two in Lagos, and a slot starting exactly now is still takeable.
    expect(slots[0]?.startsAt).toBe("2027-03-03T14:30:00+01:00");
  });

  it("books a time it just offered, into this organisation's diary and against this call", async () => {
    const [first] = await offer(DAY);
    const answer = await take(String(first?.startsAt), "Adaeze");

    expect(answer).toMatchObject({ booked: true });

    const rows = (await owner.query(
      `select organization_id, status, call_id, title, starts_at, ends_at
         from appointment_bookings where calendar_id = $1`,
      [calendarId],
    )) as Record<string, unknown>[];

    expect(rows.length).toBe(1);
    expect(rows[0]?.["organization_id"]).toBe(organizationId);
    expect(rows[0]?.["status"]).toBe("booked");
    // The carrier's id is not the one this column holds; it was resolved to our own call row.
    expect(rows[0]?.["call_id"]).toBe(callId);
    expect(rows[0]?.["title"]).toBe("Adaeze");
    // Half an hour, from the calendar's own slot length rather than from anything the model said.
    expect(
      new Date(String(rows[0]?.["ends_at"])).getTime() -
        new Date(String(rows[0]?.["starts_at"])).getTime(),
    ).toBe(30 * 60_000);
  });

  it("stops offering a time once it is taken", async () => {
    const slots = await offer(DAY);
    expect(slots.length).toBe(15);
    expect(slots[0]?.startsAt).toBe("2027-03-03T09:30:00+01:00");
  });

  it("refuses a time that has since been taken", async () => {
    /* The gap between being offered a time and saying yes is real — a caller takes thirty
       seconds to answer, and another call can land in it. Re-reading the free slots inside
       the booking is what closes it, and it closes it *before* the unique index does: the
       time is simply no longer on offer. */
    const answer = await take("2027-03-03T09:00:00+01:00", null);
    expect(answer).toEqual({ booked: false, reason: "that time is not free" });
  });

  it("gives one slot to one caller when two ask at the same instant", async () => {
    /* The narrow race the re-read cannot close, because both calls read the slot as free
       before either wrote. Postgres decides it, `bookSlot` turns the losing insert into
       `SlotTaken`, and this asserts the only thing that actually matters: one row, not two.
       Which caller loses is the database's business and is not asserted. */
    const when = "2027-03-03T11:00:00+01:00";
    const answers = await Promise.all([take(when, "First"), take(when, "Second")]);

    expect(answers.filter((answer) => answer.booked).length).toBe(1);
    expect(answers.filter((answer) => !answer.booked).length).toBe(1);

    const rows = (await owner.query(
      "select id from appointment_bookings where calendar_id = $1 and starts_at = $2 and status <> 'cancelled'",
      [calendarId, new Date(when)],
    )) as unknown[];
    expect(rows.length).toBe(1);
  });

  it("refuses a time the diary never offered", async () => {
    // Three in the morning is not in anybody's opening hours, and the model composed it.
    const answer = await take("2027-03-03T03:00:00+01:00", null);
    expect(answer).toEqual({ booked: false, reason: "that time is not free" });
  });

  it("refuses a time that is not a time", async () => {
    expect(await take("next Thursday", null)).toMatchObject({ booked: false });
  });

  it("offers another organisation nothing from this diary", async () => {
    /* The calendar id is a uuid and an id is guessable. RLS is what makes this empty rather
       than the id being secret — the same rule the whole tenancy layer rests on. */
    const slots = await offerSlots(db, asOrganizationId(otherOrganizationId), calendarId, DAY, NOW);
    expect(slots).toEqual([]);
  });

  it("refuses to book into another organisation's diary", async () => {
    const answer = await takeSlot(
      db,
      asOrganizationId(otherOrganizationId),
      calendarId,
      CARRIER_CALL_ID,
      "2027-03-03T11:00:00+01:00",
      null,
      NOW,
    );
    expect(answer).toMatchObject({ booked: false });

    const rows = (await owner.query(
      "select id from appointment_bookings where organization_id = $1",
      [otherOrganizationId],
    )) as unknown[];
    expect(rows.length).toBe(0);
  });
});
