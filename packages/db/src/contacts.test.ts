import { asOrganizationId } from "@ansa/shared";
import type { DataSource } from "typeorm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { recordCaptures } from "./call-captures";
import { readContact, readContacts, renameContact, setContactValue } from "./contacts";
import { createDataSource } from "./data-source";
import { withOrganization } from "./organization-scope";
import { loadDotEnv } from "./test-env";

loadDotEnv();

const url = process.env["DIRECT_URL"];

/**
 * A caller, assembled from more than one call.
 *
 * Against the real database rather than a fake, for the reason the other files here give:
 * the two things that can go wrong are both outside the arithmetic. That three calls from
 * one number become one person is a fact about a unique constraint and an upsert. That one
 * organisation cannot see another's enquirers is a fact about RLS, and a fake scope would
 * agree with whatever the query did.
 *
 * Its own id range. `call-captures.test.ts` documents why, having taken a range another
 * file already owned and deleted its organisations mid-run: in use elsewhere are
 * `11111111`/`22222222`, `33333333`/`44444444`, `55555555`/`66666666`, `77777777`/`88888888`,
 * `99999999`, `e1e1e1e1`/`e2e2e2e2`, and the `c*`/`d*` ranges in the API suite.
 */
const A = asOrganizationId("a7a7a7a7-a7a7-4a7a-8a7a-a7a7a7a7a7a7");
const B = asOrganizationId("b7b7b7b7-b7b7-4b7b-8b7b-b7b7b7b7b7b7");

const CALLER = "+2348138178550";

let ds: DataSource;

/** One call from `caller`, returning its row id. */
const placeCall = async (
  organization: typeof A,
  carrierId: string,
  caller: string | null,
): Promise<string> => {
  let id = "";
  await withOrganization(ds, organization, async (s) => {
    await s.query("insert into organizations (id, name) values ($1, $2) on conflict do nothing", [
      organization,
      `Organization ${organization.slice(0, 4)}`,
    ]);
    const rows = await s.query<{ id: string }>(
      `insert into calls (organization_id, carrier_call_id, dialled, caller)
       values ($1, $2, '+18148592625', $3)
       on conflict (organization_id, carrier_call_id) do update set caller = excluded.caller
       returning id`,
      [organization, carrierId, caller],
    );
    id = String(rows[0]?.id);
  });
  return id;
};

const contactsOf = async (organization: typeof A) =>
  withOrganization(ds, organization, (s) => readContacts(s));

describe.skipIf(url === undefined)("the person behind the calls", () => {
  beforeAll(async () => {
    ds = await createDataSource({ url: url ?? "", poolSize: 2 }).initialize();
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

  it("folds three calls from one number into one person", async () => {
    const first = await placeCall(A, "contacts-1", CALLER);
    const second = await placeCall(A, "contacts-2", CALLER);
    const third = await placeCall(A, "contacts-3", CALLER);

    await recordCaptures(ds, A, first, [
      { fieldKey: "callerName", fieldType: "name", value: "Sikiru", attempts: 1 },
    ]);
    await recordCaptures(ds, A, second, [
      { fieldKey: "budget", fieldType: "amount", value: "4500000", attempts: 1 },
    ]);
    await recordCaptures(ds, A, third, [
      { fieldKey: "area", fieldType: "text", value: "Lekki Phase One", attempts: 2 },
    ]);

    const [person, ...others] = await contactsOf(A);

    // One record, not three. This is the whole point of the table.
    expect(others).toHaveLength(0);
    expect(person?.phone).toBe(CALLER);
    expect(person?.callCount).toBe(3);

    // And it carries what was learned across all three, not just the last.
    const values = Object.fromEntries((person?.values ?? []).map((v) => [v.fieldKey, v.value]));
    expect(values).toEqual({
      callerName: "Sikiru",
      budget: "4500000",
      area: "Lekki Phase One",
    });
  });

  it("takes the later answer when the caller corrects one", async () => {
    const later = await placeCall(A, "contacts-4", CALLER);
    await recordCaptures(ds, A, later, [
      { fieldKey: "budget", fieldType: "amount", value: "6000000", attempts: 1 },
    ]);

    const [person] = await contactsOf(A);
    const budget = person?.values.find((v) => v.fieldKey === "budget");
    expect(budget?.value).toBe("6000000");
    // Traceable to the call that changed it, or the correction is an unsourced assertion.
    expect(budget?.sourceCallId).toBe(later);
  });

  it("files nothing under a withheld number", async () => {
    const anonymous = await placeCall(A, "contacts-anon", null);
    await recordCaptures(ds, A, anonymous, [
      { fieldKey: "callerName", fieldType: "name", value: "Nobody", attempts: 1 },
    ]);

    // The capture still exists on its call; there is simply no person to file it under, and
    // a row per anonymous call would be a list of strangers who are all the same stranger.
    const people = await contactsOf(A);
    expect(people).toHaveLength(1);
    expect(people[0]?.values.some((v) => v.value === "Nobody")).toBe(false);
  });

  it("keeps an operator's correction when the next call says the short name again", async () => {
    const [before] = await contactsOf(A);
    const renamed = await withOrganization(ds, A, (s) =>
      renameContact(s, String(before?.id), "Sikiru Adeyemi"),
    );
    expect(renamed).toBe(true);

    const again = await placeCall(A, "contacts-5", CALLER);
    await recordCaptures(ds, A, again, [
      { fieldKey: "callerName", fieldType: "name", value: "Sikiru", attempts: 1 },
    ]);

    const [after] = await contactsOf(A);
    // The correction survives, and the captured name is still there underneath it.
    expect(after?.displayName).toBe("Sikiru Adeyemi");
    expect(after?.values.find((v) => v.fieldKey === "callerName")?.value).toBe("Sikiru");
  });

  it("records a hand-entered value as having come from no call", async () => {
    const [person] = await contactsOf(A);
    await withOrganization(ds, A, (s) =>
      setContactValue(s, String(person?.id), {
        fieldKey: "note",
        fieldType: "text",
        value: "Wants a viewing on Saturday",
      }),
    );

    const fresh = await withOrganization(ds, A, (s) => readContact(s, String(person?.id)));
    const note = fresh?.values.find((v) => v.fieldKey === "note");
    expect(note?.value).toBe("Wants a viewing on Saturday");
    // Null provenance is the honest record: nobody said this on a call.
    expect(note?.sourceCallId).toBeNull();
  });

  it("finds a person by something they said, not just by their number", async () => {
    const found = await withOrganization(ds, A, (s) => readContacts(s, { search: "Lekki" }));
    expect(found).toHaveLength(1);
    expect(found[0]?.phone).toBe(CALLER);
  });

  it("never shows one organisation another's enquirers", async () => {
    const theirs = await placeCall(B, "contacts-b1", CALLER);
    await recordCaptures(ds, B, theirs, [
      { fieldKey: "callerName", fieldType: "name", value: "Someone else", attempts: 1 },
    ]);

    // The same number, and still two separate people — a contact belongs to an organisation
    // before it belongs to a number.
    const ours = await contactsOf(A);
    const theirsList = await contactsOf(B);

    expect(ours).toHaveLength(1);
    expect(theirsList).toHaveLength(1);
    expect(ours[0]?.id).not.toBe(theirsList[0]?.id);
    expect(ours[0]?.values.some((v) => v.value === "Someone else")).toBe(false);
    expect(theirsList[0]?.displayName).toBeNull();

    // And B cannot reach A's record by asking for it directly.
    const reached = await withOrganization(ds, B, (s) => readContact(s, String(ours[0]?.id)));
    expect(reached).toBeNull();
  });
});
