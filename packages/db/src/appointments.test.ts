import { asOrganizationId } from "@ansa/shared";
import type { DataSource } from "typeorm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  bookSlot,
  cancelBooking,
  confirmHold,
  createCalendar,
  expireLapsedHolds,
  readAvailability,
  readBooking,
  readBookings,
  readCalendars,
  replaceAvailability,
  SlotTaken,
} from "./appointments";
import { createDataSource } from "./data-source";
import { withOrganization } from "./organization-scope";
import { loadDotEnv } from "./test-env";

loadDotEnv();

const url = process.env["DIRECT_URL"];

/**
 * A place in the diary (0062).
 *
 * Against the real database because the one rule that matters is the database's: two
 * callers cannot take one slot, and that is `appointment_bookings_one_per_slot_idx`, not a
 * check in TypeScript. A fake would let both through and the test would pass.
 *
 * Its own id range — `d9d9…`/`e9e9…` — per `test-organization-ids.test.ts`.
 */
const A = asOrganizationId("d9d9d9d9-d9d9-4d9d-8d9d-d9d9d9d9d9d9");
const B = asOrganizationId("e9e9e9e9-e9e9-4e9e-8e9e-e9e9e9e9e9e9");

const THURSDAY_AT_TWO = new Date("2026-09-10T13:00:00Z");
const THURSDAY_AT_HALF_TWO = new Date("2026-09-10T13:30:00Z");
const THURSDAY_AT_THREE = new Date("2026-09-10T14:00:00Z");

let ds: DataSource;
let clinic = "";

describe.skipIf(url === undefined)("a place in the diary", () => {
  beforeAll(async () => {
    ds = await createDataSource({ url: url ?? "", poolSize: 2 }).initialize();
    for (const organization of [A, B]) {
      await withOrganization(ds, organization, async (s) => {
        await s.query("insert into organizations (id, name) values ($1, $2) on conflict do nothing", [
          organization,
          `Organization ${organization.slice(0, 4)}`,
        ]);
      });
    }
    clinic = await withOrganization(ds, A, async (s) => {
      const created = await createCalendar(s, { name: "Clinic", timezone: "Africa/Lagos" });
      return created.id;
    });
  }, 60_000);

  afterAll(async () => {
    if (ds === undefined) return;
    for (const organization of [A, B]) {
      await withOrganization(ds, organization, async (s) => {
        await s.query("delete from organizations where id = $1", [organization]);
      });
    }
    await ds.destroy();
  });

  it("replaces the week as one statement", async () => {
    await withOrganization(ds, A, async (s) => {
      await replaceAvailability(s, clinic, [
        { weekday: 1, startMinute: 540, endMinute: 1020 },
        { weekday: 2, startMinute: 540, endMinute: 1020 },
      ]);
      const saved = await replaceAvailability(s, clinic, [{ weekday: 4, startMinute: 600, endMinute: 780 }]);
      expect(saved).toHaveLength(1);
      // Monday and Tuesday are gone, not merged.
      expect((await readAvailability(s, clinic)).map((w) => w.weekday)).toEqual([4]);
    });
  });

  it("lets exactly one of two callers take Thursday at two", async () => {
    await withOrganization(ds, A, async (s) => {
      const first = await bookSlot(s, {
        calendarId: clinic,
        startsAt: THURSDAY_AT_TWO,
        endsAt: THURSDAY_AT_HALF_TWO,
        status: "booked",
      });
      expect(first.status).toBe("booked");

      await expect(
        bookSlot(s, { calendarId: clinic, startsAt: THURSDAY_AT_TWO, endsAt: THURSDAY_AT_HALF_TWO, status: "booked" }),
      ).rejects.toBeInstanceOf(SlotTaken);

      // Cancelling frees it, because otherwise cancelling would mean nothing.
      expect(await cancelBooking(s, first.id)).toBe(true);
      const again = await bookSlot(s, {
        calendarId: clinic,
        startsAt: THURSDAY_AT_TWO,
        endsAt: THURSDAY_AT_HALF_TWO,
        status: "booked",
      });
      expect(again.id).not.toBe(first.id);

      const live = await readBookings(s, clinic, { from: THURSDAY_AT_TWO, to: THURSDAY_AT_THREE });
      expect(live.map((b) => b.id)).toEqual([again.id]);
    });
  });

  it("does not let a dropped call keep a slot", async () => {
    await withOrganization(ds, A, async (s) => {
      const lapsed = await bookSlot(s, {
        calendarId: clinic,
        startsAt: THURSDAY_AT_THREE,
        endsAt: new Date("2026-09-10T14:30:00Z"),
        status: "held",
        holdExpiresAt: new Date(Date.now() - 60_000),
      });

      // Still in the index until something sweeps it.
      expect((await readBookings(s, clinic, { from: THURSDAY_AT_THREE, to: new Date("2026-09-10T15:00:00Z") })).map((b) => b.id))
        .toEqual([lapsed.id]);
      // Too late to say yes.
      expect(await confirmHold(s, lapsed.id, new Date())).toBe(false);

      // The next caller is not refused a time nobody is holding.
      const taken = await bookSlot(s, {
        calendarId: clinic,
        startsAt: THURSDAY_AT_THREE,
        endsAt: new Date("2026-09-10T14:30:00Z"),
        status: "held",
        holdExpiresAt: new Date(Date.now() + 120_000),
      });
      expect((await readBooking(s, lapsed.id))?.status).toBe("cancelled");
      expect(await confirmHold(s, taken.id, new Date())).toBe(true);
      expect((await readBooking(s, taken.id))?.status).toBe("booked");

      expect(await expireLapsedHolds(s, clinic, new Date())).toBe(0);
    });
  });

  it("keeps one organisation's diary out of another's", async () => {
    await withOrganization(ds, B, async (s) => {
      expect(await readCalendars(s)).toEqual([]);
      expect(await readBookings(s, clinic, { from: THURSDAY_AT_TWO, to: THURSDAY_AT_THREE })).toEqual([]);
      // Not "slot taken" — B is not told the diary exists at all.
      await expect(
        bookSlot(s, { calendarId: clinic, startsAt: THURSDAY_AT_TWO, endsAt: THURSDAY_AT_HALF_TWO, status: "booked" }),
      ).rejects.toThrow(/No such calendar/);
    });
  });
});
