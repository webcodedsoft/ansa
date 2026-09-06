import { asOrganizationId } from "@ansa/shared";
import type { DataSource } from "typeorm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  claimScheduledCall,
  createCampaign,
  enqueueScheduledCalls,
  readCampaign,
  readScheduledCalls,
  recordAttempt,
  updateCampaignBrief,
} from "./campaigns";
import { addContacts, readContacts } from "./contacts";
import { createDataSource } from "./data-source";
import { withOrganization } from "./organization-scope";
import {
  createDueRuns,
  createSeries,
  readSeries,
  readSeriesForCampaign,
  readSeriesRuns,
  updateSeries,
} from "./series";
import { loadDotEnv } from "./test-env";

loadDotEnv();

const url = process.env["DIRECT_URL"];

/**
 * A campaign that runs again on its own (0074).
 *
 * Against the real database, because everything that matters here is in SQL: that the
 * sweeper's function creates a run once and not twice, copies the list and leaves out the
 * suppressed, sets the run's window from the rhythm, and that resuming a paused series lands
 * on the next beat rather than firing every missed one. A fake would agree with whatever
 * the function did.
 *
 * Its own id range — `d8d8…` — per `test-organization-ids.test.ts`.
 */
const ORG = asOrganizationId("d8d8d8d8-d8d8-4d8d-8d8d-d8d8d8d8d8d8");
const PAGE = { limit: 50, offset: 0 };

let ds: DataSource;
let agentId = "";

describe.skipIf(url === undefined)("a campaign that runs again", () => {
  beforeAll(async () => {
    ds = await createDataSource({ url: url ?? "", poolSize: 2 }).initialize();
    await withOrganization(ds, ORG, async (s) => {
      await s.query("insert into organizations (id, name) values ($1, 'Series Org') on conflict do nothing", [ORG]);
      const rows = await s.query<{ id: string }>(
        `insert into agents (organization_id, name) values ($1, 'Dialler') returning id`,
        [ORG],
      );
      agentId = String(rows[0]?.id);
      await addContacts(
        s,
        [
          { phone: "+2348000000101", displayName: "Amaka" },
          { phone: "+2348000000102", displayName: "Bola" },
          { phone: "+2348000000103", displayName: "Chidi" },
        ],
        "import",
        null,
      );
    });
  }, 60_000);

  afterAll(async () => {
    if (ds === undefined) return;
    await withOrganization(ds, ORG, async (s) => {
      await s.query("delete from organizations where id = $1", [ORG]);
    });
    await ds.destroy();
  });

  it("creates a due run once, with the template's list minus the suppressed", async () => {
    let templateId = "";
    let seriesId = "";
    const anchor = new Date(Date.now() - 60_000); // a minute ago: due on the first sweep

    await withOrganization(ds, ORG, async (s) => {
      const template = await createCampaign(s, { agentId, name: "Rent", createdBy: null });
      templateId = template.id;
      await updateCampaignBrief(s, template.id, {
        purpose: "about this month's rent",
        outcomes: ["already paid", "will pay"],
        maxAttempts: 2,
      });
      const ids = (await readContacts(s, PAGE)).items.map((c) => c.id);
      await enqueueScheduledCalls(s, template.id, ids, new Date());

      const series = await createSeries(s, {
        templateId: template.id,
        name: "Rent",
        every: "month",
        runFor: "week",
        anchorAt: anchor,
        createdBy: null,
      });
      if (series === null) throw new Error("no series");
      seriesId = series.id;
      expect(series.state).toBe("active");
      expect(series.every).toBe("month");
      expect(series.runFor).toBe("week");
      expect(series.nextRunAt.getTime()).toBe(Math.floor(anchor.getTime() / 1000) * 1000);

      // Found from either end.
      expect((await readSeriesForCampaign(s, template.id))?.id).toBe(series.id);
    });

    // A second series on the same template is refused: two rhythms would ring people twice.
    // Its own scope, because a refused insert aborts the transaction it runs in.
    await expect(
      withOrganization(ds, ORG, (s) =>
        createSeries(s, { templateId, name: "Rent again", every: "week", runFor: "day", anchorAt: anchor, createdBy: null }),
      ),
    ).rejects.toThrow();

    // The sweeper's tick, unscoped. Once.
    const made = await createDueRuns(ds);
    const mine = made.filter((run) => run.seriesId === seriesId);
    expect(mine).toHaveLength(1);
    expect(mine[0]?.runNumber).toBe(1);
    expect(mine[0]?.organizationId).toBe(ORG);

    // And not again: the next beat is a month away.
    expect((await createDueRuns(ds)).filter((run) => run.seriesId === seriesId)).toHaveLength(0);

    await withOrganization(ds, ORG, async (s) => {
      const runId = mine[0]?.campaignId ?? "";
      const run = await readCampaign(s, runId);
      // An ordinary campaign, scheduled to start at the beat and stop a week later.
      expect(run?.status).toBe("scheduled");
      expect(run?.seriesId).toBe(seriesId);
      expect(run?.runNumber).toBe(1);
      expect(run?.purpose).toBe("about this month's rent");
      expect(run?.outcomes).toEqual(["already paid", "will pay"]);
      expect(run?.maxAttempts).toBe(2);
      expect(run?.startsAt?.getTime()).toBe(Math.floor(anchor.getTime() / 1000) * 1000);
      expect((run?.endsAt?.getTime() ?? 0) - (run?.startsAt?.getTime() ?? 0)).toBe(7 * 86_400_000);
      // The list came across — the one thing Duplicate refuses to do.
      expect(run?.total).toBe(3);

      const runs = await readSeriesRuns(s, seriesId);
      expect(runs.map((r) => r.runNumber)).toEqual([1]);

      // Now somebody on run 1 refuses. The next run must not carry them.
      const rows = (await readScheduledCalls(s, runId, PAGE)).items;
      const refused = rows[0];
      if (refused === undefined) throw new Error("run has no rows");
      await claimScheduledCall(s, refused.id);
      await recordAttempt(s, refused.id, { status: "suppressed", outcome: "asked not to be called" });

      // Bring the next beat forward so the sweep finds it.
      await s.query("update campaign_series set next_run_at = now() - interval '1 minute' where id = $1", [seriesId]);
    });

    const second = (await createDueRuns(ds)).filter((run) => run.seriesId === seriesId);
    expect(second).toHaveLength(1);
    expect(second[0]?.runNumber).toBe(2);
    await withOrganization(ds, ORG, async (s) => {
      const run = await readCampaign(s, second[0]?.campaignId ?? "");
      expect(run?.total).toBe(2);
      const series = await readSeriesForCampaign(s, templateId);
      expect(series?.runsCreated).toBe(2);
    });
  });

  it("pauses without losing its place, and resumes on the next beat rather than every missed one", async () => {
    let seriesId = "";
    const anchor = new Date(Date.now() - 100 * 86_400_000); // a hundred days ago, weekly
    await withOrganization(ds, ORG, async (s) => {
      const template = await createCampaign(s, { agentId, name: "Weekly", createdBy: null });
      await updateCampaignBrief(s, template.id, { purpose: "to check in" });
      const series = await createSeries(s, {
        templateId: template.id,
        name: "Weekly",
        every: "week",
        runFor: "day",
        anchorAt: anchor,
        createdBy: null,
      });
      if (series === null) throw new Error("no series");
      seriesId = series.id;
      expect(await updateSeries(s, series.id, { state: "paused" })).toBe(true);
      expect((await readSeriesForCampaign(s, template.id))?.state).toBe("paused");
    });

    // Paused: the sweep makes nothing, however overdue.
    expect((await createDueRuns(ds)).filter((run) => run.seriesId === seriesId)).toHaveLength(0);

    await withOrganization(ds, ORG, async (s) => {
      expect(await updateSeries(s, seriesId, { state: "active" })).toBe(true);
      const resumed = await readSeries(s, seriesId);
      // Not the fourteen missed beats: the first one still ahead of us.
      expect(resumed?.state).toBe("active");
      expect(resumed?.nextRunAt.getTime()).toBeGreaterThan(Date.now());
      expect((resumed?.nextRunAt.getTime() ?? 0) - Date.now()).toBeLessThanOrEqual(7 * 86_400_000);
    });
    expect((await createDueRuns(ds)).filter((run) => run.seriesId === seriesId)).toHaveLength(0);

    await withOrganization(ds, ORG, async (s) => {
      expect(await updateSeries(s, seriesId, { state: "ended" })).toBe(true);
      expect((await readSeries(s, seriesId))?.state).toBe("ended");
      // Ended is final.
      expect(await updateSeries(s, seriesId, { state: "active" })).toBe(false);
    });
  });
});
