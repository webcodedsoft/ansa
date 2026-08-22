// Creating a organization and giving it a number. The operator's half of onboarding.
//
// Separate from config.mjs, and the split is the point rather than tidiness.
//
// `config.mjs` runs as `ansa_app` inside one organization's own scope, because everything it
// writes is that organization's to decide. **This is not that.** `organization_numbers` is the
// ownership table, and an organisation that could write it could claim a line somebody else
// controls at their own carrier. `ansa_app` holds SELECT on it and nothing else, so this runs
// as the owner, deliberately.
//
// It is no longer the only way in. Migration 0054 lets an organisation prove it holds a number
// by pointing that number's voice webhook at a URL carrying its own secret and calling it once
// — the arriving call is the proof, because only a number's holder can say where it sends its
// calls. This script stays for the numbers that predate that, for a number an operator is
// handing over on somebody's behalf, and for creating the organisation in the first place.
//
// **This script was broken and had been for some time.** It wrote `organizations.dialled_number`
// and read `organizations.config_version`, both dropped by migration 0026 when the organisation
// stopped being the agent. Postgres answered "column does not exist" and the whole of onboarding
// by hand failed at its first step. Nothing caught it because nothing runs it in CI, which is
// the standing cost of a hand-run tool.
//
// Honest note about what that does and does not buy. `ansa_app` still holds INSERT on
// `organizations` and the RLS policy passes for any row whose `id` equals the scope you set, so
// a process holding DATABASE_URL could create a organization and claim a free number today. No
// code path does, and the adversarial RLS suite needs the grant to create its own fixtures.
// Column-level grants would close it and are worth doing before anyone but us holds those
// credentials; until then this script is the boundary being observed rather than enforced,
// and saying so is better than a comment claiming otherwise.
//
//   MIGRATION_DIRECT_URL=... node tools/organization/provision.mjs "<name>" <+E164>
//
// Idempotent on the number: running it twice reports who holds it and changes nothing. It used
// to rename the holder instead, which is a surprising amount of damage for a typo in argv.
//
// It publishes nothing, and it routes nothing. The new organisation has no persona, no
// greeting, no voice and no keyterms until `config.mjs publish` gives it some, and the number
// rings nobody until an agent is created and routed to it — which is now done from the agent's
// own page. That is the honest starting state and the one an onboarding runbook should
// describe.
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";

const root = new URL("../../", import.meta.url).pathname;
const require = createRequire(`${root}packages/db/package.json`);
const { Client } = require("pg");

const fromEnvFile = () => {
  try {
    return Object.fromEntries(
      readFileSync(`${root}.env`, "utf8")
        .split("\n")
        .filter((l) => l.trim() && !l.startsWith("#"))
        .map((l) => [l.slice(0, l.indexOf("=")), l.slice(l.indexOf("=") + 1)]),
    );
  } catch {
    return {};
  }
};

const env = { ...fromEnvFile(), ...process.env };

const [name, dialled] = process.argv.slice(2);
if (!name || !dialled) {
  throw new Error('usage: provision.mjs "<organisation name>" <+E164 number>');
}
// The same shape the carrier will send back on the webhook. A number stored with a space
// or a leading zero never matches at ingress, and the way that fails is that every call to
// it answers as an unregistered number on base vocabulary — which looks like a config bug
// anywhere but here.
if (!/^\+[1-9]\d{6,14}$/.test(dialled)) {
  throw new Error(`${dialled} is not E.164 — it must look like +2348030000000`);
}

const url = env.MIGRATION_DIRECT_URL ?? env.MIGRATION_URL;
if (!url) throw new Error("MIGRATION_DIRECT_URL must be set: this runs as the owner");

const client = new Client({ connectionString: url, ssl: { rejectUnauthorized: false } });
await client.connect();

/* Two statements, because they are two facts now: the organisation exists, and it holds a
   number. They used to be one column on one row, which is what made "rename on conflict" a
   sensible idempotency rule and what makes it a wrong one today — a second number for the same
   organisation is an ordinary thing to want, not a collision. */
await client.query("begin");

let organization;
try {
  const held = await client.query(
    "select organization_id from organization_numbers where number = $1",
    [dialled],
  );
  const holder = held.rows[0]?.organization_id ?? null;

  if (holder === null) {
    const created = await client.query(
      "insert into organizations (name) values ($1) returning id, name",
      [name],
    );
    organization = created.rows[0];
    await client.query(
      "insert into organization_numbers (organization_id, number, note) values ($1, $2, $3)",
      [organization.id, dialled, `assigned by an operator to ${name}`],
    );
  } else {
    /* Idempotent on the number, as it always was, but by refusing to move it rather than by
       renaming whoever holds it. Re-running with a different name used to rename the holding
       organisation, which is a surprising amount of damage for a typo in argv. */
    const existing = await client.query("select id, name from organizations where id = $1", [
      holder,
    ]);
    organization = existing.rows[0];
    console.log(`${dialled} is already held by ${organization.name} (${organization.id}).`);
    console.log("Nothing was changed. Numbers move between organisations by hand, on purpose.");
  }

  await client.query("commit");
} catch (error) {
  await client.query("rollback");
  throw error;
}

console.log(JSON.stringify({ ...organization, number: dialled }, null, 2));
console.log(
  `\nnext: ORGANIZATION_ID=${organization.id} node tools/organization/config.mjs publish <file.json> "<why>"`,
);
console.log(`      create an agent and route ${dialled} to it, or the number rings nobody`);
console.log(`      and point the carrier's voice webhook for ${dialled} at /telephony/voice`);

await client.end();
