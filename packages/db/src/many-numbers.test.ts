import { asOrganizationId } from "@ansa/shared";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { claimNumberWithToken } from "./call-config";
import { createDataSource, type Db } from "./data-source";
import { withOrganization } from "./organization-scope";
import { listHeldNumbers, setClaimToken } from "./organizations";
import { loadDotEnv } from "./test-env";

loadDotEnv();

/**
 * An organisation holds as many numbers as it owns.
 *
 * The schema has always allowed it — `organization_numbers` is keyed on the number itself, so a
 * row per number was the shape from 0019 — but nothing asserted it, and two places had quietly
 * assumed otherwise: `GET /numbers` answered with one agent's `dialled_number`, and the console
 * wrapper carried a note saying "at most one today". Both are fixed, and this is the test that
 * would have failed while they were not.
 *
 * The interesting part is the second and third number rather than the first. One number works
 * under any implementation, including the wrong ones.
 */

const appUrl = process.env["DATABASE_URL"];
const ownerUrl = process.env["MIGRATION_DIRECT_URL"];
if (appUrl === undefined) {
  throw new Error("DATABASE_URL must be set: this test needs a database");
}

/** Unique to this file — see the note in `caller-history.test.ts` on why that matters. */
const ORGANIZATION = asOrganizationId("c7c7c7c7-c7c7-4c7c-8c7c-c7c7c7c7c7c7");
const TOKEN = "c7".repeat(32);
const NUMBERS = ["+2349550000001", "+2349550000002", "+2349550000003"] as const;

let app: Db;
let owner: Db | null = null;

describe.skipIf(ownerUrl === undefined)("an organisation with several numbers", () => {
  beforeAll(async () => {
    app = await createDataSource({ url: appUrl, poolSize: 2 }).initialize();
    owner = await createDataSource({ url: ownerUrl ?? "", poolSize: 2 }).initialize();
    await owner.query("insert into organizations (id, name) values ($1, $2)", [
      ORGANIZATION,
      "Many Numbers",
    ]);
    await withOrganization(app, ORGANIZATION, (scope) => setClaimToken(scope, TOKEN));
  }, 60_000);

  afterAll(async () => {
    await owner?.query("delete from agents where organization_id = $1", [ORGANIZATION]);
    for (const number of NUMBERS) {
      await owner?.query("delete from organization_numbers where number = $1", [number]);
    }
    await owner?.query("delete from organizations where id = $1", [ORGANIZATION]);
    await app?.destroy();
    await owner?.destroy();
  });

  it("proves three numbers with one token", async () => {
    /* One URL, as many numbers as you own — which is what the console now tells people to do.
       The token is the organisation's, not the number's, so proving the second costs nothing
       more than pointing another carrier setting at the same place. */
    for (const number of NUMBERS) {
      expect(await claimNumberWithToken(app, TOKEN, number)).toBe(ORGANIZATION);
    }

    const held = await withOrganization(app, ORGANIZATION, (scope) => listHeldNumbers(scope));
    expect(held.map((entry) => entry.number).sort()).toEqual([...NUMBERS].sort());
  });

  it("reports each number's own agent, and null for the one nobody answers", async () => {
    /* The state that used to be invisible: a number attached at the carrier that no agent
       answers appeared nowhere at all, because the old query read an agent's number rather than
       the organisation's. It is the state onboarding spends most of its time in. */
    await owner?.query(
      `insert into agents (organization_id, name, dialled_number)
       values ($1, 'First line', $2), ($1, 'Second line', $3)`,
      [ORGANIZATION, NUMBERS[0], NUMBERS[1]],
    );

    const held = await withOrganization(app, ORGANIZATION, (scope) => listHeldNumbers(scope));
    const byNumber = new Map(held.map((entry) => [entry.number, entry.agentName]));

    expect(byNumber.get(NUMBERS[0])).toBe("First line");
    expect(byNumber.get(NUMBERS[1])).toBe("Second line");
    // Held, routed to nobody, and visible. Rings nowhere until somebody gives it an agent.
    expect(byNumber.get(NUMBERS[2])).toBeNull();
  });
});
