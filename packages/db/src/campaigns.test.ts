import { asOrganizationId } from "@ansa/shared";
import type { DataSource } from "typeorm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  claimScheduledCall,
  createCampaign,
  enqueueScheduledCalls,
  readCampaign,
  readCampaigns,
  readDueScheduledCalls,
  readScheduledCalls,
  recordAttempt,
  recordContactImport,
  setCampaignStatus,
} from "./campaigns";
import { addContacts, readContacts } from "./contacts";
import { createDataSource } from "./data-source";
import { withOrganization } from "./organization-scope";
import { loadDotEnv } from "./test-env";

loadDotEnv();

const url = process.env["DIRECT_URL"];

/**
 * A list of people to ring (0061).
 *
 * Against the real database, for the reason `contacts.test.ts` gives: what matters here is
 * a unique key, an upsert and a policy, and a fake would agree with whatever the query did.
 * That an imported number which has already rung us stays one person is
 * `contacts_organization_id_phone_key`; that one person is rung once per campaign is
 * `scheduled_calls_campaign_id_contact_id_key`; that one organisation cannot put another's
 * contacts on its list is RLS. Each is asserted by trying.
 *
 * Its own id range — `a8a8…`/`b8b8…` — per `test-organization-ids.test.ts`.
 */
const A = asOrganizationId("a8a8a8a8-a8a8-4a8a-8a8a-a8a8a8a8a8a8");
const B = asOrganizationId("b8b8b8b8-b8b8-4b8b-8b8b-b8b8b8b8b8b8");

const PAGE = { limit: 50, offset: 0 };

let ds: DataSource;
let agentA = "";
let agentB = "";

const seed = async (organization: typeof A): Promise<string> => {
  let agent = "";
  await withOrganization(ds, organization, async (s) => {
    await s.query("insert into organizations (id, name) values ($1, $2) on conflict do nothing", [
      organization,
      `Organization ${organization.slice(0, 4)}`,
    ]);
    const rows = await s.query<{ id: string }>(
      `insert into agents (organization_id, name) values ($1, 'Dialler') returning id`,
      [organization],
    );
    agent = String(rows[0]?.id);
  });
  return agent;
};

describe.skipIf(url === undefined)("a list of people to ring", () => {
  beforeAll(async () => {
    ds = await createDataSource({ url: url ?? "", poolSize: 2 }).initialize();
    agentA = await seed(A);
    agentB = await seed(B);
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

  it("imports a list without splitting a caller into two people", async () => {
    await withOrganization(ds, A, async (s) => {
      // Somebody who rang us first, with a name the office already corrected.
      await s.query(
        `insert into contacts (organization_id, phone, display_name) values ($1, $2, $3)`,
        [A, "+2348000000001", "Sikiru Adeyemi"],
      );

      const batch = await recordContactImport(s, { sourceLabel: "CSV", rowCount: 3, createdBy: null });
      const added = await addContacts(
        s,
        [
          { phone: "+2348000000001", displayName: "Sikiru" },
          { phone: "+2348000000002", displayName: "Amaka" },
          // The same line twice, which a spreadsheet does.
          { phone: "+2348000000002", displayName: "Amaka" },
        ],
        "import",
        batch.id,
      );

      expect(added).toHaveLength(2);
      expect(added.find((c) => c.phone === "+2348000000001")?.created).toBe(false);
      expect(added.find((c) => c.phone === "+2348000000002")?.created).toBe(true);

      const people = (await readContacts(s, PAGE)).items;
      expect(people).toHaveLength(2);
      const existing = people.find((p) => p.phone === "+2348000000001");
      // The correction outranks the spreadsheet, and the origin is still the call.
      expect(existing?.displayName).toBe("Sikiru Adeyemi");
      expect(existing?.source).toBe("call");
      expect(existing?.importId).toBeNull();
      const fresh = people.find((p) => p.phone === "+2348000000002");
      expect(fresh?.source).toBe("import");
      expect(fresh?.importId).toBe(batch.id);
    });
  });

  it("puts each person on a campaign once, and drains only a running one", async () => {
    await withOrganization(ds, A, async (s) => {
      const campaign = await createCampaign(s, { agentId: agentA, name: "Renewals", createdBy: null });
      const ids = (await readContacts(s, PAGE)).items.map((p) => p.id);
      const due = new Date(Date.now() - 1_000);

      expect(await enqueueScheduledCalls(s, campaign.id, ids, due)).toBe(2);
      // Enqueueing the same list again is a no-op, not a second ring.
      expect(await enqueueScheduledCalls(s, campaign.id, ids, due)).toBe(0);
      expect((await readCampaign(s, campaign.id))?.pending).toBe(2);

      // A draft dials nobody.
      expect(await readDueScheduledCalls(s, new Date(), 10)).toEqual([]);

      await setCampaignStatus(s, campaign.id, "running");
      const queue = await readDueScheduledCalls(s, new Date(), 10);
      expect(queue).toHaveLength(2);
      expect(queue.map((q) => q.phone).sort()).toEqual(["+2348000000001", "+2348000000002"]);

      // Two schedulers race for one row; one wins.
      const first = queue[0];
      if (first === undefined) throw new Error("queue was empty");
      expect(await claimScheduledCall(s, first.id)).toBe(true);
      expect(await claimScheduledCall(s, first.id)).toBe(false);

      // No answer, try again in an hour: back to pending with the attempt counted.
      // Whole seconds: the driver hands a timestamptz back without its milliseconds.
      const later = new Date(Math.floor(Date.now() / 1000) * 1000 + 3_600_000);
      await recordAttempt(s, first.id, { status: "no_answer", outcome: "rang out", nextAttemptAt: later });
      const rows = (await readScheduledCalls(s, campaign.id, PAGE)).items;
      const retried = rows.find((r) => r.id === first.id);
      expect(retried?.status).toBe("pending");
      expect(retried?.attempts).toBe(1);
      expect(retried?.outcome).toBe("rang out");
      expect(retried?.nextAttemptAt?.getTime()).toBe(later.getTime());
      // And not due until then.
      expect((await readDueScheduledCalls(s, new Date(), 10)).map((q) => q.id)).not.toContain(first.id);

      // The gate said no: terminal, and the reason is written down.
      const second = queue[1];
      if (second === undefined) throw new Error("queue had one row");
      await claimScheduledCall(s, second.id);
      await recordAttempt(s, second.id, { status: "suppressed", outcome: "number is on the do-not-call list" });
      const suppressed = (await readScheduledCalls(s, campaign.id, PAGE)).items.find((r) => r.id === second.id);
      expect(suppressed?.status).toBe("suppressed");
      expect(suppressed?.nextAttemptAt).toBeNull();
    });
  });

  it("keeps one organisation's list out of another's reach", async () => {
    const contactsOfA = await withOrganization(ds, A, async (s) =>
      (await readContacts(s, PAGE)).items.map((p) => p.id),
    );
    expect(contactsOfA.length).toBeGreaterThan(0);

    await withOrganization(ds, B, async (s) => {
      expect((await readCampaigns(s, PAGE)).items).toEqual([]);

      // B's own campaign, A's contact ids: RLS hides the contacts and nothing is enqueued.
      const campaign = await createCampaign(s, { agentId: agentB, name: "Poaching", createdBy: null });
      expect(await enqueueScheduledCalls(s, campaign.id, contactsOfA, new Date())).toBe(0);
      expect((await readScheduledCalls(s, campaign.id, PAGE)).items).toEqual([]);
    });
  });
});
