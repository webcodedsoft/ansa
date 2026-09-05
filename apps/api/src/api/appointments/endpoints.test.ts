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
const organizationId = randomUUID();
const userId = randomUUID();

interface Reply {
  readonly status: number;
  readonly body: Record<string, unknown>;
}

const send = async (method: string, path: string, body?: unknown): Promise<Reply> => {
  const response = await fetch(`${baseUrl}${path}`, {
    method,
    headers: {
      authorization: `Bearer ${token}`,
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
  });

  afterAll(async () => {
    await app?.close();
    // Rows first — the FK from every appointment table is to this organisation.
    await owner?.query("delete from appointment_bookings where organization_id = $1", [organizationId]);
    await owner?.query("delete from appointment_availability where organization_id = $1", [organizationId]);
    await owner?.query("delete from appointment_calendars where organization_id = $1", [organizationId]);
    await owner?.query("delete from organizations where id = $1", [organizationId]);
    await owner?.query("delete from users where id = $1", [userId]);
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

  it("refuses every route without a session", async () => {
    for (const path of [
      "/api/v1/appointments/calendars",
      `/api/v1/appointments/calendars/${randomUUID()}/slots?from=2026-03-02T00:00:00Z&to=2026-03-03T00:00:00Z`,
    ]) {
      const response = await fetch(`${baseUrl}${path}`);
      expect(response.status, path).toBe(401);
    }
  });
});
