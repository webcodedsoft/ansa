import { asOrganizationId } from "@ansa/shared";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { readCallerHistory } from "./call-records";
import { createDataSource, type Db } from "./data-source";
import { withOrganization } from "./organization-scope";
import { loadDotEnv } from "./test-env";

loadDotEnv();

/**
 * "Have I spoken to this person before?", against the real schema.
 *
 * Against the database rather than a fake, for the reason `review.test.ts` gives: the two
 * things that can go wrong here are both outside the arithmetic. That the current call is
 * excluded from its own history is a fact about a `where` clause — get it wrong and every
 * caller is told they rang once already. That one organisation's call log is invisible to
 * another is a fact about RLS, and a fake scope would agree with whatever the query did.
 *
 * Connects as the application role, not the owner. The policy is the point.
 */

const url = process.env["DATABASE_URL"];
if (url === undefined) {
  throw new Error("DATABASE_URL must be set: this test needs a database");
}

/**
 * Unique to this file, and that is not decoration.
 *
 * The first version reused `5555…`/`6666…`, which `organization-scope.test.ts` already
 * owns. Vitest runs files in parallel against one database, so the calls seeded here
 * appeared inside that suite's organisations and broke its concurrency assertion — a
 * failure in a file this change never touched, several minutes away from the cause.
 */
const ORGANIZATION = asOrganizationId("d0d0d0d0-d0d0-4d0d-8d0d-d0d0d0d0d0d0");
const OTHER = asOrganizationId("d1d1d1d1-d1d1-4d1d-8d1d-d1d1d1d1d1d1");
/** The number every assertion below is about. */
const CALLER = "+2348000000055";
const NOW = new Date("2026-08-20T12:00:00.000Z");
const DAY_MS = 24 * 60 * 60 * 1000;

const CALL_TODAY = "e1111111-1111-4111-8111-111111111111";
const CALL_YESTERDAY = "e2222222-2222-4222-8222-222222222222";
const CALL_LAST_WEEK = "e3333333-3333-4333-8333-333333333333";
const CALL_LAST_MONTH = "e7777777-7777-4777-8777-777777777777";
const CALL_LAST_YEAR = "e4444444-4444-4444-8444-444444444444";
const CALL_OTHER_ORG = "e5555555-5555-4555-8555-555555555555";
const CALL_OTHER_NUMBER = "e6666666-6666-4666-8666-666666666666";

let db: Db;

const daysAgo = (days: number): string => new Date(NOW.getTime() - days * DAY_MS).toISOString();

const seedCall = async (
  organization: typeof ORGANIZATION,
  id: string,
  carrierCallId: string,
  caller: string,
  createdAt: string,
): Promise<void> => {
  await withOrganization(db, organization, async (scope) => {
    await scope.query(
      `insert into calls (id, organization_id, carrier_call_id, dialled, caller, created_at)
       values ($1, $2, $3, '+10000000055', $4, $5)
         on conflict (id) do update set created_at = excluded.created_at`,
      [id, organization, carrierCallId, caller, createdAt],
    );
  });
};

beforeAll(async () => {
  db = await createDataSource({ url, poolSize: 2 }).initialize();

  for (const [organization, name] of [
    [ORGANIZATION, "History Test"],
    [OTHER, "History Test Other"],
  ] as const) {
    await withOrganization(db, organization, async (scope) => {
      await scope.query(
        `insert into organizations (id, name) values ($1, $2) on conflict (id) do nothing`,
        [organization, name],
      );
    });
  }

  // The call in progress: it is already on disk by the time this read runs.
  await seedCall(ORGANIZATION, CALL_TODAY, "CA-hist-now", CALLER, NOW.toISOString());
  await seedCall(ORGANIZATION, CALL_YESTERDAY, "CA-hist-1", CALLER, daysAgo(1));
  await seedCall(ORGANIZATION, CALL_LAST_WEEK, "CA-hist-6", CALLER, daysAgo(6));
  /* Inside the ninety-day window and outside the seven-day one. Without this row the two
     windows cannot be told apart: dropping the week filter entirely still returned two,
     which is what the mutation run caught. */
  await seedCall(ORGANIZATION, CALL_LAST_MONTH, "CA-hist-30", CALLER, daysAgo(30));
  // Outside the ninety-day window.
  await seedCall(ORGANIZATION, CALL_LAST_YEAR, "CA-hist-old", CALLER, daysAgo(300));
  // The same number, a different organisation. Must be invisible.
  await seedCall(OTHER, CALL_OTHER_ORG, "CA-hist-other-org", CALLER, daysAgo(2));
  // The same organisation, a different number.
  await seedCall(ORGANIZATION, CALL_OTHER_NUMBER, "CA-hist-other-num", "+2348000000099", daysAgo(2));

  // Their most recent previous call ended with a person taking over.
  await withOrganization(db, ORGANIZATION, async (scope) => {
    await scope.query(
      `insert into call_events (organization_id, call_id, kind, detail)
       values ($1, $2, 'escalated to a human', '{"text":"let me get a colleague"}'::jsonb)`,
      [ORGANIZATION, CALL_YESTERDAY],
    );
  });
});

afterAll(async () => {
  for (const organization of [ORGANIZATION, OTHER]) {
    await withOrganization(db, organization, async (scope) => {
      await scope.query("delete from calls where organization_id = $1", [organization]);
      await scope.query("delete from organizations where id = $1", [organization]);
    });
  }
  await db.destroy();
});

const read = async (caller = CALLER, carrierCallId = "CA-hist-now") =>
  withOrganization(db, ORGANIZATION, (scope) =>
    readCallerHistory(scope, { caller, carrierCallId, now: NOW }),
  );

describe("what this number has done before", () => {
  it("does not count the call that is happening right now", async () => {
    /* `recordCallStarted` fires at ingress and this fires beside it, so the current call is
       already a row. Without the exclusion every caller is told they rang once already
       today, and the one they rang is this one. */
    const history = await read();
    expect(history.lastContactDaysAgo).toBe(1);
  });

  it("counts only the last seven days as this week", async () => {
    /* Yesterday and six days ago are in. Thirty days ago is inside the read's own window
       and outside this one, which is the pair that makes the filter observable. */
    expect((await read()).contactsThisWeek).toBe(2);
  });

  it("reports a handover on their last call", async () => {
    expect((await read()).lastCallHandedOver).toBe(true);
  });

  it("treats a number we have not heard from as new", async () => {
    const history = await read("+2349999999999", "CA-hist-unknown");
    expect(history).toEqual({
      lastContactDaysAgo: null,
      contactsThisWeek: 0,
      lastCallHandedOver: false,
    });
  });

  it("cannot see the same number's calls to another organisation", async () => {
    /* The same person rings two businesses that both use Ansa. Neither may learn anything
       about the other's call — and the row seeded two days ago would surface as the most
       recent contact if RLS were not doing its job, which is what makes this assertion
       sharp rather than decorative. */
    const history = await read();
    expect(history.lastContactDaysAgo).toBe(1);
    expect(history.contactsThisWeek).toBe(2);
  });
});
