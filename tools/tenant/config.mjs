// Publishing a tenant's configuration, and reading an old version back.
//
// The first ten tenants are onboarded by hand (PRD §11, Phase 1), so this is the
// onboarding path rather than a stepping stone to a UI that is explicitly not being
// built. It exists for two reasons the seed script cannot cover:
//
//   1. `config_version` is bumped and snapshotted in one transaction, so the version
//      recorded on a call always has a row behind it (R7.5). The old seed bumped the
//      number and stored nothing, which made the version an identifier for a thing that
//      no longer existed.
//   2. `show <version>` answers "why did the agent say that three weeks ago?" without
//      anyone having to trust that the config has not changed since.
//
//   TENANT_ID=... node tools/tenant/config.mjs show
//   TENANT_ID=... node tools/tenant/config.mjs show 3
//   TENANT_ID=... node tools/tenant/config.mjs publish config.json "added motor terms"
//
// The JSON is the tenant's whole configuration, not a patch — publishing a version that
// silently inherited half its values from the last one would make the history unreadable:
//
//   { "name": "...", "voiceId": null, "greeting": null,
//     "persona": "...", "instructions": "...", "keyterms": ["..."],
//     "businessHours": { "opensAtHour": 9, "closesAtHour": 17, "openDays": [1,2,3,4,5] } }
//
// `businessHours` is in WAT and its days are ISO weekdays, 1 for Monday. Omit it and the
// agent says it does not know the opening hours, which is the honest answer and is what
// every tenant gets until somebody publishes some. The database refuses two thirds of a
// window and refuses one that wraps past midnight, so a typo fails here rather than
// telling a caller to ring back tomorrow.
//
// A note about validation, because its absence here is deliberate rather than forgotten.
// Persona and instructions are filtered by apps/api/src/prompts/tenant-layer.ts on the
// way INTO the prompt, on every config load — not on the way into the table. That is what
// makes a row written by this script, by a future admin UI, or by hand in psql all get
// the same treatment. Publishing something that weakens a guarantee will not weaken it;
// it will be dropped and logged as an error on the first call that loads it.
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

const [command, ...args] = process.argv.slice(2);
const tenantId = process.env.TENANT_ID;
if (!tenantId) throw new Error("TENANT_ID is required");
if (command !== "show" && command !== "publish") {
  throw new Error("usage: config.mjs show [version] | config.mjs publish <file.json> <note>");
}

const client = new Client({
  connectionString: env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});
await client.connect();

// Everything runs inside the tenant's own scope, as the application does. Connecting as a
// role that could see every tenant would make this script prove nothing about whether the
// grants are right.
await client.query("begin");
await client.query("select set_config('app.tenant_id', $1, true)", [tenantId]);

if (command === "show") {
  const version = args[0];
  const { rows } =
    version === undefined
      ? await client.query(
          `select name, voice_id, greeting, persona, instructions, keyterms,
                  business_open_hour, business_close_hour, business_days, config_version
             from tenants where id = $1`,
          [tenantId],
        )
      : await client.query("select * from app.tenant_config_at_version($1, $2)", [
          tenantId,
          Number(version),
        ]);

  if (rows.length === 0) throw new Error(`no such tenant or version: ${tenantId} ${version ?? ""}`);
  console.log(JSON.stringify(rows[0], null, 2));

  const { rows: history } = await client.query(
    `select version, note, published_by, published_at
       from tenant_prompt_versions where tenant_id = $1 order by version desc limit 20`,
    [tenantId],
  );
  console.log("\nversions:");
  for (const h of history) {
    console.log(`  ${String(h.version).padStart(3)}  ${h.published_at.toISOString()}  ${h.published_by}  ${h.note ?? ""}`);
  }
} else {
  const [file, note] = args;
  if (!file) throw new Error("pass the path to a JSON config");
  if (!note) throw new Error("pass a note — a version with no reason explains nothing later");

  const config = JSON.parse(readFileSync(file, "utf8"));
  // Absent and explicitly null mean the same thing: this tenant has not told us their
  // hours. The three columns travel together because two thirds of a window cannot be
  // reasoned about, and the CHECK constraint in 0012 says so too.
  const hours = config.businessHours ?? {};
  const { rows } = await client.query(
    "select app.publish_tenant_config($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11) as version",
    [
      tenantId,
      config.name ?? null,
      config.voiceId ?? null,
      config.greeting ?? null,
      config.persona ?? null,
      config.instructions ?? null,
      config.keyterms ?? [],
      hours.opensAtHour ?? null,
      hours.closesAtHour ?? null,
      hours.openDays ?? null,
      note,
    ],
  );
  console.log(`published version ${rows[0].version} for ${tenantId}`);
}

await client.query("commit");
await client.end();
