# Multi-tenant architecture — the strong base, the thin config

**Status: design, not built.** Written 2026-08-08 so the next session starts from the
design rather than rebuilding it from a conversation.

The goal, in Vera's words: *"build a very strong customer service that organizations can
just do their own configuration on, and inject it from the DB — if our own prompt and
skills are solid, they only do a little configuration."*

That is the right shape, and it is a genuine differentiator. The incumbents hand a tenant
a blank prompt box and let them discover the edge cases themselves. An opinionated base,
where a Nigerian insurer configures five things and gets a competent agent, is a stronger
position than feature parity — and it is consistent with PRD §1.1: *does this widen the
geographic advantage, or drag us into a feature race we cannot win?*

Two principles make it work. The second is the one that matters.

---

## 1. The base is code first, prompt second

CLAUDE.md returns to this repeatedly, and a full day of live calls proved it: **prompts can
be talked out of things and dispatch paths cannot.**

In a single-tenant system that is a quality argument. In a multi-tenant one it is a safety
boundary, because **a tenant's instructions must never be able to switch off a guarantee.**

Consider a tenant who writes *"skip the readback, our customers find it slow."* If readback
is a prompt instruction, they have just disabled R4.3.1 and we own the consequence when a
caller's policy number is confirmed wrong — the exact event R9.3.4 calls a launch blocker.
If readback lives in the dispatch path, the instruction has no effect at all.

| Enforced in code — a tenant cannot override | Shaped by tenant config |
|---|---|
| Readback before any number captured from speech (R4.3.1) | Persona, tone, formality |
| DTMF fallback after two failed captures (R4.3.3) | Greeting wording |
| Risk tiers: `write` confirms, `irreversible` transfers (R5.3) | What to do when unsure |
| Turn-length budget by caller action | Domain vocabulary, keyterms |
| AI disclosure when asked directly (R6.7) | Escalation wording |
| Never leave silence; degrade into speech (R6.2) | When to offer a human |
| Escalate after three failed comprehensions (R6.4) | Business hours, transfer targets |
| Nothing reaches TTS unnormalized | Knowledge base content |
| `tenant_id` isolation via RLS (R7.2) | Which tools are registered |

The rule for adding anything to this system: **if getting it wrong harms a caller, it goes
in the left column.** The prompt may restate it — belt and braces — but the prompt is never
the thing holding it up.

---

## 2. Edge cases are captured, not imagined

This is a reframe of "we need to cover a lot of edge cases", and it is the more important
half of the design.

You cannot enumerate them in advance. One day of real calls produced failures nobody would
have predicted:

- a transcriber emitting Malayalam, then Māori, from Nigerian-accented English with
  `language: "en"` set explicitly
- keyterms passed as a prompt recited back as five phantom caller turns
- *"sorry"* meaning sympathy rather than apology in Nigerian English, making the agent
  repeat a refusal the caller had heard perfectly
- a caller's number arriving as words — "eight five nine two" — not digits
- the agent barging in on its own voice echoing through the caller's handset
- a real 100-character turn discarded because it opened with four emphatic "No"s

**Not one came from imagination. Every one came from dialling the number.**

PRD §9.2 already specifies the machine for this: every call auto-scanned against failure
heuristics, flagged calls into a review queue, a human corrects the transcript, and the
correction is promoted into the eval corpus **and** into a per-tenant keyterm **and** into a
normalizer test case.

That loop compounds, and it compounds *across tenants*: one tenant's mishearing makes the
base stronger for everyone. **That is the actual moat — more than the prompt is.**

The consequence for sequencing is easy to miss: **the event log is not infrastructure
housekeeping, it is the prerequisite for the product Vera is describing.** Without it every
failure stays in a log file someone greps by hand, and nothing accumulates.

---

## 3. Prompt composition

Not one string in a file. Five layers, composed per call, so per-tenant becomes swapping
one of them.

| layer | owner | changes | example |
|---|---|---|---|
| `base` | us | rarely | short turns, never invent a number, admit being an AI |
| `locale` | us | rarely | Nigerian English, naira, WAT, tolerate Pidgin |
| `tenant` | tenant | per config version | "You answer for Kano General Insurance. Warm, not chatty." |
| `task` | derived | per call | which tools are registered and when to use them |
| `turn` | derived | per turn | the budget instruction, already implemented |

`turn` already exists (`orchestrator/turn-budget.ts`) and is proof the layering works: it is
computed per turn and appended to the system prompt without touching the rest.

**Storage.** Files are a stepping stone; Postgres is the destination. R7.5 requires tenant
config to be **versioned**, with the version **recorded on every call** so a call from three
weeks ago can be explained. `calls.config_version` already exists in the schema for exactly
this and is currently unused.

**The tenant layer is bounded on purpose.** It layers on top of the base; it never replaces
it. A tenant supplies persona and rules, not the whole prompt. That is what keeps the left
column of §1 true.

---

## 4. Tenant configuration — a typed shape, not free text

```
tenant_config (versioned; every call records which version served it)
  name, voice_id, greeting
  keyterms[]                 -- their products, staff names, local place names
  persona, instructions      -- bounded free text, layered ON the base
  business_hours (WAT), out_of_hours: ticket | callback
  escalation: destinations, always-transfer intents
  tools[]                    -- registered into the one registry, each with a risk tier
  knowledge_base_ref
  pii_redaction_rules
  audio_retention_days       -- already on `tenants`
```

Validated at registration. That validation is what stops a tenant disabling something by
accident — a tool without a risk tier cannot be registered (R5.3), and an `instructions`
field cannot contain an override of a §1 guarantee.

---

## 5. On "skills"

**Do not build a separate skills concept.** The mechanism already exists and is specified:
PRD R5.2.0 — internal tools, HTTP connectors and MCP servers all register into **one**
registry and execute through **one** dispatch path, so risk tiers, timeouts, holding speech,
credential handling, SSRF guards, summarisation and logging are implemented once.

CLAUDE.md's test for new work is: *did you write an adapter, or did you write a second
dispatch path?* A parallel "skills" layer is the second dispatch path, and the security
controls would inevitably exist in one and not the other.

What "skills" means in practice — reusable capabilities, enabled per tenant — is what the
registry gives you, with risk tiers already enforced in code rather than requested in a
prompt.

---

## 6. Where we actually are, and what to build next

Slice 3 is essentially done and is the hardest engineering in the product: the conversation
loop works on real calls. What it cannot do is look anything up.

Ordered by caller-perceived value per unit of work:

1. **Per-tenant keyterms.** Small, immediate. The list is hardcoded in `media.gateway.ts`;
   moving it to config directly improves the name and product-term recognition Vera raised.
   The mechanism is proven — it is what made Deepgram hear "policy".
2. **Readback and the normalizer (Slice 4).** The launch blocker. R4.3.1 makes readback
   mandatory *with no confidence threshold that skips it*, R4.3.3 wants DTMF after two
   failures, and nothing currently normalizes numbers on the way out. This is why numbers
   fail today, and better STT will not fix it — a perfect transcriber still mishears a
   digit on an 8kHz line.
3. **Event log + review loop (Slice 2 remainder, Slice 4a).** The edge-case engine of §2.
   Nothing accumulates without it.
4. **Prompt layering (§3).** Useful, but the least load-bearing of these five: the base is
   currently strong enough and no second tenant exists.
5. **Tool registry (Slice 5).** The point at which the agent can finally *do* something,
   and the end of "I can't check that."

**The honest summary of today:** we have a genuinely good conversationalist with nothing to
talk about. Everything above 4 is about giving it something to say and a way to learn from
getting it wrong.

---

## 7. What this does not change

PRD §1.2's v1 non-goals stand: no self-serve builder UI, no billing, no connector
marketplace, no analytics beyond raw call inspection. First ten tenants are onboarded by
hand (§11, Phase 1).

The platform ambition is right and the step-by-step approach is right. But building the
multi-tenant machinery before the agent can answer a question would be constructing
scaffolding around an empty middle. **The foundation worth being careful about is not the
tenant plumbing — it is one company's calls working brilliantly.**
