// Records that a number consented to be called by a tenant, or suppresses it.
//
// Deliberately separate from placing calls. Consent is evidence, and evidence that can be
// created in the same breath as the call it authorises is not evidence.
//
//   TENANT_ID=... node tools/outbound/grant-consent.mjs +234... "verbal, recorded 2026-08-08"
//   TENANT_ID=... node tools/outbound/grant-consent.mjs --suppress +234... "asked not to be called"
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";

const root = new URL("../../", import.meta.url).pathname;
const require = createRequire(`${root}packages/db/package.json`);
const { Client } = require("pg");

const env = Object.fromEntries(
  readFileSync(`${root}.env`, "utf8")
    .split("\n")
    .filter((l) => l.trim() && !l.startsWith("#"))
    .map((l) => [l.slice(0, l.indexOf("=")), l.slice(l.indexOf("=") + 1)]),
);

const args = process.argv.slice(2);
const suppress = args[0] === "--suppress";
const [number, basis] = suppress ? args.slice(1) : args;
const tenantId = process.env.TENANT_ID;

if (!tenantId) throw new Error("TENANT_ID is required");
if (!number?.startsWith("+")) throw new Error("Pass the number in E.164");
if (!basis) throw new Error("Pass the basis — an unexplained consent record is not evidence");

const client = new Client({ connectionString: env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
await client.connect();
// Written inside the tenant's own scope, so RLS applies to the write as it does to reads.
await client.query("begin");
await client.query("select set_config('app.tenant_id', $1, true)", [tenantId]);

if (suppress) {
  await client.query(
    `insert into do_not_call (tenant_id, phone_number, reason) values ($1, $2, $3)
     on conflict do nothing`,
    [tenantId, number, basis],
  );
  console.log(`suppressed ${number} for tenant ${tenantId}`);
} else {
  await client.query(
    `insert into outbound_consent (tenant_id, phone_number, basis) values ($1, $2, $3)`,
    [tenantId, number, basis],
  );
  console.log(`consent recorded for ${number}`);
}

await client.query("commit");
await client.end();
