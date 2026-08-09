# `eval/` — measurement tooling

Python 3, standard library only, zero dependencies, run by hand. It never imports from the
monorepo and the monorepo never imports from it (CLAUDE.md rule 0). If a build session is
writing Python it is in the wrong place; if a session in here is writing NestJS, same.

Verified on the Python that ships with this machine, 3.9.6. Nothing here needs a key, the
network, or audio.

```
python3 eval/selftest.py          # 54 checks, offline. Run this first.
python3 eval/verdict.py CLAIM.json run1.txt run2.txt run3.txt
```

---

## What this is, and what it is not

**This is not the Gate A harness.** It is the two rules that Gate A would have enforced,
extracted and shipped early because both were broken on 2026-08-08 and both are cheap to
enforce now. The corpus, the per-category breakdown and the WER machinery are deferred —
see the last section for exactly what they are waiting on.

### Rule 1 — nothing is scored against a shape

A caller said **Sikiru**. Six runs out of six — both encodings, through both the harness
and the production adapter — returned **Chike**. The trial that was supposed to catch this
asserted that *a name-shaped token followed "my name is"*. It passed 6/6 while being wrong
6/6. **Ground truth was known and unused.**

So `verdict.py` takes a truth string for every expected item and there is no code path
that scores a hypothesis against a pattern. An expected item with no `truth` is a refusal,
not a skip — the run produces no number at all rather than a number about nothing.

Matching is **exact**, for names and identifiers alike. "Chike" and "Sikiru" share three
characters in the same order; any similarity metric scores that as partial credit, and
partial credit is what hid this for a day. A name that is 60% right is 100% wrong, and so
is a policy number.

Exact does not mean literal. `PM8592625` and `p m eight five nine two six two five` are
the same identifier said by two providers with different rendering habits, and they
canonicalise together. `PM8592624` does not. The canonicaliser also handles "oh" for zero
and "double five" for 55, because callers say those. Every transformation is
format-insensitivity; none of them is value-tolerance.

### Rule 2 — no conclusion from one run

Four provider comparisons on this project were each decided from a single sample and each
reversed by the next run. The most recent enabled `OPENAI_SEND_PCM` in production and
reverted it the same day.

So:

- **Fewer than three trials produces no verdict.** The per-trial observations are printed
  and labelled as observations. The process exits 2, which means *nothing here was
  measured* — distinct from exit 1, which means measured and wrong.
- **Trials that disagree produce no verdict.** The disagreement is printed instead. A rate
  averaged over a disagreement is a number with a shape it has not earned, and the
  instability *is* the finding.
- **A configuration with any of `provider`, `model`, `encoding`, `sample_rate`,
  `language`, `endpointing` missing is refused.** A result without its configuration
  cannot be compared with anything, which is the only thing anyone ever wants to do with
  one.

---

## Running it

`tools/stt-compare/compare.mjs` already paces audio correctly — comfort noise in the
trailing pad rather than `0xFF`, and it awaits `session.updated` rather than sleeping.
Both of those were bugs that manufactured a provider difference that did not exist. It is
left alone; this tool reads its output.

```sh
# three runs, because one is not a measurement
for i in 1 2 3; do
  node tools/stt-compare/compare.mjs recordings/CAa280584f1950d96432524e37c314968d.ulaw \
    | tee eval/runs/$i.txt
done

python3 eval/verdict.py eval/claims/CAa280584f-name.json eval/runs/*.txt
```

`eval/runs/` is gitignored: saved transcriber output is a caller's own words, and the
transcript side of a call does not get an exemption from `recordings/` for being text.

A claim file can also carry its trials inline (`"trials": [...]` inside a configuration),
which is how the self-test drives it and how a transcript from anywhere else gets scored.

**Exit codes:** `0` everything measured and matched, `1` measured and something missed,
`2` refused — nothing here is a measurement.

### Claims that write themselves — the review loop (R9.2.4)

Every claim in this directory used to be hand-written, which is why there is one. Since
Slice 4a the product side emits them: correct a transcript in the internal viewer, then
open **`/viewer/{callId}/claim.json`** and save the file into `eval/claims/`. The
corrected text is the truth, the transcriber's text is a trial, and the six required
configuration keys come from that call's own `call configuration` event rather than from
anybody's memory of what was deployed.

Rule 0 is intact: the exporter is TypeScript
(`apps/api/src/viewer/claims.ts`), nothing here imports it, and the two sides meet at a
file on disk. `apps/api/src/viewer/claims.test.ts` runs *this* `verdict.py` over its output
on every test run, so a change on either side that breaks the format fails a test rather
than a Tuesday.

Three things about a generated claim are deliberately unsatisfying, and all three are this
tool's own rules pointed at production:

- **It refuses at n=1.** One call is one observation. The generated file carries the single
  production transcript as a trial and `verdict.py` exits 2 — padding it to three by
  repeating the string would manufacture the exact agreement the three-trial rule exists to
  detect. Three trials come from re-running a candidate over the audio, which is the same
  `compare.mjs` loop above; the generated claim is what you score them against.
- **Most turns arrive `unlabelled`.** `verdict.py` scores names and identifiers; a caller
  saying "good afternoon, my name is Sikiru" is prose, and the truth for a turn is not the
  truth for an item inside it. Only a turn that is *entirely* a read-out reference, or
  entirely a capitalised name, is offered as `expected`. Marking a span inside a sentence
  needs somewhere to store the span and there is nowhere yet.
- **A configuration field the pipeline never recorded comes out `null`,** which the tool
  refuses rather than scores. Deepgram records no `language`, so a Deepgram claim needs one
  written in by hand before it will produce a verdict. That is the correct outcome and it
  is visible.

`compare.mjs` prints no configuration of its own; it reads `TRANSCRIPTION_MODEL`,
`DEEPGRAM_MODEL`, `DEEPGRAM_EOT_THRESHOLD` and `DEEPGRAM_EOT_TIMEOUT_MS` from `.env` at run
time and says nothing about them. **The claim file is therefore the only record that the
run had a configuration at all.** Check it against your `.env` before trusting a result,
and blank out any field you have not verified — a missing field is refused, which is the
right outcome for a number nobody can reproduce.

---

## What is labelled today, and what is not

`eval/claims/CAa280584f-name.json` covers the one recording whose ground truth is known.

| | |
|---|---|
| **labelled** | the caller's name, `Sikiru`, from the caller and from `docs/STACK_DECISION.md` |
| **not labelled** | the policy number on the same recording. The digits were never written down. |
| **not labelled** | any prose transcript of any recording. |

The four other files in `recordings/` are unlabelled in full:

- `CA10dec56f…ulaw` — 103s of ordinary conversation, no transcript exists.
- `CA6be630e9…ulaw` — 46s, provenance not recorded anywhere in the repo.
- `control-sikiru.ulaw` / `control-sikiru-noisy.ulaw` — synthetic ElevenLabs audio, script
  known (`"Good afternoon, my name is Sikiru. My policy number is P M 8 5 9 2 6 2 5."`).
  **Clean, studio-grade, not Nigerian-accented and not a phone call.** It can hold a
  waveform fixed across runs, which is worth something. It cannot say anything about
  accented speech, and no result from it should be cited as if it could.

**Nothing here was derived from a transcriber's output.** R9.1.4 forbids seeding ground
truth from a candidate, and the reason is immediate: label `CAa280584f` from any of the
six runs available and the corpus would assert the caller's name is Chike. Where truth is
not known, the entry says so and carries the reason. Someone has to listen and write down
what was said; there is no shortcut and the shortcut is the failure mode.

---

## What Gate A still requires — deferred, not dropped

Gate A closes when `docs/STACK_DECISION.md` holds two ranked tables plus Lagos round-trip
figures. None of the following is possible with what exists today, which is five
recordings of **one speaker**:

- **≥30 minutes of genuine two-sided conversational audio, 8–10 speakers** (R9.1.1), mixed
  language backgrounds and line quality, at least two on poor connections and two in noisy
  environments. This is calendar work — recruiting and scheduling — not keyboard work.
- **Every caller turn labelled by category** (R9.1.3): `number_string`, `intent_statement`,
  `disfluent`, `interruption`, `pidgin_mix`, `noisy`, `emotional`. The brief for this tool
  also names `name` and `code_switched`.
- **Ground truth by consensus adjudication** (R9.1.4): run all candidates, accept segments
  where all agree, hand-transcribe only the disagreements. Roughly a third of the manual
  work, and it does not bias truth toward any candidate. It needs at least two candidates
  running over the same corpus, so it needs the corpus first.
- **Human-labelled turn boundaries** (R9.1.6) — true end of speech per caller turn and
  every genuine interruption point — to score end-of-turn latency p50/p95, false-EOT rate,
  missed-EOT rate, speech-start latency and eager-EOT retraction rate. WER says nothing
  about any of these, and the transcriber and turn detector may be different vendors.
- **WER per category for prose** (R9.1.5). Deliberately absent from `verdict.py`: there is
  no hand transcript of any recording to compute it against, so shipping the machinery now
  would be shipping something with nothing to run on.
- **Lagos round-trip latency to every candidate** (R9.1.8). Measured against an 800ms
  budget, hosting region can disqualify a provider on its own, so this is worth doing
  before the scoring work rather than after.

**Why deferred rather than dropped.** Building the corpus format, the category breakdown
and the WER machinery today would produce code that is exercised by nothing until the audio
arrives, while five agents are working on things that ship. The two rules above are
different: they were violated *today*, on the audio that already exists, and they are what
turn the next comparison from an anecdote into evidence. Gate A's own text still applies —
it MUST close before Slice 4, because from Slice 4 onward the normalizer, confidence
thresholds, readback aggressiveness and keyterm strategy are all tuned against one
provider's error profile, and switching after that means redoing all of it.
