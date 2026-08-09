// Creating a tenant and giving it a number. The operator's half of onboarding.
//
// Separate from config.mjs, and the split is the point rather than tidiness.
//
// `config.mjs` runs as `ansa_app` inside one tenant's own scope, because everything it
// writes is that tenant's to decide. **This is not that.** `tenants.dialled_number` is the
// ingress routing table: it is what turns a call on a wire into a tenant id, and a tenant
// who could write it could claim a number nobody assigned them and answer calls meant for
// somebody else. It is not in `app.publish_tenant_config` for that reason and it is not
// reachable from the onboarding path, so it lives here, as the owner, deliberately.
//
// Honest note about what that does and does not buy. `ansa_app` still holds INSERT on
// `tenants` and the RLS policy passes for any row whose `id` equals the scope you set, so
// a process holding DATABASE_URL could create a tenant and claim a free number today. No
// code path does, and the adversarial RLS suite needs the grant to create its own fixtures.
// Column-level grants would close it and are worth doing before anyone but us holds those
// credentials; until then this script is the boundary being observed rather than enforced,
// and saying so is better than a comment claiming otherwise.
//
//   MIGRATION_DIRECT_URL=... node tools/tenant/provision.mjs "<name>" <+E164>
//
// Idempotent on the number: running it twice renames rather than creating a second tenant
// that would race the first for the same calls. It publishes nothing — the new tenant has
// no persona, no greeting, no voice and no keyterms until `config.mjs publish` gives it
// some, which is the honest starting state and the one an onboarding runbook should
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

const { rows } = await client.query(
  `insert into tenants (name, dialled_number) values ($1, $2)
   on conflict (dialled_number) where dialled_number is not null
     do update set name = excluded.name
     returning id, name, dialled_number, config_version`,
  [name, dialled],
);

const tenant = rows[0];
console.log(JSON.stringify(tenant, null, 2));
console.log(
  `\nnext: TENANT_ID=${tenant.id} node tools/tenant/config.mjs publish <file.json> "<why>"`,
);
console.log(`      and point the carrier's voice webhook for ${dialled} at /telephony/voice`);

await client.end();
