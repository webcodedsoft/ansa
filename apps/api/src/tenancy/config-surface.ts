import {
  EVENT_TYPES,
  HARD_TIMEOUT_MS,
  REDACTION_CATEGORIES,
  SOFT_TIMEOUT_MS,
} from "@ansa/tools";

import { ENFORCED_IN_CODE } from "../prompts/guarantees";
import { LIMITS } from "../prompts/tenant-layer";

import { BASE_KEYTERMS, MAX_KEYTERMS } from "./defaults";

/**
 * `docs/TENANT_CONFIGURATION.md`, written from the code that enforces it.
 *
 * The document answers one question — what can an organisation change, and what can it
 * not — and the only way that question stays answered is if the answer is derived rather
 * than typed. A hand-written table saying "risk tiers are enforced" survives the commit
 * that stops enforcing them; this does not, because the guarantee list, the redaction
 * categories, the event types, the text limits, the timeouts and the base vocabulary are
 * all read out of the modules that implement them.
 *
 * `config-surface.test.ts` regenerates this and fails if the file on disk differs, so the
 * document is checked in — a reader should not have to run anything — and cannot drift.
 * The test says how to rewrite it.
 *
 * What is *not* generated is the prose around the tables and the list of columns, because
 * neither exists as data anywhere: the columns live in migrations 0003 through 0015 as SQL
 * this process does not read. Those are the parts to check by hand when the schema moves,
 * and they are kept short for that reason.
 */

const ms = (value: number): string => `${(value / 1000).toFixed(value % 1000 === 0 ? 0 : 1)}s`;

/** One row per thing a tenant may set, and where it is bounded. */
interface Configurable {
  readonly field: string;
  readonly what: string;
  readonly bound: string;
}

const CONFIGURABLE: readonly Configurable[] = [
  {
    field: "`name`",
    what: "What the agent says the organisation is called.",
    bound: `${LIMITS.name.chars} characters, ${LIMITS.name.lines} line. Quoted in the prompt, and double quotes are removed, so it is a value rather than a sentence.`,
  },
  {
    field: "`persona`",
    what: "How to sound. Tone, formality, pace.",
    bound: `${LIMITS.persona.chars} characters, ${LIMITS.persona.lines} lines. Dropped whole if it trips a guarantee.`,
  },
  {
    field: "`instructions`",
    what: "The business rules the base cannot know: what to do when unsure, who to send where.",
    bound: `${LIMITS.instructions.chars} characters, ${LIMITS.instructions.lines} lines. Dropped whole if it trips a guarantee.`,
  },
  {
    field: "`greeting`",
    what: "The first sentence of every call.",
    bound: "Free text. Normalised on the way to TTS like everything else. Unset uses the platform's.",
  },
  {
    field: "`voiceId`",
    what: "Which voice answers.",
    bound:
      "Any id the TTS account holds. **Not validated on publish** — a wrong one fails synthesis and the call ends rather than going silent. Check it on a call.",
  },
  {
    field: "`keyterms`",
    what: "Vocabulary the transcriber should expect: products, coverage types, the company name.",
    bound: `Merged on top of the base, de-duplicated, capped at ${MAX_KEYTERMS}. A term containing a comma is dropped. Never personal names — boosting is a bias, not a hint.`,
  },
  {
    field: "`businessHours`",
    what: "When the organisation's own line is staffed, in WAT.",
    bound:
      "All three of open hour, close hour and days, or none. No overnight window. Unset means the agent says it does not know, which is the honest answer.",
  },
  {
    field: "`escalation`",
    what: "Where a transfer goes, and how long it rings.",
    bound:
      "Both numbers E.164 or neither. Ring 5-120 seconds. Unset falls back to the platform's number, which is wrong once there is more than one tenant.",
  },
  {
    field: "`tools`",
    what: "The organisation's own lookups, over HTTP or MCP.",
    bound:
      "Risk tier required. Hosts declared in `egress.allowedHosts` and checked against every URL at publish. Credentials by reference; the value is sealed and never in the config.",
  },
  {
    field: "`events`",
    what: "Where a record of each call is pushed, and what is masked on the way.",
    bound: `Types: ${EVENT_TYPES.map((t) => `\`${t}\``).join(", ")}. Signing secret required. Nothing is redacted unless asked for.`,
  },
];

/** The three tiers, and what the dispatch path does with each. Not prompt instructions. */
const TIERS: readonly { readonly tier: string; readonly happens: string }[] = [
  { tier: "`read`", happens: "Executes. Retried once inside the same deadline." },
  {
    tier: "`write`",
    happens:
      "A readback is spoken and the caller has to agree out loud before anything fires. A registration without a `readback` is refused.",
  },
  {
    tier: "`irreversible`",
    happens:
      "Never executes. The call is handed to a person, and no confirmation id can talk it into running.",
  },
];

const table = (headers: readonly string[], rows: readonly (readonly string[])[]): string =>
  [
    `| ${headers.join(" | ")} |`,
    `|${headers.map(() => "---").join("|")}|`,
    ...rows.map((row) => `| ${row.join(" | ")} |`),
  ].join("\n");

export const renderConfigurationSurface = (): string =>
  [
    "# What a tenant can configure, and what it cannot",
    "",
    "**Generated.** `apps/api/src/tenancy/config-surface.ts` builds this from the code that",
    "enforces it, and `config-surface.test.ts` fails if this file and that code disagree. Edit",
    "the code, run the test, commit both. A sentence added here by hand will be deleted by the",
    "next run, which is the point: a document about enforcement that can drift from the",
    "enforcement is worse than no document.",
    "",
    "The split it describes is `docs/MULTI_TENANT_ARCHITECTURE.md` §1. In one sentence:",
    "**an organisation chooses its content, never whether a guarantee applies.**",
    "",
    "---",
    "",
    "## 1. What an organisation sets",
    "",
    "Published with `tools/tenant/config.mjs publish <file.json> \"<why>\"`, as a whole",
    "configuration rather than a patch. Every publish bumps `config_version` and snapshots the",
    "whole thing into `tenant_prompt_versions`, and every call records the version that served",
    "it, so a call from three weeks ago can still be explained (R7.5).",
    "",
    table(
      ["field", "what it changes", "how it is bounded"],
      CONFIGURABLE.map((c) => [c.field, c.what, c.bound]),
    ),
    "",
    `Base vocabulary every organisation inherits, on top of which their own is merged: ${BASE_KEYTERMS.map((t) => `\`${t}\``).join(", ")}.`,
    "A term earns a place there by being true of every organisation on the platform, not by",
    "having been misheard once — the insurance words that used to be here moved to the",
    "insurer's own list when the second tenant arrived.",
    "",
    "---",
    "",
    "## 2. What an organisation cannot set, and where it is refused",
    "",
    "Not a policy. Each of these is enforced somewhere that a prompt cannot reach, and the",
    "`where` column is read out of `apps/api/src/prompts/guarantees.ts` — the same list that",
    "produces the tripwires which reject the configuration and the block that restates it to",
    "the model.",
    "",
    table(
      ["requirement", "enforced in", "restated to the model"],
      ENFORCED_IN_CODE.map((g) => [
        `\`${g.id}\``,
        g.where,
        g.spoken === null ? "no — invisible to it" : "yes",
      ]),
    ),
    "",
    "An organisation whose `persona` or `instructions` trips one of these loses that field on",
    "every call, loudly, in the log, with the config version — and the guarantee holds anyway,",
    "because the prompt was never what was holding it up. The tripwires are a courtesy that",
    "tells them so, not the boundary.",
    "",
    "**One entry is not like the others.** R6.7, admitting to being an AI, has no dispatch path",
    "behind it. The prompt says to admit it and the tripwires reject an organisation that says",
    "otherwise, and that is the whole of it. It is in the table because it is in §1 of the",
    "architecture doc; it is called out here because the table would otherwise read as though",
    "it were as safe as the rest.",
    "",
    "---",
    "",
    "## 3. Tools",
    "",
    "One registry, one dispatch path, and an organisation's own tools go through exactly the",
    "code the platform's do. A risk tier is required at registration and refused without one.",
    "",
    table(["tier", "what the dispatch path does"], TIERS.map((t) => [t.tier, t.happens])),
    "",
    `Ceilings apply to every tool whoever wrote it: holding speech changes register at ${ms(SOFT_TIMEOUT_MS)} and the call is abandoned at ${ms(HARD_TIMEOUT_MS)}. A tool may ask for less and never for more.`,
    "",
    "A tool that declares `identifiers` will not run until the caller has confirmed that",
    "detail out loud on this call. A tool belonging to another organisation is reported",
    "exactly as one that does not exist, down to the words the caller hears.",
    "",
    "---",
    "",
    "## 4. Redaction",
    "",
    "**Nothing is redacted unless an organisation asks for it.** They are the data controller,",
    "the caller is their customer, and the payload is a record of a conversation their own",
    "agent had. Categories available:",
    "",
    ...REDACTION_CATEGORIES.map((category) => `- \`${category}\``),
    "",
    "What none of them can catch is in `docs/EVENT_WEBHOOKS.md`, and it is the part worth",
    "reading: a name, an address and a date of birth have no shape that distinguishes them",
    "from prose.",
    "",
    "Separately and unconditionally, credential-shaped keys never leave the process. That one",
    "is not configurable in either direction — it is secret material held in trust, not the",
    "organisation's data.",
    "",
    "---",
    "",
    "## 5. What the operator sets, not the organisation",
    "",
    "These are on the tenant row and deliberately absent from `publish_tenant_config`, so the",
    "onboarding path cannot reach them:",
    "",
    "- **`dialled_number`** — the ingress routing table. An organisation that could write it",
    "  could claim a number nobody assigned it. `tools/tenant/provision.mjs` sets it, as the",
    "  database owner.",
    "- **`consent_policy`, `consent_basis`, `calling_earliest_hour`, `calling_latest_hour`** —",
    "  the gate on who may be dialled and when. An organisation asking to place calls must not",
    "  be the one deciding whether the check applies.",
    "- **`audio_retention_days`** — how long a caller's voice is kept.",
    "",
    "Being absent from the tool is not the same as being unreachable. `ansa_app` still holds",
    "`INSERT` on `tenants`, and the RLS policy passes for any row whose `id` matches the scope",
    "the connection set, so a process holding `DATABASE_URL` could create a tenant and claim a",
    "free number. Nothing does, and the adversarial RLS suite needs the grant for its own",
    "fixtures. Column-level grants would close it and should, before anyone outside the team",
    "holds those credentials.",
  ].join("\n") + "\n";
