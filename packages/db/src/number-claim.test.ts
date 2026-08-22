import { asOrganizationId } from "@ansa/shared";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { claimNumberWithToken } from "./call-config";
import { createDataSource, type Db } from "./data-source";
import { withOrganization } from "./organization-scope";
import { setClaimToken } from "./organizations";
import { loadDotEnv } from "./test-env";

loadDotEnv();

/**
 * Proving you hold a number, and failing to prove you hold somebody else's.
 *
 * `app.claim_number_with_token` is the single hole through the boundary migration 0019
 * established: `ansa_app` has SELECT on `organization_numbers` and nothing else, because an
 * organisation that could insert a row could claim a line somebody else controls at their own
 * carrier. This function can insert, so what it refuses matters more than what it allows.
 *
 * Against a real database as the application role. The function is SECURITY DEFINER precisely
 * so it works on the unscoped connection ingress uses, and running these as the owner would
 * prove nothing about the grant.
 */

const appUrl = process.env["DATABASE_URL"];
const ownerUrl = process.env["MIGRATION_DIRECT_URL"];
if (appUrl === undefined) {
  throw new Error("DATABASE_URL must be set: this test needs a database");
}

/** Unique to this file — see the note in `caller-history.test.ts` on why that matters. */
const MINE = asOrganizationId("c4c4c4c4-c4c4-4c4c-8c4c-c4c4c4c4c4c4");
const THEIRS = asOrganizationId("c5c5c5c5-c5c5-4c5c-8c5c-c5c5c5c5c5c5");

const MY_TOKEN = "c4".repeat(32);
const THEIR_TOKEN = "c5".repeat(32);

const FREE_NUMBER = "+2349770000001";
const TAKEN_NUMBER = "+2349770000002";

let app: Db;
let owner: Db | null = null;

const heldBy = async (number: string): Promise<string | null> => {
  const rows = (await owner?.query(
    "select organization_id from organization_numbers where number = $1",
    [number],
  )) as { organization_id: string }[];
  return rows[0]?.organization_id ?? null;
};

describe.skipIf(ownerUrl === undefined)("proving control of a number", () => {
  beforeAll(async () => {
    app = await createDataSource({ url: appUrl, poolSize: 2 }).initialize();
    owner = await createDataSource({ url: ownerUrl ?? "", poolSize: 2 }).initialize();

    for (const [organization, name] of [
      [MINE, "Claim Mine"],
      [THEIRS, "Claim Theirs"],
    ] as const) {
      await owner.query("insert into organizations (id, name) values ($1, $2)", [
        organization,
        name,
      ]);
    }

    // Through the application role, because rotating a token is something an organisation does.
    await withOrganization(app, MINE, (scope) => setClaimToken(scope, MY_TOKEN));
    await withOrganization(app, THEIRS, (scope) => setClaimToken(scope, THEIR_TOKEN));

    // A number the other organisation has already proved.
    await owner.query(
      "insert into organization_numbers (organization_id, number, note) values ($1, $2, 'seeded')",
      [THEIRS, TAKEN_NUMBER],
    );
  }, 60_000);

  afterAll(async () => {
    for (const number of [FREE_NUMBER, TAKEN_NUMBER, "+2349770000008", "+2349770000009"]) {
      await owner?.query("delete from organization_numbers where number = $1", [number]);
    }
    for (const organization of [MINE, THEIRS]) {
      await owner?.query("delete from organizations where id = $1", [organization]);
    }
    await app?.destroy();
    await owner?.destroy();
  });

  it("attaches a number nobody holds to the organisation whose token arrived with it", async () => {
    const proved = await claimNumberWithToken(app, MY_TOKEN, FREE_NUMBER);
    expect(proved).toBe(MINE);
    expect(await heldBy(FREE_NUMBER)).toBe(MINE);
  });

  it("says the same thing again on the second call", async () => {
    /* Every call to a claimed number arrives on the same webhook, so this runs on all of them.
       It has to be a no-op rather than a duplicate or an error. */
    await claimNumberWithToken(app, MY_TOKEN, FREE_NUMBER);
    const again = await claimNumberWithToken(app, MY_TOKEN, FREE_NUMBER);
    expect(again).toBe(MINE);
    expect(await heldBy(FREE_NUMBER)).toBe(MINE);
  });

  it("refuses a number another organisation already proved, and does not move it", async () => {
    /* The one that matters. Whoever is calling has genuinely proved they can route this number
       to us today — and that still does not entitle them to take it off the organisation that
       proved it first. A silent transfer is indistinguishable from a hijack. */
    const stolen = await claimNumberWithToken(app, MY_TOKEN, TAKEN_NUMBER);
    expect(stolen).toBeNull();
    expect(await heldBy(TAKEN_NUMBER)).toBe(THEIRS);
  });

  it("attaches nothing for a token nobody holds", async () => {
    const guessed = await claimNumberWithToken(app, "ff".repeat(32), "+2349770000009");
    expect(guessed).toBeNull();
    expect(await heldBy("+2349770000009")).toBeNull();
  });

  it("stops working for a closed organisation", async () => {
    /* An account that has been closed should not still be collecting numbers, and a token
       outliving its organisation is exactly the case nobody would think to revoke by hand. */
    await owner?.query("update organizations set deleted_at = now() where id = $1", [MINE]);
    try {
      const proved = await claimNumberWithToken(app, MY_TOKEN, "+2349770000008");
      expect(proved).toBeNull();
      expect(await heldBy("+2349770000008")).toBeNull();
    } finally {
      await owner?.query("update organizations set deleted_at = null where id = $1", [MINE]);
    }
  });

  it("still refuses the application role a direct insert", async () => {
    /* The boundary this function is the only hole in. If this ever passes, the hole stopped
       being narrow and the guard above stopped being the guard. */
    await expect(
      withOrganization(app, MINE, (scope) =>
        scope.query("insert into organization_numbers (organization_id, number) values ($1, $2)", [
          MINE,
          "+2349770000007",
        ]),
      ),
    ).rejects.toThrow(/permission denied/i);
  });
});
