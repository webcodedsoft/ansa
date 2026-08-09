// Development seed: registers one tenant against the number the carrier actually calls.
//
// Not a migration. Migrations describe the schema every environment shares; this is one
// row that only makes sense on a developer's line, and the number comes from the
// environment rather than the repository.
//
//   SEED_DIALLED_NUMBER=+1... node packages/db/seeds/dev-tenant.mjs
import { createRequire } from "node:module";

const require = createRequire(new URL("../package.json", import.meta.url));
const { Client } = require("pg");

const dialled = process.env.SEED_DIALLED_NUMBER;
if (dialled === undefined) throw new Error("SEED_DIALLED_NUMBER must be set");

const url = process.env.MIGRATION_DIRECT_URL ?? process.env.MIGRATION_URL;
if (url === undefined) throw new Error("MIGRATION_DIRECT_URL or MIGRATION_URL must be set");

const client = new Client({ connectionString: url, ssl: { rejectUnauthorized: false } });
await client.connect();

// Terms on top of the base list in apps/api/src/tenancy/defaults.ts, not instead of it.
//
// Place and person names were here - Ikeja, Yaba, Lekki, Adebayo, Chukwu, Olabisi - and
// they were actively harmful. On a live call the caller said their own name and the
// transcript came back "Hi. My name is Ikeja." Boosting is a bias, not a hint: it makes
// the listed token WIN ties against everything unlisted, so a name the tenant never
// hears beats the name the caller actually said.
//
// The rule this bought: boost vocabulary that is closed and repeated, never vocabulary
// that competes with what callers say freely. Products, coverage types and the company
// name qualify. Personal names never do, because the caller's name is unknown by
// definition and is exactly what a boosted name will swallow.
const keyterms = [
  "Kano General",
  "third party",
  "comprehensive",
  "motor cover",
  "fire and special perils",
  "no claims discount",
  "certificate",
];

// Persona and instructions are layered ON the base prompt, never in place of it. What a
// tenant is allowed to say here is bounded and filtered on the way into the prompt — see
// apps/api/src/prompts/tenant-layer.ts. Writing "skip the readback" in either field would
// not skip the readback; the field would be dropped and the call logged as an error.
const persona = "Warm and direct. Nigerian English. Never rush the caller off the line.";
const instructions = [
  "Office hours are 8am to 5pm WAT, Monday to Friday.",
  "Out of hours, take a callback number and say someone will ring in the morning.",
  "If you're not sure, say so and offer to have a person call back.",
].join("\n");

// The row first, then the config through the versioned path.
//
// The bump used to be `config_version + 1` on this insert, which incremented a number and
// stored nothing behind it: every call recorded a version that could no longer be looked
// up the moment the seed ran again. `app.publish_tenant_config` bumps and snapshots in
// one transaction, which is what makes `calls.config_version` mean something (R7.5).
// One transaction, because `set_config(..., true)` below is transaction-local and is a
// no-op outside one — the publish would then fail on its own tenant-scope check, which is
// a confusing way to find out you forgot a BEGIN.
await client.query("begin");
const { rows: created } = await client.query(
  `insert into tenants (name, dialled_number) values ($1, $2)
   on conflict (dialled_number) where dialled_number is not null
     do update set name = excluded.name
     returning id`,
  ["Kano General Insurance", dialled],
);
const tenantId = created[0].id;

// Publishing runs under the tenant's own scope, exactly as the application would.
await client.query("select set_config('app.tenant_id', $1, true)", [tenantId]);
//
// The argument list grows with every migration that adds a configurable field, and this
// call silently rotted twice before anyone noticed: 0012, 0013, 0014 and 0015 each dropped
// and recreated the function with a wider signature, and an old call site fails with
// "function does not exist" rather than with anything that names the missing field. Keep
// it in step, in the same commit as the migration.
const { rows } = await client.query(
  `select app.publish_tenant_config(
     $1, $2, null, null, $3, $4, $5,
     null, null, null,   -- business hours: the seed leaves them unset on purpose
     null, null,         -- tools, event receivers
     null, null, null,   -- escalation: falls back to the platform number
     $6) as version`,
  [
    tenantId,
    "Kano General Insurance",
    persona,
    instructions,
    keyterms,
    "development seed",
  ],
);

await client.query("commit");

console.log(
  "seeded:",
  JSON.stringify({ id: tenantId, version: rows[0].version, keyterms: keyterms.length }),
);
await client.end();
