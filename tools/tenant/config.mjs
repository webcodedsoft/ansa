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
//   TENANT_ID=... node tools/tenant/config.mjs credential partner_api bearer <token>
//   TENANT_ID=... node tools/tenant/config.mjs credential partner_api header X-Key <value>
//   TENANT_ID=... node tools/tenant/config.mjs credential partner_api basic <user> <password>
//   TENANT_ID=... node tools/tenant/config.mjs credential crm_hook signing <shared-secret>
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
// `escalation` is where a transfer goes when the agent gives up (R6.5, migration 0015).
// Both numbers or neither, both E.164, and the origination must be a number the carrier
// account owns. Omit it and escalation falls back to the platform's own HANDOFF_TO_NUMBER,
// which is right for a single-tenant deployment and is somebody else's staff phone the
// moment there are two — so publish one.
//
//   { "escalation": { "toNumber": "+234...", "fromNumber": "+234...", "ringSeconds": 25 } }
//
// `tools` is the tenant's own tool configuration (Slice 6, R5.2) and travels with the
// version, because it changes what the agent can do. Its shape is validated by
// packages/tools/src/connector/config.ts on the way into the registry, on every config
// load, for the same reason persona and instructions are — see the note below.
//
//   { "tools": { "egress": { "allowedHosts": ["api.example.com"] },
//                "http": [ { "name": "order_status", "description": "...",
//                            "parameters": { "type": "object", ... },
//                            "riskTier": "read",
//                            "url": "https://api.example.com/orders",
//                            "method": "GET", "send": "query",
//                            "credentialRef": "partner_api",
//                            "speech": { "template": "Order {id} is {state}.",
//                                        "fallback": "I can't find that order." } } ] } }
//
// `events` is where the organisation asks for its own data to be pushed back to it
// (Slice 6a). It travels with the version for the same reason `tools` does, and for one
// more: the version records which redaction rules were in force when a payload left.
//
//   { "events": { "egress": { "allowedHosts": ["hooks.example.com"] },
//                 "subscriptions": [ { "name": "crm",
//                                      "url": "https://hooks.example.com/ansa",
//                                      "events": ["call.ended", "call.transferred"],
//                                      "signingSecretRef": "crm_hook" } ] } }
//
// **Nothing is redacted unless you ask for it.** The payload is a record of a conversation
// your own agent had, with your own customer, and it goes complete by default. Add a
// `redaction` block — at the top of `events` for every receiver, or inside one subscription
// for that receiver alone — to mask free text. What each category catches and, more
// importantly, what none of them can catch, is in docs/EVENT_WEBHOOKS.md. Read that before
// switching it on, because the limits are the part that matters.
//
//   { "events": { "redaction": { "categories": ["captured-identifier", "card-number"] } } }
//
// The credential itself never goes in that file. `credential` seals it with
// TOOL_CREDENTIAL_KEY and writes ciphertext; the plaintext is never stored and is not
// recoverable from here — rotate rather than recover.
//
// A note about validation, because its absence here is deliberate rather than forgotten.
// Persona and instructions are filtered by apps/api/src/prompts/tenant-layer.ts on the
// way INTO the prompt, on every config load — not on the way into the table. That is what
// makes a row written by this script, by a future admin UI, or by hand in psql all get
// the same treatment. Publishing something that weakens a guarantee will not weaken it;
// it will be dropped and logged as an error on the first call that loads it.
import { createRequire } from "node:module";
import { createCipheriv, randomBytes } from "node:crypto";
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
if (command !== "show" && command !== "publish" && command !== "credential") {
  throw new Error(
    "usage: config.mjs show [version] | publish <file.json> <note> | credential <ref> <scheme> <value...>",
  );
}

// The same envelope packages/tools/src/connector/vault.ts opens: AES-256-GCM, with the
// tenant id and the reference name as additional authenticated data so the ciphertext
// cannot be moved to another tenant's row and still decrypt. Duplicated here rather than
// imported because this is a .mjs script and @ansa/tools is TypeScript; the format is four
// dot-separated fields and the version prefix is what makes changing it detectable.
const seal = (keyBase64, tenant, ref, material) => {
  const key = Buffer.from(keyBase64, "base64");
  if (key.length !== 32) throw new Error("TOOL_CREDENTIAL_KEY must be 32 bytes, base64 (openssl rand -base64 32)");
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv, { authTagLength: 16 });
  cipher.setAAD(Buffer.from(`${tenant}:${ref}`, "utf8"));
  const sealed = Buffer.concat([cipher.update(JSON.stringify(material), "utf8"), cipher.final()]);
  return ["v1", iv.toString("base64"), cipher.getAuthTag().toString("base64"), sealed.toString("base64")].join(".");
};

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
          `select name, dialled_number, voice_id, greeting, persona, instructions, keyterms,
                  business_open_hour, business_close_hour, business_days, tool_config,
                  event_config, escalation_to_number, escalation_from_number,
                  escalation_ring_seconds, config_version
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
  const { rows: credentials } = await client.query(
    "select ref, updated_at from tenant_credentials where tenant_id = $1 order by ref",
    [tenantId],
  );
  // Names and dates only. The sealed values are not printed: they are ciphertext, but a
  // terminal is a worse place for them than a database and there is no reason to look.
  console.log("\ncredentials:");
  for (const c of credentials) console.log(`  ${c.ref}  ${c.updated_at.toISOString()}`);

  console.log("\nversions:");
  for (const h of history) {
    console.log(`  ${String(h.version).padStart(3)}  ${h.published_at.toISOString()}  ${h.published_by}  ${h.note ?? ""}`);
  }
} else if (command === "credential") {
  const [ref, scheme, ...rest] = args;
  if (!ref || !scheme) {
    throw new Error("usage: credential <ref> <bearer|header|basic|signing> <value...>");
  }

  const material =
    scheme === "bearer"
      ? { kind: "bearer", token: rest[0] }
      : scheme === "header"
        ? { kind: "header", header: rest[0], value: rest[1] }
        : scheme === "basic"
          ? { kind: "basic", username: rest[0], password: rest[1] }
          : // What a webhook receiver verifies our signature with. Its own scheme, and the
            // vault refuses to use it as an auth credential or to sign with an auth one:
            // the receiver holds this value, and it must never turn out to be the token
            // that opens the tenant's own API.
            scheme === "signing"
            ? { kind: "signing", secret: rest[0] }
            : null;
  if (material === null) throw new Error(`unknown scheme: ${scheme}`);
  if (Object.values(material).some((v) => v === undefined || v === "")) {
    throw new Error(`the ${scheme} scheme needs all of its values`);
  }
  if (material.kind === "signing" && material.secret.length < 16) {
    // The same floor the vault enforces. A four-character "secret" is a signature anybody
    // can forge, and it is cheaper to refuse it here than to explain it afterwards.
    throw new Error("a signing secret must be at least 16 characters");
  }

  const keyBase64 = env.TOOL_CREDENTIAL_KEY;
  if (!keyBase64) throw new Error("TOOL_CREDENTIAL_KEY is not set in .env — the API needs the same value");

  // Upsert: rotating a credential is the common case, and a second row under the same
  // name would be a silent ambiguity about which one the agent is using.
  await client.query(
    `insert into tenant_credentials (tenant_id, ref, sealed)
          values ($1, $2, $3)
     on conflict (tenant_id, ref)
       do update set sealed = excluded.sealed, updated_at = now()`,
    [tenantId, ref, seal(keyBase64, tenantId, ref, material)],
  );
  // The plaintext is deliberately not echoed, so it does not end up in a shell history
  // file twice.
  console.log(`sealed ${scheme} credential ${ref} for ${tenantId}`);
} else {
  const [file, note] = args;
  if (!file) throw new Error("pass the path to a JSON config");
  if (!note) throw new Error("pass a note — a version with no reason explains nothing later");

  const config = JSON.parse(readFileSync(file, "utf8"));
  // Absent and explicitly null mean the same thing: this tenant has not told us their
  // hours. The three columns travel together because two thirds of a window cannot be
  // reasoned about, and the CHECK constraint in 0012 says so too.
  const hours = config.businessHours ?? {};
  // Same rule as the hours: both numbers travel together or neither does, because a
  // destination with no origination cannot be dialled and the CHECK constraint in 0015
  // says so too. A typo therefore fails here rather than at the carrier, one second after
  // a caller has been told they are being put through.
  const escalation = config.escalation ?? {};
  const { rows } = await client.query(
    "select app.publish_tenant_config($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16) as version",
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
      // Whole config, never a patch: omitting `tools` publishes a version with no tenant
      // tools, which is the same rule voice_id and greeting already follow. It is not a
      // way to leave the last one in place.
      config.tools == null ? null : JSON.stringify(config.tools),
      // Same rule again: omitting `events` publishes a version that delivers nothing.
      config.events == null ? null : JSON.stringify(config.events),
      escalation.toNumber ?? null,
      escalation.fromNumber ?? null,
      escalation.ringSeconds ?? null,
      note,
    ],
  );
  console.log(`published version ${rows[0].version} for ${tenantId}`);
}

await client.query("commit");
await client.end();
