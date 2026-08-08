> **READ 2026-08-08.** Nothing here needed wiring. Of the seams it hands to other
> agents: `barged_in_at_ms` is fixed ("Four defects in the turn loop"); the diacritic
> name, the non-numeric entity and the letter-by-letter spelling were fixed by their
> owners before this pass; the TypeORM `[rows, affected]` fix is in packages/db. Still
> open: an identifier said with a pause, confirmed twice in halves.

# Observability — what was wired, and what someone else has to finish

Written by the `observability` agent during a parallel run, so that the seams it could not
touch are written down rather than assumed. Everything listed under **Wired** is live at a
call site; everything under **Not mine** is a defect or a decision for the agent who owns
that file.

---

## Wired

**Scenario tests** — `apps/api/src/scenarios/`. Twenty scenarios plus their parameterised
variants (47 cases), driven through `runConversation` with the orchestrator's own fakes.
`harness.ts` captures the event log the recorder is given and hands it to `scoreCalls`, so
a scenario produces a metric rather than only a pass.

**Metrics** — `apps/api/src/viewer/metrics.ts` (pure) fed by `loadCallRecords`
(`packages/db/src/call-records.ts`, read-only). Rendered at `GET /viewer/metrics`.

**Corrections** — `POST /viewer/:id/corrections` writes `transcripts.corrected_text` and
`corrected_at` via `recordTranscriptCorrection`. The corpus reads back at `GET
/viewer/corpus` (HTML) and `GET /viewer/corpus.jsonl` (the file the eval harness wants).

**Audio retention** — migration `0010_audio_retention.sql` plus
`apps/api/src/retention/`, registered in `AppModule`. Sweeps at boot and every six hours.

---

## Seams another agent owns

**`barged_in_at_ms` is null on every interruption.** `orchestrator.ts`: every mark the
carrier acknowledges calls `commitHeard` → `recordAgentTurn(current, null)`, which clears
`startedAtMs`. By the time `stopSpeaking` runs its own `recordAgentTurn` with the barge
offset, the turn has already been recorded and the second call returns early. The
`barge-in` *event* is correct; the `turns` row is not. Scenario 6 is where it shows.
Owner: `turn-taking`.

**A name with a diacritic is never confirmed.** `capture.ts`'s `nameFrom` filters words on
`/^[A-Za-z][A-Za-z'-]*$/`, so "my name is Zoë" or "my name is Chukwuemeka-Ọkonkwọ" yields
no candidate and the unconfirmed value goes straight to the model. Scenario 5 covers the
names the cue does match; it deliberately does not encode the gap as expected behaviour.
Owner: `entity-capture`.

**Capture never engages for an entity with no digits in it.** `orchestrator.ts` gates on
`parseSpokenDigits(text) !== null` before consulting `worthConfirming`, so "my email is ada
at gmail dot com" and "the amount is forty five thousand naira" go straight to the model
unconfirmed even though `ENTITY_POLICY` marks both as always-confirm. Names are the only
non-numeric entity that reaches capture, via `nameFrom`. Owner: `entity-capture`.

**A name with a diacritic never reaches capture either**, for the same reason as above and
one of its own: `nameFrom` filters words on `/^[A-Za-z][A-Za-z'-]*$/`, so "my name is Zoë"
yields no candidate. Scenario 5 runs twelve names from as many traditions and deliberately
stops at the ones the cue matches.

**An identifier said with a pause is confirmed twice, in halves.** The continuation wait is
skipped while a capture is running — correctly, so a correction is never made to wait — but
that means "my reference is A B four…" / "…one seven two" produces a readback of `AB4` and
then a readback of `172`, and neither is the reference. Owner: `entity-capture` with
`turn-taking`.

**Spelling a name letter by letter does not complete the capture.** After two rejections the
name goes to the spelling state, and "S I O B H A N" is not accepted as a spelling — the
agent asks for a word per letter and then escalates. Owner: `entity-capture`.

**TypeORM's Postgres driver returns `[rows, affectedCount]` from UPDATE and DELETE**, not
rows. `rows.length > 0` on that is always true. It made a cross-tenant correction that RLS
had correctly refused report success, and it will do the same to any other `update …
returning` in this repo. `recordTranscriptCorrection` now selects first and updates second,
inside one tenant-scoped transaction. Anything else writing an UPDATE here should do the
same or ask for the structured result.

---

## Migration

`packages/db/migrations/0010_audio_retention.sql` has been applied to the development
database with `MIGRATION_DIRECT_URL`. It adds four `security definer` functions in the
`app` schema — `expired_call_audio`, `known_call_ids`, `min_audio_retention_days`,
`purge_expired_audio_segments` — for the same reason `0009` needed one: a retention sweep
has no tenant, and RLS shows an unscoped connection nothing. They return identifiers and a
count of days; none of them can return a word anyone said.

## Retention, precisely

The sweep deletes a recording when **either**:

- its call is past that call's own tenant's `audio_retention_days`, or
- no `calls` row names it **and** the file is older than the strictest
  `audio_retention_days` any tenant has configured.

A recording belonging to a tenant who chose ninety days survives at forty, which is the
case a naive "older than the default" sweep gets wrong. `audio_segments` rows past their
own `expires_at` go on the same pass, so the column is honoured from the first row that
table ever holds.

Retention cannot be enforced without a database: with `RECORD_AUDIO_DIR` set and no
`DATABASE_URL`, the sweeper logs a warning at boot and does nothing, because there is no
policy to read and deleting on a guess is worse than not deleting.
