# Ansa — Making It Sound Like a Person

**An execution plan for Slice 3's conversation-quality pass.**
Scope: `apps/api/src/orchestrator/*`, `apps/api/src/telephony/{filler,greeting,prerender}.ts`, one field on `packages/providers/llm`. Nothing else.

---

## 0. The diagnosis in one paragraph

Three things are wrong and they are not equally wrong. **Reply length and shape** is the loudest — a 4598ms median monologue against a human inter-pausal-unit median of 1227ms ([Levinson & Torreira 2015, Frontiers 6:731](https://www.frontiersin.org/articles/10.3389/fpsyg.2015.00731/full), 348 Switchboard telephone conversations, 50,510 IPUs, mean 1680ms) — and it is entirely fixable in this slice. **Nigerian interactional fit** is second: the token sets in `orchestrator.ts` are Anglo-American, and three of them contain live defects that make the agent repeat itself or burn an LLM turn on a particle. **Timing** is third and smallest, which is the opposite of what the team assumed: re-measured against ICE-Nigeria phone calls with backchannels excluded (n=808 real floor transitions), human median is +200ms, p75 +940ms, p90 +1860ms — so our 968–1532ms gap sits *inside* the human p75–p90 band. It is not conspicuously slow. It is conspicuously **long-winded, foreign-registered, and empty**.

The fourth thing — the agent has no knowledge base and therefore nothing to say — is the largest single contributor to the specific call that was recorded, and **nothing in this plan fixes it**. Section 6 is honest about that.

---

## 1. The adaptive turn-length mechanism

This is the part the user called "the important part of this app". It replaces `maxTokens: 45` (`orchestrator.ts:730`) and `MAX_SENTENCES_PER_TURN = 2` (`orchestrator.ts:159`).

### 1.1 First, kill the premise

`maxTokens: 45` was never a length control. The comment at `orchestrator.ts:726-730` justifies it at "~17 characters per second of speech", but the same file sets `CHARS_PER_SECOND = 13` at line 119 with a comment saying real rate is ~15. At 15 chars/sec, **45 tokens ≈ 180 characters ≈ 12 seconds of speech**. It has never bound. The measured 4598ms median reply is ~69 chars ≈ 17–20 tokens — well under the cap. The thing actually cutting turns off today is `MAX_SENTENCES_PER_TURN = 2`, and the reason `isFragment` exists at `orchestrator.ts:762` is that the token cap *does* occasionally guillotine mid-clause, and the 15-character heuristic lets longer truncations through to the caller. **Callers are hearing sentences stop mid-word today.**

So: do not "lower max_tokens". Tokens are the wrong unit. The research measures words and seconds; the code should too.

### 1.2 The signal

Computed in a new pure module `apps/api/src/orchestrator/action.ts` — arrow-function exports, no I/O, exhaustively unit-tested in the `packages/normalizer` discipline, because it decides classification and a misclassification is audible.

```ts
export type CallerAction =
  | "polar"        // yes/no or confirmation-seeking
  | "wh"           // asks for one fact
  | "explanation"  // asks how something works or what the conditions are
  | "readback"     // supplying a number/name for confirmation
  | "troubles"     // reporting a problem, no question
  | "greeting"
  | "closing"
  | "statement";   // unmatched — the safe default

export const classify = (text: string): CallerAction => …
```

Input is the **already-normalised** caller text (`normalise()` from `hearing.ts:27` — lowercased, punctuation flattened), the same flattened form `BACKCHANNEL` and `REPAIR_ALONE` already compare against, plus the turn-final tag stripped by step 4 below. Reuse `normalise`; do not write a second flattener.

**Classification order matters, and the obvious order is wrong.** Stivers 2010 (*Journal of Pragmatics* 42(10); 350 questions, n=328 analysed, 17 interactions) found polar questions are 70% of all questions, and **63% of those polar questions are declaratives with no auxiliary inversion**. An auxiliary-initial regex (`^(do|does|did|is|are|can|will|have)`) catches the 31% minority and misses the dominant form. So:

1. **explanation** — high-precision lexical cues only: `how do i`, `how can i`, `how does`, `what happens if`, `what do i need`, `what s the process`, `walk me through`, `explain`, `steps`, `why`. These are distinctive; false positives are rare and the failure is a too-long answer, which is the failure we can already see.
2. **readback** — contains ≥4 consecutive digits, or follows an agent turn that ended in a question about a number.
3. **wh** — `what` / `where` / `when` / `who` / `which` / `how much` / `how many`, without an explanation cue.
4. **troubles** — >20 words, no question mark, no wh-word, and affect lexis (`problem`, `wahala`, `nobody`, `since`, `i ve been`, `they didn t`, `still not`).
5. **greeting** / **closing** — whole-utterance match against small sets.
6. **polar** — **the default for anything short**. Not "auxiliary-initial": ≤12 words after tag-stripping, no wh-word, no explanation cue. This is deliberately the catch-all for short input, because a short caller turn almost never wants thirty words back, whether it was a question or not.
7. **statement** — everything else. Keeps today's behaviour exactly.

The critical property: **"Is my policy still active?" and "How do I make a claim?" traverse the same function and diverge at step 1 vs step 6.** No branch anywhere else in the orchestrator knows the difference.

### 1.3 The value

A second pure module, `apps/api/src/orchestrator/turn-budget.ts`:

```ts
export interface TurnBudget {
  readonly action: CallerAction;
  readonly maxWords: number;    // the control
  readonly maxUnits: number;    // secondary
  readonly maxTokens: number;   // runaway guard only
  readonly targetMs: number;    // derived, for logging and the prompt fragment
  readonly instruction: string; // the soft layer
}
export const budgetFor = (action: CallerAction, charsPerSecond: number): TurnBudget => …
```

Provisional table. `targetMs` is derived as `maxWords × 5.2 chars/word ÷ charsPerSecond`, using the **measured** rate from step 3 rather than any of the three unmeasured constants currently in the file (13, 15, 17).

| action | maxWords | maxUnits | maxTokens (guard) | ≈ targetMs @15 c/s | anchor |
|---|---|---|---|---|---|
| `closing` | 4 | 1 | 40 | ~1.4s | SPAADIA agent `bye` turns med 1 word (n=14) |
| `polar` | 6 | 1 | 40 | ~2.1s | Stivers 2010: 77% of polar answers are a yes/no interjection |
| `readback` | 12 | 1 | 40 | ~4.2s | R4.3.1 one item per turn |
| `wh` | 14 | 1 | 42 | ~4.9s | SPAADIA `reqInfo` med 5 / p95 11 words |
| `troubles` | 8 | 1 | 40 | ~2.8s | affiliate, then one question |
| `statement` | 22 | 2 | 48 | ~7.6s | ≈ today's behaviour; safe default |
| `explanation` | 40 | 3 | 110 | ~13.9s | SPAADIA `answer-state` med 12 / p95 63 |
| `greeting` | — | — | — | — | zero-LLM fixed text (step 12) |

`maxTokens = clamp(maxWords × 2.2, 40, 120)`. It is a runaway guard, not a length control — see 1.5.

### 1.4 Where it is wired

Three call sites in `orchestrator.ts`, all inside `respondTo` (`:684`):

```ts
// :684, at entry
const budget = budgetFor(classify(normalise(callerText)), deps.charsPerSecond);

// :723 — CompletionRequest.system is already per-call
// (packages/providers/llm/src/types.ts:10), so no interface change, no vendor type moves.
const completion = deps.llm.complete({
  system: `${SYSTEM_PROMPT}\n\n${budget.instruction}`,
  messages: conversation.messages,
  maxTokens: budget.maxTokens,
});

// :744-753 — replace the MAX_SENTENCES_PER_TURN comparison
let wordsSpoken = 0;
for (const sentence of sentences.push(token)) {
  if (unitsSpoken >= budget.maxUnits || wordsSpoken >= budget.maxWords) {
    log.info("turn capped", { seq, action: budget.action, wordsSpoken, budget: budget.maxWords });
    current.llmDone = true;
    current.cancelLlm?.();
    return;
  }
  unitsSpoken += 1;
  wordsSpoken += countWords(sentence);
  enqueue(current, sentence);
}
```

### 1.5 Why this does not depend on the model obeying an instruction

Four layers, three of them code:

| layer | mechanism | enforced by |
|---|---|---|
| 1 | word cap evaluated **at sentence boundaries** | the `for` loop above — cancels the completion at a clean boundary; the caller never hears a partial word |
| 2 | unit cap | same loop |
| 3 | `maxTokens` on the request | the vendor stops generating |
| 4 | `budget.instruction` in the system string | the model, which may ignore it |

Layer 4 exists **only so layers 1–3 rarely fire**. That distinction is load-bearing: a tight cap with no instruction produces a *truncated* reply, not a *short* one, and a deliberately short reply and a guillotined one sound completely different on the phone. The reason layer 4 is not sufficient on its own is exactly CLAUDE.md's argument for code-side risk tiers — prompts can be talked out of things.

The reason layer 1 counts **words at sentence boundaries** rather than tokens mid-stream is that it is the only control that is simultaneously hard, denominated in the unit the research measures, and incapable of cutting mid-word.

**The one residual failure and its bound.** If the model writes a single 60-word first sentence for a `polar`, layer 1 never gets a boundary to fire at and layer 3 truncates it — and step 2 below then discards the truncated text, so the caller hears nothing. Mitigation, in order: (a) `maxTokens` floors at 40 for every tier, which comfortably fits one ordinary sentence; (b) the turn watchdog at `:713` already catches a turn that produces no audio and speaks a recovery line; (c) log `realised words > budget` on every turn so this is counted rather than argued about. **If the count is non-trivial after two live calls, the fix is a clause-level split in `sentences.ts` — and only then.** Do not build the clause splitter speculatively; a finding claiming `sentences.ts` "already splits on TCU boundaries" is false (it splits on `/([.!?])(\s+|$)/` with an abbreviation guard), and turning it into a real TCU splitter is a separate, riskier change that risks TTS prosody.

### 1.6 Escalation — the code half of "don't say the same thing twice"

Dingemanse et al. 2015 (*PLOS ONE* 10(9):e0136100 — 12 languages, 8 families, 48.5 hours, 2,053 repair initiations, one every 1.4 minutes) found that when a repair initiator fails, speakers are **significantly less likely to repeat the same type** and shift to a more specific one. The measured call's `"What what what do you see?"` / `"Okay, but what can you do?"` is textbook escalating other-initiated repair, and the current prompt line at `system-prompt.ts:28-29` ("if you don't know it, say you don't know it") licenses exactly the repeatable bare refusal that never appears in the human corpus.

New pure module `apps/api/src/orchestrator/call-state.ts`, stage 1 only:

```ts
export interface CallState {
  noteCaller(text: string, wasRepair: boolean): number; // returns repeat count
}
```

`repeats` is incremented when consecutive caller turns share >`REPEAT_OVERLAP` (a named exported constant, provisionally 0.6 — **invented, no measurement behind it**, so Gate A can move it) normalised content-word overlap. Two hard rules:

- **Name it `repeats`, not `attempts`.** `orchestrator.ts:396` already has `const attempts = new Map<string, number>()` for TTS retries. Two counters called `attempts` in one 900-line file is a defect waiting for a tired session.
- **A repair request must not increment it.** Check `isRepairRequest` first. Someone saying "sorry, what?" twice wants the same thing again — that is the 291ms `repeatLast` path working correctly — and must never escalate toward a transfer.

Two code branches in `respondTo`:
- `repeats >= 2` → escalate the budget one tier (`polar`→`wh`, `wh`→`explanation`) **and** append a second fragment: *"You have already answered this and it did not land. Do not rephrase the same answer. Name the specific reason, then offer a different route — a callback, a person, or ask what they are actually trying to achieve."*
- `repeats >= 3` → speak the human-transfer offer. **Spoken only.** `transfer_to_human` is a Slice 5 tool and building a transfer path in the orchestrator now would be the second dispatch path CLAUDE.md forbids.

This is the counter R6.4 has needed since Slice 3, and the repair ladder (deferred, section 4) would consume the same one. **Build one counter.**

---

## 2. Universal vs Nigeria-specific

### 2.1 Universal — high confidence, well-measured

| claim | number | source |
|---|---|---|
| Telephone floor-transfer offset | mean 187ms, median 168ms, mode 169ms, SD 448ms; 19,754 transitions, 348 conversations, ~31h; **12 floor transfers per minute** | [Roberts, Torreira & Levinson 2015, Frontiers 6:509](https://www.frontiersin.org/articles/10.3389/fpsyg.2015.00509/full) |
| Transition speed distribution | 51–55% under 200ms; 70–82% under 500ms; 30.1% of transfers are *overlaps*, modal overlap 96ms | [Levinson & Torreira 2015](https://www.frontiersin.org/articles/10.3389/fpsyg.2015.00731/full) |
| Turn/IPU length | 50,510 IPUs, **mean 1680ms, median 1227ms** | ibid. §5.2.1 |
| Cross-linguistic response timing | 10 languages; modes 0 to +200ms; overall median +100ms, mean +208ms; Japanese +7ms to Danish +469ms | [Stivers et al. 2009, PNAS 106(26):10587](https://pmc.ncbi.nlm.nih.gov/articles/PMC2705608/) |
| 700ms is where delay stops meaning *slow* and starts meaning *unwilling* | n=380 raters, 200–1200ms in 100ms steps, identical affirmative content | [Roberts & Francis 2013, JASA 133(6):EL471](https://pubs.aip.org/asa/jasa/article/133/6/EL471/850466) |
| …corroborated in corpora | "only for turn transitions of 700 ms or more was the proportion of dispreferred responding actions clearly greater than that of preferreds"; n=195 | Kendrick & Torreira 2015, *Discourse Processes* 52(4):255–289 |
| By 1000ms the listener's neural expectation has already flipped | 32 participants; N400 for "no" vs "yes" present at 300ms gap, **gone at 1000ms** | Bögels, Kendrick & Levinson 2015 |
| Repair frequency | once every **1.4 minutes**, all 12 languages; repair sequence conserves length at ~1.2:1 | Dingemanse et al. 2015, PLOS ONE 10(9):e0136100 |
| Polar questions dominate; answers are interjections | polar 70% of questions (63% of those *declarative*); **77% of polar answers are a yes/no interjection** | Stivers 2010, *J. Pragmatics* 42(10) |
| Length is punished specifically in speech | same explanations: >85% "right length" visually, **~65% "too long"** spoken | [Gonzalez et al. 2021](https://arxiv.org/abs/2109.03357) |
| No single response length wins | 72 participants, 8 requests; keyword responses preferred in 5 of 8 | Haas et al., CHI 2022, "Keep it Short" |
| Filler tolerance | preference peaks at 1s response time, levels off at 2s; fillers moderate impressions of long delays | Shiwa et al. 2008/2009 |
| Filler ceiling | latency above **4 seconds** degrades quality of experience | [Wu et al., CUI '25, arXiv:2507.22352](https://arxiv.org/abs/2507.22352) |
| Face-to-face pauses ~4× telephone pauses | — | ten Bosch, Oostdijk & de Ruiter 2004, TSD/LNCS ([link](https://link.springer.com/chapter/10.1007/978-3-540-30120-2_71)) — **not** the 2005 Speech Communication paper, which is a different result |

### 2.2 Nigeria-specific — one strong source, everything else thin

**Strong.** [Unuabonah, Oyebola & Gut 2021, *Frontiers in Communication* 6:777569](https://www.frontiersin.org/articles/10.3389/fcomm.2021.777569/full) — ICE-Nigeria spoken dialogue subcorpus, 97 texts, 233,752 words, **1,326 question-tag tokens at 284.85 per 50,000 words**:

| tag | n | % |
|---|---|---|
| *you know* | 330 | 24.9 |
| *now / na* | 233 | 17.6 |
| *OK* | 151 | 11.4 |
| *o* | 140 | 10.6 |
| *sha* | 44 | 3.3 |
| *abi* | 31 | 2.3 |
| *sef* | 12 | 0.9 |
| *ba* | 11 | 0.8 |

English-derived 62.7%, indigenous/Pidgin 19.7%. **Variant tags are 2.5% of the total (33/1,326) — invariant forms are ~97.5%.** (An earlier writeup reported "54.5% invariant"; that is 18/33, the share of the *variant-form* tags used invariantly, and it understates the case by an order of magnitude. Do not quote 54.5%.) Functions: punctuational 49.2%, facilitative 34.1%, informative 10.4%.

**Measured from ICE-Nigeria phone calls directly** (reproducible from the ELAN files): backchannel inventory *mhm* 1831, *okay* 795, *yeah* 705, *yes* 600, *erm* 277, *wow* 95, *ah* 83, *eh* 68, *aha* 41 — **"uh-huh" does not appear in the top 40**. 23.0% of turns are backchannel-only. 36% of transitions overlap. Real floor transitions (backchannels excluded, n=808): **median +200ms, p75 +940ms, p90 +1860ms.**

**Real but weakly sourced — label as inferred, act only because the changes are cheap and reversible.**
- Requests: "social distance and power relationship systematically determine the choice of requesting strategies in British English; they play no role in Nigerian English" — Gut & Unuabonah 2022 (verified). The further step to "so a plain refusal is less face-threatening" is **my inference, not measured**, and it concerns how callers *request*, not how refusals land.
- Empathic *sorry* as sympathy (calqued on *pele* / *ndo* / *sannu*): well attested as a nativised feature; the citation available is a blog post. **Do not cite OED for it** — the January 2020 Nigerian English release added *sef*, *next tomorrow*, *okada*, *danfo*, *mama put*, *K-leg*; sympathy-*sorry* is not confirmed among them. Related and real: Unuabonah, "Apologising in Nigerian English", *World Englishes* ([weng.12729](https://onlinelibrary.wiley.com/doi/10.1111/weng.12729)).
- Syllable-timed rhythm: [Oyebola, "Sociolinguistic variation in the rhythm of Nigerian English speech", *World Englishes*](https://onlinelibrary.wiley.com/doi/10.1111/weng.12733) — nPVI-V/VarcoV across Hausa, Igbo, Yoruba vs BrE. Real; the intelligibility percentage sometimes attached to it is unverified. Consequence for us is only: **measure chars/sec, don't assume it.**
- Yoruba "response-continuation expressions" licensing extended turns (Fakoya, ACAL 36) — observational, no counts.

### 2.3 Where the Nigerian evidence is genuinely absent — say so out loud

- **No published floor-transfer-offset measurement exists for Nigerian English, Pidgin, Yoruba, Igbo, Hausa, or any West African telephone corpus.** Every millisecond constant in this plan is applied to Nigeria by extension of a claimed universal. The one African language ever measured (Akhoe Haiǁom, +300ms median, Stivers 2009) sits within 250ms of the global mean, and the one cross-cultural test using telephone audio (Roberts, Margutti & Takano 2011, *Discourse Processes* 48(5):331–354) found no group that tolerated delay — so designing to the universal numbers is defensible. It is still an assumption.
- **ICE-Nigeria's phone-call subcorpus is n-of-4.** 7 texts, 21,310 words; 4 dyads supply 91% of annotation units; 12 of 14 speakers male; register is personal/family, not service; only 7 of the 97 ICE-NIG texts are phone calls at all. Telephone-specific tag frequency is **inferred, not measured**.
- **ICE-Nigeria samples educated Nigerian English.** Pidgin frequency on a real service line cannot come from it. `pidgin_mix` under R9.1.3 must come from our own recordings.
- **The per-act length numbers (SPAADIA)** are one agent, "Sandra", at one UK rail company, 34/35 calls with a verbatim-identical opening. Within-agent per-act variation is the robust part. **Label it in the eval harness as "one UK agent, rail bookings" — structure transfers, politeness does not.**

---

## 3. Execution order

Each step leaves `pnpm lint && pnpm typecheck && pnpm test` green on its own and is independently revertible. Live-call probes reference `docs/CALL_PROBES.md`.

---

### Phase A — Measure before changing anything (no caller-perceived change)

**Step 1 — Split the latency metric into three; fix the greeting's phantom warning.**

`orchestrator.ts` currently marks `turn_to_audio` at `onEndOfTurn` (`:584`) and measures it at the first byte of the first *reply* sentence (`:430`) — but `playFiller` (`:294-310`) sends filler chunks straight to the carrier without touching `bytesSent` or marking anything. **The one metric we have conflates "the caller heard nothing" with "the caller heard Mm-hm and is still waiting."** Those are different products.

Replace with three stages:
- `turn_to_sound` — marked at `onEndOfTurn`, measured at the first audio byte **of any kind**, so add a `measure()` inside `playFiller`.
- `turn_to_content` — the existing measurement, renamed, so filler can no longer mask it.
- `eot_detection_lag` — carry `TurnEvent.offsetMs` from the `onEndOfTurn` payload into the log line, so `turn_to_sound` can be reconciled against true end of speech later. Everything above is anchored to the *detector's* event, which lags real end of speech; R9.1.6 is where that lag becomes a number we own.

Also: in the uncached greeting branch (`:891`), `enqueue` → `speakNext` → `startByte === 0` → `measure("turn_to_audio")` against a mark that was never set, emitting `"latency mark missing"` by construction on every cold boot. Skip the measure when `seq === 1`. A warning that fires by design trains everyone to ignore the warning.

And extend the `agent turn` log at `:769`: add `words`, `audioMs: Math.round(durationMs(current.bytesSent, stream.format))`, `action`, `budgetWords`. Since `eval/` does not exist and CLAUDE.md rule 0 says it must never import the monorepo, **the log line is the entire implementable deliverable** for offline scoring.

*Proof:* unit test that `turn_to_sound` fires from a filler with no reply audio; one live call showing three latency lines per turn and zero `latency mark missing`.

**Step 2 — A real stop reason. Stop speaking half-words to callers.**

`packages/providers/llm/src/types.ts`: `onDone(listener: (result: { readonly text: string; readonly truncated: boolean }) => void)`. Set `truncated` from the vendor `finish_reason` inside `packages/providers/llm/src/openai/openai-llm.provider.ts` — the vendor field stays in the adapter, per CLAUDE.md rule 2. In `orchestrator.ts` `onDone`, when `truncated` is true, **discard the tail unconditionally** and log `turn truncated`, replacing the `tail.length < 15` heuristic at `:762` which lets any longer mid-sentence truncation through to the caller.

*Proof:* a fake completion whose `finish_reason` is `length` produces no tail audio (`orchestrator.test.ts`); live call B2/D4 — no reply ends mid-word.

**Step 3 — Measure chars/sec once, at boot, per voice.**

Three unmeasured constants currently drive different decisions in the same file: 13 (`:119`), "~15" (a comment), "~17" (`:728`). `CHARS_PER_SECOND` is used only in `heardText()` to estimate how far into a still-synthesising sentence the caller got — and if the real voice is *slower* than 13, the estimate over-credits and the agent records words the caller never heard, then references them. That is precisely the failure CLAUDE.md names under "Barge-in changes context". The comment claiming it under-credits is an assumption.

`createAudioCache` (`prerender.ts`) already renders fixed text per voice and returns the chunk array; `@ansa/tts` already exports `durationMs`. Add a `measureRate` step in `warmAudio()`: render one fixed ~200-word script per configured `voiceId`, sum chunk bytes, `charsPerSecond = script.length / (durationMs(bytes, format) / 1000)`. Thread it as `readonly charsPerSecond: number` on `OrchestratorDeps`, use it in `heardText()` with a deliberate ×0.9 margin so it still under-credits. Delete the "~17 characters per second" comment when step 8 removes the literal.

Cost: one extra render per voice at boot, zero per-call latency, no vendor type crosses a boundary. This is the prerequisite for the budget's `targetMs`.

*Proof:* boot log `"measured speaking rate"` with the number; unit test with an injected rate.

---

### Phase B — The Nigerian inbound token sets (cheapest change, three live defects fixed)

**Step 4 — Fix the three token-set defects and add the Nigerian inventory.**

All in code that already exists, all governed by rules the file already reasons about.

*(a) `hearing.ts` — add a pure `stripTurnFinalTag` inside `interpret`.* Emit the tag alongside `forModel`, leave `raw` untouched (the raw/forModel split R9.2.3 depends on is already this file's shape, so this is additive). Tag set ordered by ICE-NIG corpus frequency: `you know`, `now`, `na`, `ok`/`okay`, `o`, `sha`, `abi`, `ehn`, `ehen`, `ba`, `or`, `isn t it`; `shey` turn-initial. Return `{ tag: string | null }` on the speech branch so the classifier can read it.

*(b) `orchestrator.ts:216-227` — two real defects in `REPAIR_ALONE`.*
- **Remove bare `"sorry"`.** In Nigerian English *sorry* is a sympathy token, not an apology. Today: agent refuses → caller says "sorry" meaning *that's a shame* → `isRepairRequest` fires before any model call → `repeatLast()` → the agent re-says the refusal the caller heard perfectly. Keep `sorry what`, `pardon`, `pardon me`, `come again` — those carry the repair reading unambiguously.
- **Gate `"eh"`.** It is in `REPAIR_ALONE` (`:224`) and not in `BACKCHANNEL` (`:236`). A caller saying *eh* / *ehen* as a Yoruba-register continuer while the agent is speaking falls past the backchannel check at `:803` and lands on the repair branch at `:824`, so the agent re-says its previous utterance. Either move it to `BACKCHANNEL` or gate the repair reading on `turn === null`. **Leave `"huh"` alone** — it is deliberately in both, and the split is correct: `BACKCHANNEL` is only consulted while `turn !== null`, so *huh* during agent speech is listening and *huh* in silence is repair.

*(c) `orchestrator.ts:235` — extend `BACKCHANNEL`* with the measured Nigerian inventory: `ehen`, `eh heh`, `ehen now`, `na so`, `no wahala`, `okay o`, `oya`, `yes now`, `correct`, `true`, `oh ho`. The existing gate stays: these count as backchannel only while `turn !== null`.

*(d) New `NIGERIAN_PARTICLES` set*, whole-utterance match, checked **before** the repair check: `o`, `sha`, `abi`, `sef`, `ba`, `no be so`, `na so`. Backchannel when `turn !== null`; logged noise when the floor is free. Today a bare particle falls through to `respondTo()` and burns a full LLM turn answering a token with no propositional content — and *o* alone is 10.6% of all question tags in ICE-Nigeria.

*(e) Pidgin repair, into the existing two tiers.* `normalise()` strips punctuation, so match the flattened forms. `REPAIR_ALONE`: `wetin`, `you say`, `come again jare`. `REPAIR_PHRASES` (substring, must be distinctive): `wetin you talk`, `wetin you say`, `talk am again`, `say am again`, `abeg say am again`, `i no hear you`, `i no hear`. Apply the file's own discipline from the `:201-204` comment: *wetin* alone is a repair, *"wetin be my balance"* is a question — which is exactly why it goes in `REPAIR_ALONE` and not `REPAIR_PHRASES`. This unlocks the 291ms model-free `repeatLast` path — measured as the best-performing path in the system — for a caller who repairs in Pidgin, which today is unreachable.

*(f) Conserve length in `repeatLast` (`:661-682`).* Replay only the **first sentence** of `lastUtterance`, split with the existing `createSentenceBuffer` so there is one sentence-boundary implementation. Dingemanse's 1.2:1 conservation ratio. No model call — that is what preserves the speed. Add a consecutive-repeat guard: on a *second* repair against the same `lastUtterance`, route to the model with a "say the same thing differently and shorter" instruction, because a verbatim loop is what a caller reads as a machine.

*Proof:* one unit test per token in `hearing.test.ts` / `orchestrator.test.ts`; specifically — agent refuses → caller says "sorry" → assert **no** `repeatLast`; caller says "eh" during agent speech → assert ignored, not repeated; caller says "abi" in silence → assert no LLM call; caller says "wetin you talk" → assert `repeatLast`. Live: one call with a Nigerian speaker using *ehen*, *na so*, *abi*.

**Step 5 — The greeting.**

`greeting.ts:10` is verbatim `"Thank you for calling Ansa. How can I help you?"` — a US script. Two of the four opening components the corpus shows in 34/35 calls are missing: the time-of-day greeting and the agent's name. Reciprocal greeting is close to obligatory in Nigerian institutional telephone talk.

Extend to three variants keyed on WAT time of day, each carrying an agent name: `"Good morning, thank you for calling Ansa. This is Ada. How can I help you?"` and afternoon/evening. Pre-render all three at boot through `createAudioCache` — still fixed text in a fixed voice, so the determinism argument in `prerender.ts:4-16` holds unchanged; the cost is three renders instead of one and zero per-call latency. Keep the terminal question: `greeting.ts` documents that it exists so end-of-turn detection has a complete clause to commit against, and that reasoning is still right.

*Proof:* `greeting.test.ts` covers variant selection at fixed clock values; boot log shows three pre-rendered phrases; live call — the greeting names the time of day.

---

### Phase C — The budget (the core change)

**Step 6 — `action.ts`, pure, unwired.** Classifier only. Green trivially; it is dead code until step 8. Seed the test cases from the labelled caller turns R9.1.3 already requires rather than from intuition.

**Step 7 — `turn-budget.ts`, pure, unwired.** The table from 1.3 plus `promptFor(action)`. **One test that must exist:** assert every action's fragment and its budget agree — no action asking for "at most one clause" while budgeting 55 tokens, none budgeting 8 tokens without a fragment telling the model to be that short. That mismatch is exactly how a length cap turns into a truncation bug.

**Step 8 — Wire it.** The three edits in 1.4. Delete the `maxTokens: 45` literal and its comment at `:725-730`; keep `MAX_SENTENCES_PER_TURN` deleted in favour of `budget.maxUnits`. **`statement` and every unmatched input keep 22 words / 2 units / 48 tokens**, which is approximately today's behaviour — so this commit can only change turns it positively classifies.

Prompt fragments, in the file's existing spoken register:
- `polar`: *"Answer yes or no first. One short sentence, under six words. Do not restate the question."*
- `wh`: *"Give them the one fact they asked for. A phrase is a complete answer here — you do not need a full sentence."*
- `explanation`: *"Say how many steps there are, then give the FIRST one and offer the rest. Do not give the whole procedure in one turn."*
- `troubles`: *"Say sorry — that means sympathy here, not fault. Then ask one question."*
- `readback`: *"One item per turn. End on a short tag — okay? right? — never isn't it?"*

*Proof:* orchestrator tests asserting the budget reaches `deps.llm.complete` and the cap fires at the right sentence for each action. Live call, two questions back to back: "Is my policy still active?" must come back under ~2s of audio; "How do I make a claim?" must come back as *one step plus an offer*, not a monologue and not four words. Then B1, B2, D4 and D5 from `CALL_PROBES.md`.

**Step 9 — `call-state.ts` and the escalation branches** (section 1.6). Stage 1 fields only: `goal: string | null`, `repeats: number`. Defer `refused[]` and `told[]` until stage 1 has been measured on a real call — rendering state into the prompt is prose, and prose can be ignored; only the `>= 2` and `>= 3` branches are enforceable, so build those first.

*Proof:* test that two repair requests do **not** increment `repeats`; test that two paraphrases of the same request do; test that `repeats >= 3` produces the transfer offer. Live: ask the same unanswerable thing three times (probe D2) — the three replies must be different in *action*, not just wording, and the third must offer a person.

---

### Phase D — Timing (the cheap half; the expensive half is section 4)

Do **not** sequence the length work behind this. Reply length is a bounded change that ships this week; the gap bottoms out at three serial Nigeria-to-US round trips that `docs/STACK_DECISION.md` flags as possibly requiring a different provider topology entirely. Bögels 2015's compounding argument is an argument for doing both in parallel, not for ordering them.

**Step 10 — Retime the filler tiers. In this order, because the naive version makes things worse.**

`playFiller` pushes the entire pre-rendered phrase into the carrier in one synchronous loop, and `cancelFiller` only clears *timers* — once chunks are sent they are committed to the carrier's play-out queue. Several tier-1 phrases are long: `"Alright."`, `"Got it."`, `"I see."` run several hundred milliseconds. **Firing at 250ms when the reply's first byte lands at 600ms means the caller hears the acknowledgement and then waits behind it — `turn_to_content` gets worse.** So:

1. **First, budget tier 1 by measured audio duration.** `prerender.ts` already returns the chunk array at boot and `@ansa/tts` already exports `durationMs`. At wiring time in `media.gateway.ts`, partition `ACKNOWLEDGEMENTS` into a SHORT pool (rendered duration under ~350ms) and demote the rest to tier 2. Pass only the short pool as `fillerTiers[0]`. *An acknowledgement longer than the gap it covers is not a mask, it is a second gap.*
2. **Then** move `DEFAULT_FILLER_AFTER_MS` from 450 to 250 (`orchestrator.ts:122`). Justification: 51–55% of human telephone transitions complete under 200ms, so 450 fires *later than a human would simply have answered* — it occupies the gap rather than masking it. Note the effective first-sound latency is 450 **plus** the detector's EOT lag, which step 1 now measures.
3. **Keep tier 2 at 2200ms** — Shiwa's ceiling, where ratings level off — and **move tier 3 from 4500 to 3500ms**, since Wu et al. put the degradation cliff at 4s and firing at 4500 is *after* the point of rescue. `STILL_WORKING` is the right register for it.
4. **Suppress tier 1 on `polar`, `readback`, `greeting`, `closing`.** A content-free "Mm-hm" occupying the gap before a plain yes/no is the hesitation particle CA lists as a dispreference marker — on those turns it manufactures the reluctance a fast answer would have avoided. **Arm it correctly:** the tier-1 timer moves into `respondTo` where the action is known, but its deadline is computed from the end-of-turn timestamp, not from `respondTo` entry, so a slow transcriber cannot push it late. The unconditional 2200/3500 tiers and the transcript watchdog (`:594`) **stay at `onEndOfTurn`** and must never depend on a transcript — the case they exist for is the transcript never arriving.
5. **Rate-limit the behaviour, not just the phrase.** `createFillerPicker` avoids repeating a phrase but never the *behaviour*. Extend it to suppress tier 1 when tier 1 also fired on the immediately preceding turn. Two "mm-hm"s in a row is what reads as a machine; one every other turn does not.

**Do not adopt the "humans only do this on 5% of turns, so cut ours 20×" framing.** Humans produce a working-signal on 5% of turns *because their gaps are modally 0–200ms* — they have nothing to cover. Ours are 968–1532ms. The correct target is "cover every gap that exceeds tolerance", which is currently most turns.

*Proof:* `filler.test.ts` for the duration partition and the consecutive-turn suppression; orchestrator test that no filler plays when `tts_first_byte` lands under the threshold. **Live probe A3 (pause mid-thought for two seconds): confirm no filler audio lands inside the pause** — `fillerAfterMs` is already injectable via `OrchestratorDeps`, so this is tunable without a redeploy. Then compare `turn_to_sound` p50 against the 700ms hard-fail line.

**Step 11 — Swap the filler inventory to the measured Nigerian tokens.** Tier 1 becomes `Mm-hm.` (top token by 2.3×), `Okay.`, `Yes.`, `Ah.`, `Eh.`, `Aha.`; drop `Right.`, `I see.`, `Sure.`, `Got it.`. **Before merging, listen to each token through the Nigerian ElevenLabs voice at 8kHz.** `Aha.` and `Eh.` are the ones likely to synthesise badly, and a token that renders wrong is worse than the American one it replaced. Everything in the pool is spoken, so it routes through `deps.forSpeech` like all other output.

**Step 12 — Zero-LLM fixed responses.** Extend the `repeatLast` pattern (`:661`) into a `sayFixed(text)` helper — identical turn scaffolding, `llmDone: true`, routed through `enqueue` so it is normalised, marked and remembered like any other utterance. Drive it from `classify()` for exactly one case now: **`greeting` on the caller's first turn** plays a pre-rendered greeting-return before handover instead of routing a "good afternoon" to the model as business. Feed the pre-rendered map in alongside `deps.fillers` as a `ReadonlyMap<string, readonly AudioChunk[]>` and reuse the existing pre-rendered-greeting playback block at `:867-887`.

**Do not fast-path confirmations, readbacks or yes/no answers.** A wrong fast-path answer to a confirmation is a wrong-number-confirmed-correct event, which R9.3.4 makes a launch blocker. That trade is the wrong way round.

*Proof:* test that a greeting first turn makes zero LLM calls; live call — say "good afternoon" first and watch `turn_to_content` land near the 291ms the repeat path already achieves.

---

### Phase E — The prompt (soft layer, lands last)

**Step 13 — Rewrite `system-prompt.ts`.**

- **Delete "Around 12 words"** (`:15`). A single target is what produced uniform ~20-word replies; the stable ICE-NIG phone median is 7 words with 42% at ≤5. Replace with a licence for the short end: *"Yes." / "It's covered." / "Tomorrow." are complete replies.* Length guidance now arrives per turn from `budget.instruction`.
- **Replace the refusal line** (`:28-29`). Across 19 non-granting turns in the SPAADIA corpus, **0 are a bare "I can't help with that"** — every one names a concrete reason and several attach the alternative in the same turn. (The "19/19 contain a mitigator" statistic is circular — the regex that selected those turns *was* the mitigator list, and several selected turns carry no mitigator at all. Do not quote it.) New line: *"When you cannot do something, never just say so. Name the specific reason, then say what you CAN do, in the same turn. Never give the same refusal twice — if they ask again, it means the first answer did not land, so do something different."*
- **Add: lead the call.** SPAADIA agent turns contain a question 38.9% of the time (654/1681) against caller turns at 13.5% — 2.92×. Ansa is near 0%; nothing in the prompt asks it to ask. *"You lead the call. If you need something from them to help — a policy number, a date, a name — ask for it. Do not wait to be asked."* Log a boolean per agent turn for whether it ends in `?` and target 38.9% in the harness.
- **Add three Nigerian register lines:** a greeting is returned before business is discussed; *sorry* when the caller reports a problem is sympathy, not fault; Pidgin input gets an English reply in the same register, shorter and less formal, **and the agent never attempts Pidgin itself** — a model producing bad Pidkin at a Nigerian caller is worse than any formality problem it solves, and PRD defers Pidgin generation to Phase 3.
- **Add the invariant-tag rule:** *"When you read a detail back, end with a short tag — okay? right? Never isn't it?, wasn't it?, don't you? — those mark you as foreign here."* Invariant forms are ~97.5% of question tags in ICE-Nigeria.
- **Protect politeness from the budget:** *"Do not cut please to save words."* Politeness here is lexical, not syntactic — buy it with a greeting, an address term and a clean hand-back, not with hedges that cost words.
- **Sir/Ma is per-organization, Slice 7.** Do not hardcode it. Register varies by industry.

**Flag honestly in `TASKS.md`:** CLAUDE.md requires an eval-harness rerun on any prompt change with number accuracy blocking merge, and `eval/` still does not exist. This is the second prompt rewrite shipped without that gate. **Gate A must re-check the contraction rule against the naira and policy-number rules** — that interaction is the one most likely to have broken silently.

*Proof:* live call — probe D2 (ask something it cannot know) must produce reason + alternative, and asking twice must produce two *different actions*. Question-rate metric from the new log field.

**Step 14 — Docs, one commit, no code.**
- `docs/STACK_DECISION.md`: record the corrected ICE-NIG floor-transfer figures (median +200ms, p75 +940ms, p90 +1860ms, backchannels excluded, n=808) next to the PRD 5.5 target, and state plainly that **our 968–1532ms gap is inside the human p75–p90 band, so latency is not where the "doesn't feel human" complaint comes from.** Add the Stivers 2009 spread (~460ms total documented cross-cultural variation, Japanese +7ms to Danish +469ms) as the cited rebuttal to any "Nigerian callers are relaxed about pauses" argument.
- `PRD.md` §5.5: split the single row into two. *Caller stops speaking → caller hears ANY agent audio* — **< 300ms p50, hard fail > 700ms** (reachable today via the filler path; cite Roberts & Francis 2013 and Kendrick & Torreira 2015 for why 700). *Caller stops speaking → agent starts speaking CONTENT* — < 800ms p50 / hard fail > 1.5s p95, **unchanged**, gated on the architectural decision. Do not move 800 to 700; against a measured 2.0–2.2s both are equally unmet and the change buys nothing.
- Add `p50 turn_to_sound > 700ms` to R9.2.1's automatic post-call failure heuristics, alongside "silences over 2s".
- Add **repair rate per call** as a first-class heuristic and **alarm on its absence as well as its excess** — at one other-initiated repair per 1.4 minutes, a four-minute call should show ~3, and zero across a corpus means the detector is missing them.

---

## 4. What NOT to build

**Out of slice — belongs to a later one, and building it here creates the exact structure CLAUDE.md forbids:**

- **Anything in `packages/normalizer` (Slice 4).** The Nigerian register rules in step 13 are prompt lines, not normalizer rules — the normalizer is pure text-to-speech-form and semantic register is not its job. Do not move the `An-Sah` respelling out of `greeting.ts` yet either.
- **Number capture, readback confirmation, DTMF (Slice 4, R4.3.1–3).** The `readback` budget tier exists; the capture flow does not, and R4.3.3 needs telephony work that does not exist. **Promising a keypad the pipeline cannot read is worse than not offering it.**
- **`transfer_to_human`, `end_call`, `search_knowledge_base` (Slice 5).** `repeats >= 3` speaks an offer of a human. It does not transfer. `end_call` is a named internal tool in PRD §5.1 and implementing a closing path in the orchestrator now would be the second dispatch path CLAUDE.md forbids.
- **Tool-specific holding speech (Slice 5, R5.4.2).** "Let me check that policy number" instead of "one moment" is right — 83% of human working-signals name the object — and it is unimplementable with no tool registry. Record it as the acceptance criterion for R5.4.3: **the summarisation target is the turn budget in words, a number, not the word "short".**
- **Re-budgeting tool output for speech (Slice 6).** Same reason.
- **Per-organization persona, Sir/Ma, Pidgin-permitted flag, per-organization keyterms (Slice 7).** A bank will forbid Pidgin where a logistics firm requires it. This cannot be a default persona trait and it cannot be a hardcoded constant.
- **The refusal-shaping "dispreferred turn" structure.** There is nothing to refuse until the `irreversible` risk tier exists in Slice 5. When it does, it is a fourth prompt fragment plus a deliberate pause — not a special case in `respondTo`.
- **The closing sequence.** Schegloff & Sacks 1973: closings are a multi-turn sequence (arrangement → pre-closing token → assessment → appreciation → terminal), never one turn, and hanging up on the pre-closing is the named failure. Record two constraints in `TASKS.md` under Slice 5, do not open code: (i) `end_call` is a *sequence* that waits for the caller's response before the terminal exchange; (ii) **the arrangement turn is one of the few places an agent legitimately runs 20+ words, so it needs its own budget tier** — a flat cap makes the closing curt exactly where length is warranted. One thing IS free now: the listen-failure path at `:611-625` speaks `RECOVERY_LINE`, which is a repair prompt, not a farewell. Give it its own line — *"Sorry, the line is breaking up. Please call us back."* — so the one abrupt-termination path a caller actually reaches ends in an arrangement.

**In slice but risk exceeds benefit — do not build:**

- **Eager end-of-turn speculation.** `TurnSession` already declares `onEagerEndOfTurn` and `onTurnResumed`, both adapters wire them, and the orchestrator subscribes to neither — the largest unexploited latency lever in the repo. It is also the one where getting it wrong is worst: CLAUDE.md is explicit that speculation which cannot be retracted makes things worse, and `STACK_DECISION.md` already documents a **false end-of-turn splitting a 10.3s utterance at a thinking pause**. Adding eager EOT on top of a detector that already over-fires would multiply that. Set the Deepgram `eager_eot_threshold`, gate the whole path behind a dep flag, **measure retraction rate against R9.1.6 first**, and only then enable. Not this slice.
- **Inserting a deliberate ~400ms silence at the first transition-relevance place.** The premise (one TCU per turn) is sound; the mechanism is wrong here. A gap invites both echo-VAD firing — `DEFAULT_BARGE_IN_GUARD_MS = 400` exists because on a live call *every* agent turn was barged-in at `charsHeard: 0` by the handset echoing our own audio — and R6.2's dropped-call reading. Waiting for a caller backchannel cannot work either: end-of-turn fires 480–1200ms *before* the transcript. **The safe version, deferred behind data:** `current.sentenceAudioAt` is reset on the first audio byte of *every* sentence (`:423`), so the 400ms echo guard re-arms at each boundary and an interruption in the first 400ms of sentence two — precisely where a human is licensed to take the floor — is discarded as echo. Add `budget.yieldAfterFirstUnit` and drop the guard to ~150ms there for the `explanation` tier only. Do this **after** step 8 is on a real call, not with it.
- **A phase state machine on `createConversation`.** The claim that "the orchestrator is stateless across turns" is false — `conversation.messages` carries full history and is passed on every call at `:725`. It is stateless with respect to *phase*, which is much narrower. The behavioural outcome (agent leads, asks questions) is reachable from step 13's prompt line. Revisit only if the question-rate metric stays low.
- **Pidgin keyterm boosting, right now.** Boosting `wetin` on an English model can pull *we didn't* toward it, and `hearing.ts` `CORRECTIONS` would then "repair" the wreckage in the wrong direction. **Measure first:** make R9.1.3's `pidgin_mix` label emit from the review loop and count how often it fires on real traffic. That number does not exist in the literature and decides whether the rest is worth anything. Then add a small batch (`abeg`, `wetin`, `no wahala`, `oya`, `na so`, `how far`) behind an eval regression and keep only what does not hurt non-Pidgin WER. **Drop bare `na` and `dey`** — too collision-prone at 8kHz (`na` hits *name*, `dey` hits *they*) — and any code-switch detector must be word-boundary matched and require **two distinct markers** before switching register.
- **A repair ladder over `RECOVERY_LINE`.** The idea is right — Dingemanse's specificity principle says use the most specific initiator available, and per-word confidence genuinely reaches the orchestrator (`Transcript.words[].confidence`, live range min 0.491) and is genuinely discarded at `:785`. But `RECOVERY_LINE` is spoken from **four** call sites (`:598`, `:616`, `:717`, `:781`), and three of them are infrastructure failures with no transcript and therefore no fragment to target. Building the ladder over the shared constant would make an LLM timeout say *"the number, or the name?"* — a lie about what went wrong. The prerequisite is renaming it to `FAILURE_LINE` and splitting the comprehension path off, which is a clean but separate commit. Next slice, and it must consume step 9's counter rather than adding a second one.

---

## 5. Gate A corpus shopping list

Licence status verified against the Hugging Face API, the LDC catalogue, SADiLaR and varieng.helsinki.fi on 2026-08-08. **Everything below lives in `eval/` as standard-library Python, zero dependencies, and never imports from the monorepo** (CLAUDE.md rule 0).

**Send these two access requests today — manual approval has latency:**

| dataset | licence | why it is the priority |
|---|---|---|
| `intronhealth/afri-names` — HF, **gated=manual** | CC BY-NC-SA 4.0 | 8.92h of numbers and African named entities. A direct instrument for PRD Tier 1 exact-match number scoring (R9.1.5) and for proving R4.1.3 keyterm boosting **on names**, rather than on the word "policy". |
| `intronhealth/med-convo-nig` — HF, **gated=manual** | CC BY-NC-SA 4.0 | Nigerian teleconsultation; conversational, Nigerian, service-register. Nothing else in the list is all three. |

In the same message to Intron: ask about the **Afro-Call-Centers** pipeline. 0.80h is unusable as a test set, but they are the obvious design partner for R9.1.2 option 1.

**Pull today, no gate:**

| dataset | licence | use | caveat |
|---|---|---|---|
| `intronhealth/afrispeech-dialog` | CC BY-NC-SA 4.0 | The conversational arm. Downsample 44.1kHz → 8kHz μ-law and add to `eval/corpus/`. Gives the harness something to run on day one. | Card says ~7h / 98 participants; the NAACL paper abstract says 6h / 64. Neither changes any action. |
| `intronhealth/afrispeech-200` | CC BY-NC-SA 4.0 | **Read-aloud CONTROL only.** Report it as a control so nobody quotes its WER as our number. | 44.1kHz read speech flatters a stack. |
| **ICE-Nigeria** ([varieng.helsinki.fi/CoRD/corpora/ICE-NIG](https://varieng.helsinki.fi/CoRD/corpora/ICE-NIG/)) | **CC BY-NC-SA 3.0 Germany** — NonCommercial; "permissions beyond the scope of this license may be available upon request" | The wideband-vs-narrowband A/B that `STACK_DECISION.md` currently cannot answer, because every probe so far used TTS. Score each transcriber twice — native rate and downsampled to 8kHz μ-law — and report the delta. | **Email Ulrike Gut at Münster before any result reaches a deck.** 5 of 7 phone calls are Skype (wideband, not GSM/PSTN); 4 dyads = 91% of annotation units; 12/14 speakers male; register personal, not service. **Does not satisfy R9.1.1.** |
| **CallHome English** (TalkBank) | free | American 8kHz control, so Nigerian WER reads as a gap rather than an absolute. | — |
| **Lwazi English** (SADiLaR) | **CC BY 2.5 South Africa — commercial use permitted** | The only permissively-licensed African-English telephone audio. **Licence-clean sanity floor** whose numbers can appear in a commercial deck with no permission email. | Read/prompted, not conversational. It exists only at telephone bandwidth, so it **cannot** be used for the wideband A/B — that experiment is ICE-Nigeria's. |
| **UD_Naija-NSC / DiscoNaija** | verify (UD is typically CC BY-SA 4.0) | Text only. Source for the Pidgin marker list; 11,344 discourse relation annotations over 140,859 words. | Text, not audio. |

**Ask, then decide:**

| dataset | licence | note |
|---|---|---|
| **LDC2019S16** — IARPA Babel Igbo conversational telephone speech, ~207h, 2014-15, Owerri/Onitsha/Ngwa, speakers 16–67, mobile + landline, 8kHz 8-bit a-law SPHERE + 48kHz PCM | three LDC agreements, **fees behind login** | Ask for the non-member fee before assuming affordability. If it lands, it is the only large sample of what our carriers' channel actually does to Nigerian voices, and it is directly useful for code-switching under R9.1.3 even though the target language is Igbo. |

**SPAADIA** (UK rail, agent "Sandra"): keep for *structure* only. Label it in the harness as **"one UK agent, rail bookings"**. Structure transfers; politeness does not.

**And the one that actually closes Gate A:**

> **R9.1.1 is a recording task, not a sourcing task.** Nothing above supplies 30 minutes of genuine two-sided Nigerian service-call audio over a real Nigerian line. ICE-Nigeria and afrispeech-dialog now cover the baseline and disfluency arms, so **spend the entire recording budget on what nothing else supplies**: Nigerian callers, Nigerian service intents, over a real Nigerian line, Wizard-of-Oz per R9.1.2 option 2. The two-day cost in PRD §9.1 stands. Write this into `TASKS.md` so nobody spends the two days searching instead.

**Two additions to the R9.1 spec while it is still being written:**
- Amend R9.1.3's label set so every Tier-2 corpus turn carries **adjacency-pair type plus caller and agent turn length in words AND seconds**. Every word count in section 1.3 is currently fitted to American, German and British data; without this the tiers are guesses with citations attached.
- R9.1.6's turn-taking scorer must emit the full human-to-human **floor-transfer-offset distribution** — mode, median, mean, p95, SD, % overlaps — computed between the human-labelled boundaries the requirement already mandates, reported in the shape of Roberts, Torreira & Levinson 2015 Table 1 so it is directly comparable to Switchboard's 187/168/169/448ms. **This is how the biggest open assumption in the plan becomes a number we own.**
- Record the **merge-gap sensitivity** in the eval README. Median words and the ≤5w/≤10w buckets are stable across turn-merge parameters (4/7/8/8/9 words at 0/500/1000/2000/4000ms), but p95 swings 3.6× (13/21/39/45/47). **Score on the stable statistics** — share of agent turns ≤5 words (target ~42%) and ≤10 words (~73%) on ICE-NIG phone calls — and **do not run a KS test against the full distribution**, because KS is dominated by the tail and the tail is the part that moves.

---

## 6. What this plan cannot fix

The user asked how much of the un-humanness is timing and how much is the agent having nothing to do. Here is the honest answer.

**The recorded call contained a caller rephrasing the same request four times.** Not one of those four would have been prevented by anything in phases A–E. The agent has no knowledge base, no tools, and no way to look anything up; `search_knowledge_base` is Slice 5 and knowledge-base ingestion is Slice 7. When a caller asks *"how do I make a claim?"*, a correctly-budgeted, correctly-timed, correctly-Nigerian agent produces a fast, short, well-registered **non-answer**. The caller still rephrases.

What this plan does to that specific failure is change its *shape*, and that is worth doing:
- Today the caller gets the same non-answer three times, which is the one thing the SPAADIA corpus never contains and which reads as a machine.
- After step 9, the second attempt escalates and the third offers a person. That converts an infinite loop into a bounded one with an exit. **That is mitigation, not a cure.**

**My apportionment — this is judgement, not measurement, and I am labelling it as such:**

| contributor | share of "doesn't feel human" | fixable in this slice? |
|---|---|---|
| Reply length and shape — 4598ms median monologue against a 1227ms human IPU median; no adjacency-pair sensitivity; ~0% of turns ask a question against a human 38.9% | **largest fixable-now** | yes, phases A/C/E |
| Having nothing to say — no KB, no tools, so a well-formed answer does not exist to be short | **largest overall** | **no** — Slice 5 + Slice 7 |
| Nigerian interactional fit — Anglo token sets, three live defects, US greeting, foreign tags | medium; removes specific observed bugs | yes, phase B |
| Timing | **smallest** — our gap already sits inside the human p75–p90 band on the only Nigerian telephone data available | partly; caps out low |

**Two things that follow from that ordering and are worth stating plainly:**

1. **Do not spend the expensive latency budget yet.** The eager-EOT/provider-topology work is real and is tracked as an open `STACK_DECISION.md` checkbox, but it attacks the smallest of the four contributors, and on the measured stage split (~25% STT, ~55% LLM, ~20% TTS) an LLM-only fix caps out around half the gap. The cheap half — filler retiming plus `turn_to_sound` instrumentation — is in this plan. The expensive half waits for Gate A's Lagos round-trip numbers (R9.1.8), which `STACK_DECISION.md` already argues is the criterion most likely to decide the stack, ahead of accuracy.

2. **The 291ms figure needs re-deriving before anything is optimised against it.** `repeatLast` is reached from `transcripts.onFinal` (`:824-828`), strictly *downstream* of the transcript, and `stt_final` alone measures 481–639ms — so 291ms cannot be an end-of-turn-to-audio number. It is almost certainly a `tts_first_byte` reading. It is still true that the model-free path is the fastest thing in the system and that widening it (step 12) is the best latency-per-risk trade available. But correct the number wherever it is recorded, because "the LLM round trip is the whole deficit" is not established by it.

**And the thing to watch after Gate A closes:** the single largest remaining quality gap recorded in `TASKS.md` is transcription accuracy, not the pipeline. Deepgram Flux with keyterm boosting already hears "policy" correctly on a live call where `gpt-4o-transcribe` returned "apology", "puppy" and "why my policy was fired". Everything in this plan is downstream of the transcript. **A perfectly-budgeted reply to a misheard question is still the wrong reply**, and no amount of turn-length work changes that.