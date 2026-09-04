# What a organization can configure, and what it cannot

**Generated.** `apps/api/src/tenancy/config-surface.ts` builds this from the code that
enforces it, and `config-surface.test.ts` fails if this file and that code disagree. Edit
the code, run the test, commit both. A sentence added here by hand will be deleted by the
next run, which is the point: a document about enforcement that can drift from the
enforcement is worse than no document.

The split it describes is `docs/MULTI_TENANT_ARCHITECTURE.md` §1. In one sentence:
**an organisation chooses its content, never whether a guarantee applies.**

---

## 1. What an organisation sets

Published with `tools/organization/config.mjs publish <file.json> "<why>"`, as a whole
configuration rather than a patch. Every publish bumps `config_version` and snapshots the
whole thing into `agent_prompt_versions`, and every call records the version that served
it, so a call from three weeks ago can still be explained (R7.5).

| field | what it changes | how it is bounded |
|---|---|---|
| `name` | What the agent says the organisation is called. | 120 characters, 1 line. Quoted in the prompt, and double quotes are removed, so it is a value rather than a sentence. |
| `persona` | How to sound. Tone, formality, pace. | 400 characters, 6 lines. Dropped whole if it trips a guarantee. |
| `instructions` | The business rules the base cannot know: what to do when unsure, who to send where. | 2000 characters, 40 lines. Dropped whole if it trips a guarantee. |
| `greeting` | The first sentence of every call. | Free text. Normalised on the way to TTS like everything else. Unset uses the platform's. |
| `voiceId` | Which voice answers. | Any id the TTS account holds. **Not validated on publish** — a wrong one fails synthesis and the call ends rather than going silent. Check it on a call. |
| `keyterms` | Vocabulary the transcriber should expect: products, coverage types, the company name. | Merged on top of the base, de-duplicated, capped at 100. A term containing a comma is dropped. Never personal names — boosting is a bias, not a hint. |
| `businessHours` | When the organisation's own line is staffed, in WAT. | All three of open hour, close hour and days, or none. No overnight window. Unset means the agent says it does not know, which is the honest answer. |
| `escalation` | Where a transfer goes, and how long it rings. | Both numbers E.164 or neither. Ring 5-120 seconds. Unset falls back to the platform's number, which is wrong once there is more than one organization. |
| `tools` | The organisation's own lookups, over HTTP or MCP. | Risk tier required. Hosts declared in `egress.allowedHosts` and checked against every URL at publish. Credentials by reference; the value is sealed and never in the config. |
| `events` | Where a record of each call is pushed. | Types: `call.ended`, `call.transferred`. Signing secret required. No caller value is redacted. |

Base vocabulary every organisation inherits, on top of which their own is merged: `Ansa`, `naira`, `Sikiru`, `Adebayo`, `Adeyemi`, `Babatunde`, `Olumide`, `Oluwaseun`, `Abiodun`, `Segun`, `Tunde`, `Femi`, `Kunle`, `Wale`, `Seyi`, `Kehinde`, `Taiwo`, `Damilola`, `Temitope`, `Folake`, `Yewande`, `Bolanle`, `Funmilayo`, `Bisi`, `Chinedu`, `Chukwuemeka`, `Nnamdi`, `Uchenna`, `Ifeanyi`, `Emeka`, `Obinna`, `Ekene`, `Ngozi`, `Chidinma`, `Ifeoma`, `Amaka`, `Adaeze`, `Chiamaka`, `Ibrahim`, `Aminu`, `Usman`, `Musa`, `Yusuf`, `Sadiq`, `Bashir`, `Fatima`, `Zainab`, `Aisha`, `Halima`, `Hauwa`, `Lagos`, `Abuja`, `Ikeja`, `Lekki`, `Ikoyi`, `Ajah`, `Yaba`, `Surulere`, `Ibadan`, `Port Harcourt`, `Enugu`, `Oga`, `Madam`, `Aunty`, `wahala`, `abeg`, `oya`.
A term earns a place there by being true of every organisation on the platform, not by
having been misheard once — the insurance words that used to be here moved to the
insurer's own list when the second organization arrived.

---

## 2. What an organisation cannot set, and where it is refused

Not a policy. Each of these is enforced somewhere that a prompt cannot reach, and the
`where` column is read out of `apps/api/src/prompts/guarantees.ts` — the same list that
produces the tripwires which reject the configuration and the block that restates it to
the model.

| requirement | enforced in | restated to the model |
|---|---|---|
| `R4.3.1` | capture/readback dispatch path | yes |
| `R4.3.3` | capture dispatch path | no — invisible to it |
| `R5.3` | tool registry dispatch path | yes |
| `ABS-3` | prompt only — no dispatch path can judge a sentence | yes |
| `ABS-6` | prompt only — no dispatch path can judge a sentence | yes |
| `ABS-7` | prompt only — no dispatch path can judge a sentence | yes |
| `ABS-8` | prompt only — no dispatch path can judge a sentence | yes |
| `R6.7` | prompt only — the model is the only thing that can answer this question | yes |
| `R6.2` | holding-speech scheduler and the degrade-to-speech paths | no — invisible to it |
| `R6.4` | escalation counter in the conversation loop | no — invisible to it |
| `R7.2` | Postgres RLS, ENABLE and FORCE on every table | no — invisible to it |
| `normalizer` | packages/normalizer, on every path into TTS | yes |
| `layering` | compose.ts — the organization layer has no slot that could hold the base | no — invisible to it |

An organisation whose `persona` or `instructions` trips one of these loses that field on
every call, loudly, in the log, with the config version — and the guarantee holds anyway,
because the prompt was never what was holding it up. The tripwires are a courtesy that
tells them so, not the boundary.

**One entry is not like the others.** R6.7, admitting to being an AI, has no dispatch path
behind it. The prompt says to admit it and the tripwires reject an organisation that says
otherwise, and that is the whole of it. It is in the table because it is in §1 of the
architecture doc; it is called out here because the table would otherwise read as though
it were as safe as the rest.

---

## 3. Tools

One registry, one dispatch path, and an organisation's own tools go through exactly the
code the platform's do. A risk tier is required at registration and refused without one.

| tier | what the dispatch path does |
|---|---|
| `read` | Executes. Retried once inside the same deadline. |
| `write` | A readback is spoken and the caller has to agree out loud before anything fires. A registration without a `readback` is refused. |
| `irreversible` | Never executes. The call is handed to a person, and no confirmation id can talk it into running. |

Ceilings apply to every tool whoever wrote it: holding speech changes register at 1.5s and the call is abandoned at 3s. A tool may ask for less and never for more.

A tool that declares `identifiers` will not run until the caller has confirmed that
detail out loud on this call. A tool belonging to another organisation is reported
exactly as one that does not exist, down to the words the caller hears.

---

## 4. Redaction

**No caller value is ever redacted, and there is no setting for it.** The organisation
is the data controller, the caller is their customer, and the payload is a record of a
conversation their own agent had. R5.2.4 offered per-receiver masking of names,
identifiers and digit runs; it was withdrawn on 2026-08-15 because deciding on an
organisation's behalf which of their own data they may receive was never ours to make,
and because it broke the obvious uses — a CRM cannot look up a masked policy number.

What follows from that, stated plainly rather than left to be discovered: transcripts,
event payloads and the internal event log carry whatever the caller said, including a
NIN, a BVN and a one-time code. They are identifying data at rest and should be treated
as such — `recordings/` is gitignored for the same reason.

Separately and unconditionally, credential-shaped keys never leave the process. That one
is not configurable in either direction — it is secret material held in trust, not the
organisation's data, and withdrawing R5.2.4 did not touch it.

---

## 5. What the operator sets, not the organisation

These are on the organization row and deliberately absent from `publish_organization_config`, so the
onboarding path cannot reach them:

- **`dialled_number`** — the ingress routing table. An organisation that could write it
  could claim a number nobody assigned it. `tools/organization/provision.mjs` sets it, as the
  database owner.
- **`consent_policy`, `consent_basis`, `calling_earliest_hour`, `calling_latest_hour`** —
  the gate on who may be dialled and when. An organisation asking to place calls must not
  be the one deciding whether the check applies.
- **`audio_retention_days`** — how long a caller's voice is kept.

Being absent from the tool is not the same as being unreachable. `ansa_app` still holds
`INSERT` on `organizations`, and the RLS policy passes for any row whose `id` matches the scope
the connection set, so a process holding `DATABASE_URL` could create a organization and claim a
free number. Nothing does, and the adversarial RLS suite needs the grant for its own
fixtures. Column-level grants would close it and should, before anyone outside the team
holds those credentials.
