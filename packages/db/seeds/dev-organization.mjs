// Development seed: one organisation, one agent, on the number the carrier actually calls.
//
// Not a migration. Migrations describe the schema every environment shares; this is a
// handful of rows that only make sense on a developer's line, and the number comes from
// the environment rather than the repository.
//
//   SEED_DIALLED_NUMBER=+1... node packages/db/seeds/dev-organization.mjs
//
// It rotted once and the failure was quiet in the worst way: it wrote
// `organizations.dialled_number`, a column migration 0026 dropped when the organisation
// stopped being the agent. Nothing in the monorepo imports this file, so the first symptom
// was a developer with a working tunnel, a working carrier and no way to make a call reach
// anything. If you widen the schema, come back here in the same commit.
import { createRequire } from "node:module";

const require = createRequire(new URL("../package.json", import.meta.url));
const { Client } = require("pg");

const dialled = process.env.SEED_DIALLED_NUMBER;
if (dialled === undefined) throw new Error("SEED_DIALLED_NUMBER must be set");

const url = process.env.MIGRATION_DIRECT_URL ?? process.env.MIGRATION_URL;
if (url === undefined) throw new Error("MIGRATION_DIRECT_URL or MIGRATION_URL must be set");

// The operator role, deliberately. `organization_numbers` is SELECT-only to `ansa_app`:
// which numbers an organisation answers is not something a tenant may grant itself, and
// seeding one is the operator doing operator work.
const client = new Client({ connectionString: url, ssl: { rejectUnauthorized: false } });
await client.connect();

// Terms on top of the base list in apps/api/src/tenancy/defaults.ts, not instead of it.
//
// Place and person names were here - Ikeja, Yaba, Lekki, Adebayo, Chukwu, Olabisi - and
// they were actively harmful. On a live call the caller said their own name and the
// transcript came back "Hi. My name is Ikeja." Boosting is a bias, not a hint: it makes
// the listed token WIN ties against everything unlisted, so a name the organization never
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
// organization is allowed to say here is bounded and filtered on the way into the prompt — see
// apps/api/src/prompts/organization-layer.ts. Writing "skip the readback" in either field would
// not skip the readback; the field would be dropped and the call logged as an error.
/*
 * The first thing a caller hears, and until now the seed had none.
 *
 * The publish call was misaligned by one, so the persona was landing in the greeting slot: a
 * dev agent that opened a call by reciting its own character notes. Nobody saw it, because
 * the same misalignment stopped the function resolving at all.
 */
const greeting = "Kano General Insurance, good afternoon. How can I help you today?";
const persona = "Warm and direct. Nigerian English. Never rush the caller off the line.";
const instructions = [
  "Office hours are 8am to 5pm WAT, Monday to Friday.",
  "Out of hours, take a callback number and say someone will ring in the morning.",
  "If you're not sure, say so and offer to have a person call back.",
].join("\n");

/**
 * The form, chosen to be the hardest version of itself rather than the easiest.
 *
 * Every one of these has been captured in a test and none of them on a call. The order is
 * deliberate: name first because it is the most forgiving and proves the form is being
 * conducted at all, then the two that are genuinely in doubt.
 *
 * - `policyNumber` carries a pattern, so a value the transcriber hears perfectly can still
 *   be rejected. That path has never run against a real transcript.
 * - `contactEmail` is the one to watch. Eight kilohertz destroys the consonants an address
 *   is made of — "m" against "n", "s" against "f" — and no amount of readback logic fixes
 *   a channel that never carried the distinction. If it fails, the honest answer is
 *   probably that email is a keypad or SMS field and not a spoken one, and finding that
 *   out is the point of putting it here.
 */
const capturedFields = [
  {
    key: "callerName",
    type: "name",
    prompt: "Before we start, can I take your name?",
    capture: "speech",
    confirm: "readback",
    required: true,
    pattern: "",
    attempts: 3,
    redact: false,
    options: [],
  },
  {
    key: "policyNumber",
    type: "reference",
    prompt: "What is your policy number? It starts with PM.",
    capture: "either",
    confirm: "readback",
    required: true,
    // Two letters and seven digits. The agent re-asks anything else, however clearly it
    // was said, and gives up on the third — which is a real conversation to sit through
    // before deciding the limit is right.
    pattern: "PM\\d{7}",
    attempts: 3,
    redact: false,
    options: [],
  },
  {
    key: "contactEmail",
    type: "email",
    prompt: "And what email should we send the certificate to?",
    capture: "speech",
    confirm: "spellback",
    required: false,
    pattern: "",
    attempts: 3,
    redact: false,
    options: [],
  },
];

await client.query("begin");

// Name is not unique and should not be, so this is find-then-insert rather than an upsert.
// Re-running the seed must not leave two organisations both answering the same line.
const { rows: existing } = await client.query(
  `select o.id from organizations o
     join organization_numbers n on n.organization_id = o.id
    where n.number = $1`,
  [dialled],
);
const organizationId =
  existing[0]?.id ??
  (
    await client.query(
      `insert into organizations (name, business_open_hour, business_close_hour, business_days)
       values ($1, 8, 17, '{1,2,3,4,5}') returning id`,
      ["Kano General Insurance"],
    )
  ).rows[0].id;

// The number is the routing key: `agent_config_for_number` resolves the whole call from it
// at ingress (R7.3), and the composite foreign key on `agents` refuses a dialled_number
// that is not registered here. So this row comes first, or the agent insert fails.
await client.query(
  `insert into organization_numbers (organization_id, number, note)
   values ($1, $2, 'development seed')
   on conflict (number) do update set organization_id = excluded.organization_id`,
  [organizationId, dialled],
);

// The conflict predicate matches `agents_dialled_number_idx` exactly, which is on
// `dialled_number is not null` and says nothing about archiving. One agent per number,
// including archived ones — so an archived agent still holds the line it answered, and
// re-running the seed updates that row rather than failing on it.
const { rows: agents } = await client.query(
  `insert into agents (organization_id, name, dialled_number, captured_fields, keyterms)
   values ($1, $2, $3, $4::jsonb, $5)
   on conflict (dialled_number) where dialled_number is not null
     do update set name = excluded.name,
                   captured_fields = excluded.captured_fields,
                   archived_at = null
   returning id`,
  [organizationId, "Renewals line", dialled, JSON.stringify(capturedFields), keyterms],
);
const agentId = agents[0].id;

// Publishing runs under the organization's own scope, exactly as the application would.
await client.query("select set_config('app.organization_id', $1, true)", [organizationId]);
//
// The argument list grows with every migration that adds a configurable field, and this
// call silently rotted twice before anyone noticed: 0012, 0013, 0014 and 0015 each dropped
// and recreated the function with a wider signature, and an old call site fails with
// "function does not exist" rather than with anything that names the missing field. Keep
// it in step, in the same commit as the migration.
//
// It names the agent it just created. It used to pass the organisation and let the database
// resolve the oldest live one — wrong once an organisation can run two, and unnecessary here
// where the id is three lines up.
//
// It was also broken. The call supplied sixteen arguments to a function requiring seventeen,
// so every position after `speaking_rate` was shifted by one and Postgres could not resolve
// the overload at all: the greeting slot held the persona, the instructions slot held a
// `text[]`, and the keyterms slot held the integer 8. It failed with "function does not
// exist", which names nothing and is exactly the rot the comment above warns about — the
// warning was right and the call it guards had already rotted again.
//
// Every argument is now labelled with the parameter it fills. Positional calls with
// eighteen slots are unreadable, and unreadable is how this happened twice.
const { rows } = await client.query(
  `select app.publish_agent_config_for_agent(
     $1,                    -- p_agent
     $2,                    -- p_name
     null, null,            -- p_voice_id, p_speaking_rate
     $3,                    -- p_greeting
     $4,                    -- p_persona
     $5,                    -- p_instructions
     $6,                    -- p_keyterms
     null, null,            -- p_tool_config, p_event_config
     null, null, null,      -- escalation: falls back to the platform number
     $7,                    -- p_note
     null                   -- p_policy_blocks
   ) as version`,
  [
    agentId,
    "Kano General Insurance",
    greeting,
    persona,
    instructions,
    keyterms,
    "development seed",
  ],
);

await client.query("commit");

console.log(
  "seeded:",
  JSON.stringify({
    organizationId,
    agentId,
    dialled,
    version: rows[0].version,
    keyterms: keyterms.length,
    fields: capturedFields.map((field) => field.key),
  }),
);
await client.end();
