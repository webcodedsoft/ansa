import { asOrganizationId } from "@ansa/shared";
import type { DataSource } from "typeorm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { readCallCaptures, readCapturedRows, recordCaptures } from "./call-captures";
import { createDataSource } from "./data-source";
import { withOrganization } from "./organization-scope";
import { loadDotEnv } from "./test-env";

loadDotEnv();

const url = process.env["DIRECT_URL"];

/**
 * This table holds a caller's name, their phone number and, by policy, their BVN.
 *
 * It is the most identifying thing the product stores outside the audio, so the isolation
 * assertion is not a formality: an organisation reading another's collected data is the
 * failure R7.2 exists to prevent, and it has to be proved rather than assumed from the
 * policy being present.
 *
 * Its own id range, for the reason `organization-scope.test.ts` records: these files share
 * one database, and a shared range makes another file's rows look like a leak. This file
 * first took `77777777`/`88888888`, which `organization-config.test.ts` already owns — so
 * its `afterAll` deleted that file's organisations mid-run and broke three of its tests.
 * In use elsewhere: `11111111`/`22222222`, `33333333`/`44444444`, `55555555`/`66666666`,
 * `77777777`/`88888888`, `99999999`, and the `c*`/`d*` ranges in the API suite.
 */
const A = asOrganizationId("e1e1e1e1-e1e1-4e1e-8e1e-e1e1e1e1e1e1");
const B = asOrganizationId("e2e2e2e2-e2e2-4e2e-8e2e-e2e2e2e2e2e2");

let ds: DataSource;
const callOf = new Map<string, string>();

const seed = async (organization: typeof A, sid: string): Promise<void> => {
  await withOrganization(ds, organization, async (s) => {
    await s.query("insert into organizations (id, name) values ($1, $2) on conflict do nothing", [
      organization,
      `Organization ${sid}`,
    ]);
    const rows = await s.query<{ id: string }>(
      `insert into calls (organization_id, carrier_call_id, dialled) values ($1, $2, '+1')
       on conflict (organization_id, carrier_call_id) do update set dialled = excluded.dialled
       returning id`,
      [organization, sid],
    );
    callOf.set(sid, String(rows[0]?.id));
  });
};

describe.skipIf(url === undefined)("collected values", () => {
  beforeAll(async () => {
    ds = await createDataSource({ url: url ?? "", poolSize: 2 }).initialize();
    await seed(A, "captures-a");
    await seed(B, "captures-b");
  }, 60_000);

  afterAll(async () => {
    for (const organization of [A, B]) {
      await withOrganization(ds, organization, (s) =>
        s.query("delete from organizations where id = $1", [organization]),
      );
    }
    await ds?.destroy();
  });

  it("keeps one organisation's collected data away from another", async () => {
    const aCall = callOf.get("captures-a") ?? "";
    const bCall = callOf.get("captures-b") ?? "";

    await withOrganization(ds, A, (s) =>
      recordCaptures(ds, A, aCall, [
        { fieldKey: "callerName", fieldType: "name", value: "Sikiru", attempts: 1 },
      ]).then(() => s.query("select 1")),
    );
    await withOrganization(ds, B, (s) =>
      recordCaptures(ds, B, bCall, [
        { fieldKey: "callerName", fieldType: "name", value: "Adaeze", attempts: 1 },
      ]).then(() => s.query("select 1")),
    );

    const asA = await withOrganization(ds, A, (s) => readCapturedRows(s));
    const asB = await withOrganization(ds, B, (s) => readCapturedRows(s));

    expect(asA.map((r) => r.value)).toContain("Sikiru");
    expect(asA.map((r) => r.value)).not.toContain("Adaeze");
    expect(asB.map((r) => r.value)).toContain("Adaeze");
    expect(asB.map((r) => r.value)).not.toContain("Sikiru");
  });

  it("returns nothing for another organisation's call id", async () => {
    /* Asking by id directly, which is the shape a guessed or leaked identifier takes. RLS
       answers with no rows rather than an error, so "not yours" and "not there" look the
       same from outside — which is what the API's 404 depends on. */
    const bCall = callOf.get("captures-b") ?? "";
    const asA = await withOrganization(ds, A, (s) => readCallCaptures(s, bCall));
    expect(asA).toEqual([]);
  });

  it("replaces a value the caller corrects rather than keeping both", async () => {
    const aCall = callOf.get("captures-a") ?? "";
    await withOrganization(ds, A, (s) =>
      recordCaptures(ds, A, aCall, [
        { fieldKey: "phone", fieldType: "number", value: "08138178550", attempts: 1 },
      ]).then(() => s.query("select 1")),
    );
    await withOrganization(ds, A, (s) =>
      recordCaptures(ds, A, aCall, [
        { fieldKey: "phone", fieldType: "number", value: "08031234567", attempts: 2 },
      ]).then(() => s.query("select 1")),
    );

    const values = await withOrganization(ds, A, (s) => readCallCaptures(s, aCall));
    const phone = values.filter((v) => v.fieldKey === "phone");
    expect(phone).toHaveLength(1);
    expect(phone[0]?.value).toBe("08031234567");
    expect(phone[0]?.attempts).toBe(2);
  });
});
