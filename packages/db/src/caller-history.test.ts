import { asOrganizationId } from "@ansa/shared";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { recordCallEventByCarrierId } from "./call-log";
import { loadConsentFacts, recordDoNotCall } from "./call-config";
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
      // Nothing to have been about, because there was no previous call.
      lastCallAbout: null,
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

describe("somebody asking never to be called again", () => {
  const NUMBER = "+2348000000077";

  it("writes a suppression the application role cannot write directly", async () => {
    /* The write policy on `do_not_call` is `organization_id = app.current_organization()`,
       so `ansa_app` cannot insert the global row this needs — which is why migration 0044
       added a SECURITY DEFINER function and why this test connects as the app role. */
    await recordDoNotCall(db, ORGANIZATION, NUMBER, "take me off your list");

    const facts = await loadConsentFacts(db, ORGANIZATION, NUMBER);
    expect(facts.suppressed).toBe(true);
  });

  it("suppresses the number for every other organisation too", async () => {
    /* The point of the whole thing. Somebody who says "stop calling me" is not saying it to
       whichever organisation happened to dial them, and a per-organisation record would
       leave every other one free to ring them tomorrow. */
    await recordDoNotCall(db, ORGANIZATION, NUMBER, "take me off your list");

    const theirs = await loadConsentFacts(db, OTHER, NUMBER);
    expect(theirs.suppressed).toBe(true);
  });

  it("can be recorded twice without failing", async () => {
    /* Said three times in one sentence, or again on tomorrow's call. A path whose whole job
       is to fail safe must not raise on the second attempt. */
    await recordDoNotCall(db, ORGANIZATION, NUMBER, "first time");
    await expect(recordDoNotCall(db, ORGANIZATION, NUMBER, "second time")).resolves.toBeUndefined();
  });

  it("cannot be taken back by the application", async () => {
    /* "Permanently, no expiry" is the requirement, and it is enforced by the grant rather
       than by anybody remembering: `ansa_app` holds SELECT and INSERT on this table and
       nothing else. Found by writing an `afterAll` that tried to tidy these rows away and
       watching it fail — which is the behaviour, not the bug. It does mean the rows below
       outlive the suite, so the numbers are ones nothing else uses. */
    await recordDoNotCall(db, ORGANIZATION, NUMBER, "take me off your list");

    await expect(
      withOrganization(db, ORGANIZATION, (scope) =>
        scope.query("delete from do_not_call where phone_number = $1", [NUMBER]),
      ),
    ).rejects.toThrow(/permission denied/i);
    expect((await loadConsentFacts(db, ORGANIZATION, NUMBER)).suppressed).toBe(true);
  });

  it("leaves other numbers alone", async () => {
    await recordDoNotCall(db, ORGANIZATION, NUMBER, "take me off your list");
    expect((await loadConsentFacts(db, ORGANIZATION, "+2348000000088")).suppressed).toBe(false);
  });
});

describe("recording what answered, from a webhook that knows only a carrier id", () => {
  /**
   * The answering-machine verdict arrives on its own request, so the per-socket recorder
   * is out of scope and no organisation has been set. `app.record_call_event_by_carrier_id`
   * resolves both from the call row — which is the safety argument as much as the
   * convenience: a webhook that could name an organisation could name somebody else's.
   */
  it("writes the event against the right call and the right organisation", async () => {
    expect(await recordCallEventByCarrierId(db, "CA-hist-1", "answered_by", {
      answeredBy: "machine_end_beep",
    })).toBe(true);

    const rows = await withOrganization(db, ORGANIZATION, (scope) =>
      scope.query<{ kind: string; organization_id: string }>(
        "select kind, organization_id from call_events where call_id = $1 and kind = 'answered_by'",
        [CALL_YESTERDAY],
      ),
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]?.organization_id).toBe(ORGANIZATION);
  });

  it("is invisible to another organisation", async () => {
    // The function bypasses RLS to write. What it writes must not bypass RLS to be read.
    await recordCallEventByCarrierId(db, "CA-hist-1", "answered_by", { answeredBy: "human" });

    const theirs = await withOrganization(db, OTHER, (scope) =>
      scope.query("select 1 from call_events where kind = 'answered_by'"),
    );
    expect(theirs).toHaveLength(0);
  });

  it("says so rather than raising for a call it has never heard of", async () => {
    /* A webhook for a call placed by a previous deploy is ordinary. Raising would make the
       carrier retry something that will never succeed. */
    expect(await recordCallEventByCarrierId(db, "CA-never-existed", "answered_by", {})).toBe(false);
  });
});
