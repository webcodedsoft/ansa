import { asOrganizationId } from "@ansa/shared";
import type { DataSource } from "typeorm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createDataSource } from "./data-source";
import { addHoliday, readHolidays, removeHoliday } from "./holidays";
import { withOrganization } from "./organization-scope";
import { loadDotEnv } from "./test-env";

loadDotEnv();

const url = process.env["DIRECT_URL"];

/**
 * A day the office is shut (0064).
 *
 * Against the real database because two of the three things worth proving are the database's:
 * the unique index that stops one day being shut twice, and the `date` column that must hand
 * back the square somebody typed rather than an instant a driver invented. The third is RLS,
 * and a fake would hold no policies at all.
 *
 * Its own id range — `d2d2…`/`e3e3…` — per `test-organization-ids.test.ts`.
 */
const A = asOrganizationId("d2d2d2d2-d2d2-4d2d-8d2d-d2d2d2d2d2d2");
const B = asOrganizationId("e3e3e3e3-e3e3-4e3e-8e3e-e3e3e3e3e3e3");

const INDEPENDENCE_DAY = "2026-10-01";
const CHRISTMAS = "2026-12-25";
const BOXING_DAY = "2026-12-26";

let ds: DataSource;

describe.skipIf(url === undefined)("a day the office is shut", () => {
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

  it("keeps a date a date, with no hour for a timezone to move", async () => {
    await withOrganization(ds, A, async (s) => {
      const added = await addHoliday(s, { onDate: INDEPENDENCE_DAY, name: "Independence Day" });
      /* The trap: node-postgres parses a `date` into a JavaScript Date at *local* midnight, so
         a column read bare comes back as an instant that is the previous day west of the
         server. A string in and the same string out is the only shape that cannot do that. */
      expect(added?.onDate).toBe(INDEPENDENCE_DAY);
      expect(typeof added?.onDate).toBe("string");

      const [read] = await readHolidays(s, { from: INDEPENDENCE_DAY, to: INDEPENDENCE_DAY });
      expect(read?.onDate).toBe(INDEPENDENCE_DAY);
      expect(read?.name).toBe("Independence Day");
    });
  });

  it("shuts a day once, and says so rather than growing the list", async () => {
    await withOrganization(ds, A, async (s) => {
      expect(await addHoliday(s, { onDate: CHRISTMAS, name: "Christmas Day" })).not.toBeNull();
      // Same square, second name: one of the two is a typo and neither is a new closure.
      expect(await addHoliday(s, { onDate: CHRISTMAS, name: "Xmas" })).toBeNull();

      /* And the refusal must not have poisoned the transaction — `on conflict do nothing`
         rather than a caught unique violation is what buys this, and it is the reason the
         console can report the clash and carry on rendering the list. */
      const all = await readHolidays(s);
      expect(all.map((day) => day.onDate)).toContain(CHRISTMAS);
      expect(all.filter((day) => day.onDate === CHRISTMAS)).toHaveLength(1);
    });
  });

  it("returns a range with both ends included, earliest first", async () => {
    await withOrganization(ds, A, async (s) => {
      await addHoliday(s, { onDate: BOXING_DAY, name: "Boxing Day" });

      // A span of calendar squares, unlike the half-open instant ranges the bookings take.
      const both = await readHolidays(s, { from: CHRISTMAS, to: BOXING_DAY });
      expect(both.map((day) => day.onDate)).toEqual([CHRISTMAS, BOXING_DAY]);

      const neither = await readHolidays(s, { from: "2026-11-01", to: "2026-11-30" });
      expect(neither).toEqual([]);

      const everything = await readHolidays(s);
      expect(everything.map((day) => day.onDate)).toEqual([
        INDEPENDENCE_DAY,
        CHRISTMAS,
        BOXING_DAY,
      ]);
    });
  });

  it("opens the office again when a holiday is removed", async () => {
    await withOrganization(ds, A, async (s) => {
      const added = await addHoliday(s, { onDate: "2026-06-12", name: "Democracy Day" });
      expect(added).not.toBeNull();
      expect(await removeHoliday(s, added?.id ?? "")).toBe(true);
      expect((await readHolidays(s)).map((day) => day.onDate)).not.toContain("2026-06-12");
      // Gone means gone; a second removal is not a second thing to remove.
      expect(await removeHoliday(s, added?.id ?? "")).toBe(false);
    });
  });

  it("keeps one organisation's closures out of another's", async () => {
    const mine = await withOrganization(ds, A, async (s) => {
      const all = await readHolidays(s);
      return all[0]?.id ?? "";
    });

    await withOrganization(ds, B, async (s) => {
      // Not "you may not see it" — under RLS there is nothing there to see.
      expect(await readHolidays(s)).toEqual([]);
      expect(await readHolidays(s, { from: INDEPENDENCE_DAY, to: INDEPENDENCE_DAY })).toEqual([]);

      /* And the delete must match nothing rather than report success for a row it never
         touched — the `[rows, affectedCount]` trap, which is why this goes through
         `scope.mutate`. A `true` here would be RLS holding and the code above it lying. */
      expect(await removeHoliday(s, mine)).toBe(false);

      // B may keep the same date for itself; the uniqueness is per organisation.
      const its = await addHoliday(s, { onDate: INDEPENDENCE_DAY, name: "Independence Day" });
      expect(its).not.toBeNull();
      expect((await readHolidays(s)).map((day) => day.onDate)).toEqual([INDEPENDENCE_DAY]);
    });

    // A's list is untouched by anything B did.
    await withOrganization(ds, A, async (s) => {
      expect((await readHolidays(s)).map((day) => day.onDate)).toEqual([
        INDEPENDENCE_DAY,
        CHRISTMAS,
        BOXING_DAY,
      ]);
    });
  });
});
