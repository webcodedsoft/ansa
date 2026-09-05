import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { createDataSource, type Db } from "@ansa/db";
import type { INestApplication } from "@nestjs/common";
import { NestFactory } from "@nestjs/core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { ApiModule } from "../api.module";
import { hashPassword } from "../auth/password";

/**
 * The appointments surface over real HTTP, against a real Postgres, with a real session.
 *
 * The unit tests in `slots.test.ts` prove the arithmetic. This proves the parts a unit test
 * cannot: that the module wires up, that a request-scoped controller opens an organization
 * transaction, that what each handler returns survives its own response schema — a field the
 * schema does not admit is a 500 at runtime and passes every test that does not make the
 * request — and that the two states the database owns (a slot taken twice, a hold that lapsed)
 * become the 409s the controller promises rather than a leaked stack trace.
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
let app: INestApplication;
let baseUrl: string;
let token: string;
/* A second organisation with its own session, for one question a single-organisation test
   cannot ask: whether one organisation's closures reach another's slots. */
let otherToken: string;
const organizationId = randomUUID();
const userId = randomUUID();
const otherOrganizationId = randomUUID();
const otherUserId = randomUUID();

interface Reply {
  readonly status: number;
  readonly body: Record<string, unknown>;
}

const send = async (
  method: string,
  path: string,
  body?: unknown,
  as?: string,
): Promise<Reply> => {
  const response = await fetch(`${baseUrl}${path}`, {
    method,
    headers: {
      authorization: `Bearer ${as ?? token}`,
      ...(body === undefined ? {} : { "content-type": "application/json" }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const text = await response.text();
  return {
    status: response.status,
    body: text === "" ? {} : (JSON.parse(text) as Record<string, unknown>),
  };
};

describe.skipIf(ownerUrl === undefined || appUrl === undefined)("the appointments endpoints", () => {
  beforeAll(async () => {
    owner = await createDataSource({ url: ownerUrl ?? "", poolSize: 2 }).initialize();
    const email = `appointments-${organizationId}@invalid.test`;
    const password = `${randomUUID()}-${randomUUID()}`;

    await owner.query("insert into organizations (id, name) values ($1, $2)", [
      organizationId,
      "Appointments endpoints",
    ]);
    await owner.query(
      "insert into users (id, email, password_hash, display_name) values ($1, $2, $3, $4)",
      [userId, email, await hashPassword(password), "Owner"],
    );
    await owner.query(
      "insert into memberships (organization_id, user_id, role) values ($1, $2, 'owner')",
      [organizationId, userId],
    );

    app = await NestFactory.create(ApiModule, { logger: false });
    await app.listen(0);
    baseUrl = await app.getUrl();

    const signIn = await fetch(`${baseUrl}/api/v1/auth/sessions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email, password, organisationId: organizationId }),
    });
    token = String(((await signIn.json()) as Record<string, unknown>)["token"]);

    const otherEmail = `appointments-${otherOrganizationId}@invalid.test`;
    const otherPassword = `${randomUUID()}-${randomUUID()}`;
    await owner.query("insert into organizations (id, name) values ($1, $2)", [
      otherOrganizationId,
      "Appointments endpoints, the other organisation",
    ]);
    await owner.query(
      "insert into users (id, email, password_hash, display_name) values ($1, $2, $3, $4)",
      [otherUserId, otherEmail, await hashPassword(otherPassword), "Owner"],
    );
    await owner.query(
      "insert into memberships (organization_id, user_id, role) values ($1, $2, 'owner')",
      [otherOrganizationId, otherUserId],
    );
    const otherSignIn = await fetch(`${baseUrl}/api/v1/auth/sessions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        email: otherEmail,
        password: otherPassword,
        organisationId: otherOrganizationId,
      }),
    });
    otherToken = String(((await otherSignIn.json()) as Record<string, unknown>)["token"]);
  });

  afterAll(async () => {
    await app?.close();
    // Rows first — the FK from every appointment table is to this organisation.
    for (const organization of [organizationId, otherOrganizationId]) {
      await owner?.query("delete from appointment_bookings where organization_id = $1", [organization]);
      await owner?.query("delete from appointment_availability where organization_id = $1", [organization]);
      await owner?.query("delete from appointment_calendars where organization_id = $1", [organization]);
      await owner?.query("delete from holidays where organization_id = $1", [organization]);
      await owner?.query("delete from organizations where id = $1", [organization]);
    }
    await owner?.query("delete from users where id = any($1)", [[userId, otherUserId]]);
    await owner?.destroy();
  });

  const createCalendar = async (): Promise<string> => {
    const reply = await send("POST", "/api/v1/appointments/calendars", {
      name: "Consulting room",
      timezone: "Africa/Lagos",
      slotMinutes: 30,
      bufferMinutes: 0,
    });
    expect(reply.status, JSON.stringify(reply.body)).toBe(201);
    return String(reply.body["id"]);
  };

  it("refuses a calendar whose timezone is not a real zone", async () => {
    const reply = await send("POST", "/api/v1/appointments/calendars", {
      name: "Nowhere",
      timezone: "Mars/Phobos",
    });
    expect(reply.status).toBe(422);
  });

  it("refuses a connector calendar with no externalRef", async () => {
    const reply = await send("POST", "/api/v1/appointments/calendars", {
      name: "Linked",
      timezone: "Africa/Lagos",
      source: "connector",
    });
    expect(reply.status).toBe(422);
  });

  it("creates, reads, lists and edits a calendar", async () => {
    const id = await createCalendar();

    const read = await send("GET", `/api/v1/appointments/calendars/${id}`);
    expect(read.status).toBe(200);
    expect(read.body).toMatchObject({ id, timezone: "Africa/Lagos", slotMinutes: 30, source: "hosted" });

    const list = await send("GET", "/api/v1/appointments/calendars");
    expect((list.body["items"] as unknown[]).length).toBeGreaterThanOrEqual(1);

    const patched = await send("PATCH", `/api/v1/appointments/calendars/${id}`, { bufferMinutes: 10 });
    expect(patched.status).toBe(200);
    expect(patched.body["bufferMinutes"]).toBe(10);
  });

  it("answers 404 for a calendar this organisation does not hold", async () => {
    const reply = await send("GET", `/api/v1/appointments/calendars/${randomUUID()}`);
    expect(reply.status).toBe(404);
  });

  it("replaces the week's hours and refuses overlapping windows", async () => {
    const id = await createCalendar();

    const overlap = await send("PUT", `/api/v1/appointments/calendars/${id}/availability`, {
      windows: [
        { weekday: 1, startMinute: 540, endMinute: 720 },
        { weekday: 1, startMinute: 660, endMinute: 900 },
      ],
    });
    expect(overlap.status).toBe(422);

    const ok = await send("PUT", `/api/v1/appointments/calendars/${id}/availability`, {
      windows: [{ weekday: 1, startMinute: 540, endMinute: 660 }],
    });
    expect(ok.status, JSON.stringify(ok.body)).toBe(200);
    expect((ok.body["windows"] as unknown[]).length).toBe(1);

    const read = await send("GET", `/api/v1/appointments/calendars/${id}/availability`);
    expect((read.body["windows"] as Record<string, unknown>[])[0]).toMatchObject({
      weekday: 1,
      startMinute: 540,
      endMinute: 660,
    });
  });

  it("computes free slots from the hours in the calendar's zone", async () => {
    const id = await createCalendar();
    await send("PUT", `/api/v1/appointments/calendars/${id}/availability`, {
      windows: [{ weekday: 1, startMinute: 9 * 60, endMinute: 11 * 60 }],
    });

    // 2026-03-02 is a Monday. 09:00–11:00 Lagos in 30-minute slots is four slots.
    const reply = await send(
      "GET",
      `/api/v1/appointments/calendars/${id}/slots?from=2026-03-02T00:00:00Z&to=2026-03-03T00:00:00Z`,
    );
    expect(reply.status, JSON.stringify(reply.body)).toBe(200);
    const starts = (reply.body["slots"] as Record<string, unknown>[]).map((slot) => slot["start"]);
    expect(starts).toEqual([
      "2026-03-02T09:00:00+01:00",
      "2026-03-02T09:30:00+01:00",
      "2026-03-02T10:00:00+01:00",
      "2026-03-02T10:30:00+01:00",
    ]);
  });

  it("refuses a slots range whose from is not before to", async () => {
    const id = await createCalendar();
    const reply = await send(
      "GET",
      `/api/v1/appointments/calendars/${id}/slots?from=2026-03-03T00:00:00Z&to=2026-03-02T00:00:00Z`,
    );
    expect(reply.status).toBe(422);
  });

  /* What a person at a desk does, as against what a call does: write down a thing that is an
     hour and a half long, call it something, then drag it an hour later and rename it. */
  it("writes an appointment of its own length and name, then moves, resizes and renames it", async () => {
    const id = await createCalendar();

    const made = await send("POST", `/api/v1/appointments/calendars/${id}/bookings`, {
      startsAt: "2026-03-04T09:00:00Z",
      endsAt: "2026-03-04T10:30:00Z",
      title: "Second viewing — 14 Adeola Odeku",
      source: "manual",
    });
    expect(made.status, JSON.stringify(made.body)).toBe(201);
    expect(made.body).toMatchObject({
      startsAt: "2026-03-04T09:00:00.000Z",
      endsAt: "2026-03-04T10:30:00.000Z",
      title: "Second viewing — 14 Adeola Odeku",
    });
    const bookingId = String(made.body["id"]);

    // Dragged an hour down the grid and given a shorter length, with the note left alone.
    const moved = await send("PATCH", `/api/v1/appointments/bookings/${bookingId}`, {
      startsAt: "2026-03-04T10:00:00Z",
      endsAt: "2026-03-04T11:00:00Z",
      title: "Second viewing — moved",
    });
    expect(moved.status, JSON.stringify(moved.body)).toBe(200);
    expect(moved.body).toMatchObject({
      startsAt: "2026-03-04T10:00:00.000Z",
      endsAt: "2026-03-04T11:00:00.000Z",
      title: "Second viewing — moved",
    });

    // Half a move is refused rather than left ending before it starts.
    const half = await send("PATCH", `/api/v1/appointments/bookings/${bookingId}`, {
      startsAt: "2026-03-04T12:00:00Z",
    });
    expect(half.status).toBe(422);

    // And a move onto a minute something else already starts on is the 409 a booking gets.
    const other = await send("POST", `/api/v1/appointments/calendars/${id}/bookings`, {
      startsAt: "2026-03-04T15:00:00Z",
      source: "manual",
    });
    expect(other.status).toBe(201);
    const onto = await send("PATCH", `/api/v1/appointments/bookings/${bookingId}`, {
      startsAt: "2026-03-04T15:00:00Z",
      endsAt: "2026-03-04T16:00:00Z",
    });
    expect(onto.status).toBe(409);
  });

  it("books a slot and turns a second booking of it into a 409", async () => {
    const id = await createCalendar();
    const startsAt = "2026-03-02T09:00:00Z";

    const first = await send("POST", `/api/v1/appointments/calendars/${id}/bookings`, {
      startsAt,
      source: "manual",
    });
    expect(first.status, JSON.stringify(first.body)).toBe(201);
    expect(first.body).toMatchObject({ status: "booked", source: "manual" });

    const clash = await send("POST", `/api/v1/appointments/calendars/${id}/bookings`, {
      startsAt,
      source: "manual",
    });
    expect(clash.status).toBe(409);

    const list = await send(
      "GET",
      `/api/v1/appointments/calendars/${id}/bookings?from=2026-03-02T00:00:00Z&to=2026-03-03T00:00:00Z`,
    );
    expect((list.body["items"] as unknown[]).length).toBe(1);
  });

  it("holds a slot, confirms it, and refuses to confirm a lapsed hold", async () => {
    const id = await createCalendar();

    const held = await send("POST", `/api/v1/appointments/calendars/${id}/bookings`, {
      startsAt: "2026-03-02T09:30:00Z",
      source: "call",
      status: "held",
      holdMinutes: 30,
    });
    expect(held.status, JSON.stringify(held.body)).toBe(201);
    expect(held.body["status"]).toBe("held");
    expect(held.body["holdExpiresAt"]).not.toBeNull();

    const confirmed = await send("POST", `/api/v1/appointments/bookings/${String(held.body["id"])}/confirm`);
    expect(confirmed.status, JSON.stringify(confirmed.body)).toBe(200);
    expect(confirmed.body).toMatchObject({ status: "booked", holdExpiresAt: null });

    // A fresh hold, then force its expiry in the past and try to confirm it.
    const lapsing = await send("POST", `/api/v1/appointments/calendars/${id}/bookings`, {
      startsAt: "2026-03-02T10:00:00Z",
      source: "call",
      status: "held",
      holdMinutes: 30,
    });
    await owner.query("update appointment_bookings set hold_expires_at = now() - interval '1 minute' where id = $1", [
      String(lapsing.body["id"]),
    ]);
    const refused = await send("POST", `/api/v1/appointments/bookings/${String(lapsing.body["id"])}/confirm`);
    expect(refused.status).toBe(409);
  });

  it("cancels a booking and frees the slot", async () => {
    const id = await createCalendar();
    const booked = await send("POST", `/api/v1/appointments/calendars/${id}/bookings`, {
      startsAt: "2026-03-02T11:00:00Z",
      source: "manual",
    });
    const cancelled = await send("POST", `/api/v1/appointments/bookings/${String(booked.body["id"])}/cancel`);
    expect(cancelled.status, JSON.stringify(cancelled.body)).toBe(200);
    expect(cancelled.body["status"]).toBe("cancelled");

    // The slot is free again, so the same time books once more.
    const rebooked = await send("POST", `/api/v1/appointments/calendars/${id}/bookings`, {
      startsAt: "2026-03-02T11:00:00Z",
      source: "manual",
    });
    expect(rebooked.status).toBe(201);
  });

  it("carries an externalRef onto a connector booking", async () => {
    const linked = await send("POST", "/api/v1/appointments/calendars", {
      name: "Linked diary",
      timezone: "Africa/Lagos",
      source: "connector",
      externalRef: "cal_outside_123",
    });
    expect(linked.status, JSON.stringify(linked.body)).toBe(201);

    const booking = await send("POST", `/api/v1/appointments/calendars/${String(linked.body["id"])}/bookings`, {
      startsAt: "2026-03-02T12:00:00Z",
      source: "connector",
      externalRef: "evt_outside_456",
    });
    expect(booking.status, JSON.stringify(booking.body)).toBe(201);
    expect(booking.body["externalRef"]).toBe("evt_outside_456");
  });

  it("finds an appointment by name across calendars, and never another organisation's", async () => {
    const diary = await send("POST", "/api/v1/appointments/calendars", {
      name: "Search diary",
      timezone: "Africa/Lagos",
      slotMinutes: 30,
      bufferMinutes: 0,
      source: "hosted",
    });
    expect(diary.status, JSON.stringify(diary.body)).toBe(201);
    const calendarId = String(diary.body["id"]);

    const made = await send("POST", `/api/v1/appointments/calendars/${calendarId}/bookings`, {
      startsAt: "2026-04-02T09:00:00Z",
      source: "manual",
      title: "Second viewing, 14 Adeola Odeku",
      notes: "bring the spare keys",
    });
    expect(made.status, JSON.stringify(made.body)).toBe(201);

    // A partial word is what a person types into a diary; it has to match.
    const byTitle = await send("GET", "/api/v1/appointments/bookings/search?q=adeola");
    expect(byTitle.status, JSON.stringify(byTitle.body)).toBe(200);
    const titleHits = byTitle.body["items"] as readonly Record<string, unknown>[];
    expect(titleHits).toHaveLength(1);
    expect(titleHits[0]?.["id"]).toBe(made.body["id"]);

    // The note is searched too, since an appointment a call took has no title.
    const byNote = await send("GET", "/api/v1/appointments/bookings/search?q=spare%20keys");
    expect((byNote.body["items"] as readonly unknown[]).length).toBe(1);

    const miss = await send("GET", "/api/v1/appointments/bookings/search?q=nothinglikethis");
    expect(miss.body["items"]).toEqual([]);

    // A wildcard is a literal, not a request for the whole diary.
    const wildcard = await send("GET", "/api/v1/appointments/bookings/search?q=%25%25");
    expect(wildcard.status).toBe(200);
    expect(wildcard.body["items"]).toEqual([]);

    // One character is not a search.
    const tooShort = await send("GET", "/api/v1/appointments/bookings/search?q=a");
    expect(tooShort.status).toBe(422);

    // Cancelled appointments are not results: they are not appointments any more.
    const cancelled = await send("POST", `/api/v1/appointments/bookings/${String(made.body["id"])}/cancel`, {});
    expect(cancelled.status, JSON.stringify(cancelled.body)).toBe(200);
    const afterCancel = await send("GET", "/api/v1/appointments/bookings/search?q=adeola");
    expect(afterCancel.body["items"]).toEqual([]);
  });

  /* ---------------------------------------------------------------------------------------
     Days the office is shut (0064).

     The point of the table is one sentence: the agent must never offer a caller a time on a
     day the office is closed. Everything below is that sentence and its edges — the days
     either side are ordinary, the judgement is made in the calendar's zone, an appointment
     somebody deliberately wrote on the holiday survives and is still writable, and another
     organisation's closures are none of this organisation's business.
     --------------------------------------------------------------------------------------- */

  /** Monday, Tuesday and Wednesday, 09:00-10:00 Lagos: two slots a day, easy to count. */
  const midweekCalendar = async (): Promise<string> => {
    const id = await createCalendar();
    const put = await send("PUT", `/api/v1/appointments/calendars/${id}/availability`, {
      windows: [1, 2, 3].map((weekday) => ({
        weekday,
        startMinute: 9 * 60,
        endMinute: 10 * 60,
      })),
    });
    expect(put.status, JSON.stringify(put.body)).toBe(200);
    return id;
  };

  const startsBetween = async (
    calendarId: string,
    from: string,
    to: string,
    as?: string,
  ): Promise<unknown[]> => {
    const reply = await send(
      "GET",
      `/api/v1/appointments/calendars/${calendarId}/slots?from=${from}&to=${to}`,
      undefined,
      as,
    );
    expect(reply.status, JSON.stringify(reply.body)).toBe(200);
    return (reply.body["slots"] as Record<string, unknown>[]).map((slot) => slot["start"]);
  };

  it("lists, adds and removes the days the organisation is shut", async () => {
    const added = await send("POST", "/api/v1/appointments/holidays", {
      onDate: "2026-10-01",
      name: "Independence Day",
    });
    expect(added.status, JSON.stringify(added.body)).toBe(201);
    expect(added.body).toMatchObject({ onDate: "2026-10-01", name: "Independence Day" });

    const listed = await send("GET", "/api/v1/appointments/holidays?from=2026-10-01&to=2026-10-31");
    expect(listed.status).toBe(200);
    expect((listed.body["items"] as Record<string, unknown>[]).map((day) => day["onDate"])).toEqual([
      "2026-10-01",
    ]);

    // One day is shut once; a second name for it is a typo, not a second closure.
    const again = await send("POST", "/api/v1/appointments/holidays", {
      onDate: "2026-10-01",
      name: "Independence",
    });
    expect(again.status).toBe(409);

    const removed = await send(
      "DELETE",
      `/api/v1/appointments/holidays/${String(added.body["id"])}`,
    );
    expect(removed.status).toBe(204);
    const empty = await send("GET", "/api/v1/appointments/holidays?from=2026-10-01&to=2026-10-31");
    expect(empty.body["items"]).toEqual([]);
  });

  it("refuses a date that is not a date, and half a range", async () => {
    // The pattern accepts this; the calendar does not.
    const impossible = await send("POST", "/api/v1/appointments/holidays", {
      onDate: "2026-02-31",
      name: "No",
    });
    expect(impossible.status).toBe(422);
    const wrongShape = await send("POST", "/api/v1/appointments/holidays", {
      onDate: "01/10/2026",
      name: "No",
    });
    expect(wrongShape.status).toBe(422);
    expect((await send("GET", "/api/v1/appointments/holidays?from=2026-10-01")).status).toBe(422);
    expect(
      (await send("GET", "/api/v1/appointments/holidays?from=2026-10-31&to=2026-10-01")).status,
    ).toBe(422);
    expect((await send("DELETE", `/api/v1/appointments/holidays/${randomUUID()}`)).status).toBe(404);
  });

  it("offers nothing on a holiday and leaves the days either side alone", async () => {
    const id = await midweekCalendar();
    // 2026-03-02 Mon, 2026-03-03 Tue, 2026-03-04 Wed.
    const week = ["2026-03-02T00:00:00Z", "2026-03-05T00:00:00Z"] as const;

    expect(await startsBetween(id, week[0], week[1])).toHaveLength(6);

    const shut = await send("POST", "/api/v1/appointments/holidays", {
      onDate: "2026-03-03",
      name: "A day the office is shut",
    });
    expect(shut.status, JSON.stringify(shut.body)).toBe(201);

    expect(await startsBetween(id, week[0], week[1])).toEqual([
      "2026-03-02T09:00:00+01:00",
      "2026-03-02T09:30:00+01:00",
      "2026-03-04T09:00:00+01:00",
      "2026-03-04T09:30:00+01:00",
    ]);

    // And it comes back when the office turns out to be open after all.
    const reopened = await send(
      "DELETE",
      `/api/v1/appointments/holidays/${String(shut.body["id"])}`,
    );
    expect(reopened.status).toBe(204);
    expect(await startsBetween(id, week[0], week[1])).toHaveLength(6);
  });

  it("judges the holiday in the calendar's timezone, not in UTC", async () => {
    /* A calendar fourteen hours ahead of UTC, open Tuesday morning. Nine on Tuesday the tenth
       in Kiritimati is 19:00Z on *Monday the ninth*, so a holiday compared against the UTC
       date of the instant would suppress the wrong day — twice over, because it would also
       leave open the day the caller is actually offered. Both halves are asserted. */
    const linked = await send("POST", "/api/v1/appointments/calendars", {
      name: "Far side of the dateline",
      timezone: "Pacific/Kiritimati",
      slotMinutes: 30,
    });
    expect(linked.status, JSON.stringify(linked.body)).toBe(201);
    const id = String(linked.body["id"]);
    await send("PUT", `/api/v1/appointments/calendars/${id}/availability`, {
      windows: [{ weekday: 2, startMinute: 9 * 60, endMinute: 10 * 60 }],
    });
    const range = ["2026-03-09T00:00:00Z", "2026-03-11T00:00:00Z"] as const;

    // The UTC date of those instants. Not the calendar's date, so nothing is withheld.
    const utcDate = await send("POST", "/api/v1/appointments/holidays", {
      onDate: "2026-03-09",
      name: "The UTC date, which is the wrong one",
    });
    expect(utcDate.status, JSON.stringify(utcDate.body)).toBe(201);
    expect(await startsBetween(id, range[0], range[1])).toEqual([
      "2026-03-10T09:00:00+14:00",
      "2026-03-10T09:30:00+14:00",
    ]);
    await send("DELETE", `/api/v1/appointments/holidays/${String(utcDate.body["id"])}`);

    // The calendar's own date, which is the day the caller would be told about.
    const zoneDate = await send("POST", "/api/v1/appointments/holidays", {
      onDate: "2026-03-10",
      name: "The calendar's date, which is the right one",
    });
    expect(zoneDate.status, JSON.stringify(zoneDate.body)).toBe(201);
    expect(await startsBetween(id, range[0], range[1])).toEqual([]);
    await send("DELETE", `/api/v1/appointments/holidays/${String(zoneDate.body["id"])}`);
  });

  it("still lists and still takes an appointment written on a holiday", async () => {
    /* Withholding the offer and forbidding the booking are different things. An office that
       opens specially on a public holiday puts an appointment in the diary on purpose, and
       neither the grid nor the desk may pretend it is not there. */
    const id = await midweekCalendar();
    const shut = await send("POST", "/api/v1/appointments/holidays", {
      onDate: "2026-03-10",
      name: "Shut, except for this one",
    });
    expect(shut.status, JSON.stringify(shut.body)).toBe(201);

    const day = ["2026-03-10T00:00:00Z", "2026-03-11T00:00:00Z"] as const;
    expect(await startsBetween(id, day[0], day[1])).toEqual([]);

    // A person at the desk writes one anyway, and is not refused.
    const written = await send("POST", `/api/v1/appointments/calendars/${id}/bookings`, {
      startsAt: "2026-03-10T08:00:00Z",
      endsAt: "2026-03-10T09:00:00Z",
      title: "Opening specially",
      source: "manual",
    });
    expect(written.status, JSON.stringify(written.body)).toBe(201);

    const listed = await send(
      "GET",
      `/api/v1/appointments/calendars/${id}/bookings?from=${day[0]}&to=${day[1]}`,
    );
    expect(listed.status).toBe(200);
    expect((listed.body["items"] as Record<string, unknown>[]).map((row) => row["title"])).toEqual([
      "Opening specially",
    ]);

    // And the day is still not offered to a caller.
    expect(await startsBetween(id, day[0], day[1])).toEqual([]);

    await send("DELETE", `/api/v1/appointments/holidays/${String(shut.body["id"])}`);
  });

  it("keeps one organisation's closures out of another organisation's slots", async () => {
    const mine = await midweekCalendar();

    const theirs = await send(
      "POST",
      "/api/v1/appointments/calendars",
      { name: "Their consulting room", timezone: "Africa/Lagos", slotMinutes: 30 },
      otherToken,
    );
    expect(theirs.status, JSON.stringify(theirs.body)).toBe(201);
    const theirId = String(theirs.body["id"]);
    await send(
      "PUT",
      `/api/v1/appointments/calendars/${theirId}/availability`,
      { windows: [{ weekday: 2, startMinute: 9 * 60, endMinute: 10 * 60 }] },
      otherToken,
    );

    const shut = await send("POST", "/api/v1/appointments/holidays", {
      onDate: "2026-03-17",
      name: "Our stocktake, not theirs",
    });
    expect(shut.status, JSON.stringify(shut.body)).toBe(201);

    const day = ["2026-03-17T00:00:00Z", "2026-03-18T00:00:00Z"] as const;
    // Ours is shut.
    expect(await startsBetween(mine, day[0], day[1])).toEqual([]);
    // Theirs is not, and it is the same Tuesday.
    expect(await startsBetween(theirId, day[0], day[1], otherToken)).toEqual([
      "2026-03-17T09:00:00+01:00",
      "2026-03-17T09:30:00+01:00",
    ]);

    /* They cannot see the closure, and cannot remove it. 404 rather than 403 — under RLS the
       id simply is not there, and a 403 would confirm that it is. */
    const theirList = await send(
      "GET",
      "/api/v1/appointments/holidays?from=2026-03-01&to=2026-03-31",
      undefined,
      otherToken,
    );
    expect(theirList.status).toBe(200);
    expect(theirList.body["items"]).toEqual([]);
    const theirDelete = await send(
      "DELETE",
      `/api/v1/appointments/holidays/${String(shut.body["id"])}`,
      undefined,
      otherToken,
    );
    expect(theirDelete.status).toBe(404);
    // Still shut for us afterwards: nothing they did reached our list.
    expect(await startsBetween(mine, day[0], day[1])).toEqual([]);

    await send("DELETE", `/api/v1/appointments/holidays/${String(shut.body["id"])}`);
  });

  it("refuses every route without a session", async () => {
    for (const path of [
      "/api/v1/appointments/calendars",
      `/api/v1/appointments/calendars/${randomUUID()}/slots?from=2026-03-02T00:00:00Z&to=2026-03-03T00:00:00Z`,
      "/api/v1/appointments/bookings/search?q=adeola",
      "/api/v1/appointments/holidays",
    ]) {
      const response = await fetch(`${baseUrl}${path}`);
      expect(response.status, path).toBe(401);
    }
  });
});
