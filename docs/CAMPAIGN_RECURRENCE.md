# Recurring campaigns — a sketch

Status: **built 2026-09-06**, as sketched below (migration 0074, `packages/db/src/series.ts`,
three endpoints under `/campaigns/:id/series`, `create_due_runs()` on the dialler's sweep,
and the "Run it again" card on the Schedule tab). Not yet done from the sketch: grouping runs
under their series on the campaigns list. The sketch is kept as the reasoning.

## What is missing

A campaign runs its list once and is `done`. The catalogue we ship says otherwise: rent on
the first, fees before term, premiums monthly, dormant accounts quarterly, immunisation
every six weeks. For all of those the operator's real workflow today is Duplicate → Add
contacts → Start, by hand, every time — which means the campaign that matters most is the
one somebody forgot.

## Two products hide in "recurring", and only one is a campaign

**A. Re-ring the same people on a rhythm.** "Every month, ring everyone on this list about
rent." The list is the campaign's own; each run re-queues the same contacts.

**B. Ring whoever matches a rule when it is due.** "Ring anyone whose lease ends in 30 days."
The list is computed; each run pulls fresh people from a query over contacts and facts.

B is a *trigger*, not a campaign: it needs a rule language, a per-contact "already rung for
this event" ledger, and a source of truth for the facts the rule reads — none of which exist,
and all of which are a different slice. Building A does not close the door on B; B would
sit *in front of* A, filling a run's list from a rule instead of from the last run.

This sketch is A.

## Shape

One new table, no changes to `campaigns` beyond a pointer:

```
campaign_series
  id, organization_id
  name
  every         -- '1 month' | '2 weeks' | '7 days' … an interval, not a cron
  anchor_at     -- the first run's start; each next run is anchor + n * every
  window        -- how long each run may take; the run's ends_at = starts_at + window
  template_id   -- the campaign whose words, window, pace and list each run copies
  paused_at, ended_at
  next_run_at   -- materialised, so the sweeper reads one column

campaigns
  series_id     -- null for a one-off; set on every run the series created
  run_number
```

A **series** owns nothing a caller reads. Each run is an ordinary campaign, created by the
sweeper the way `duplicateCampaign` creates one today, with `starts_at`/`ends_at` set, and
then handed to `start_due_campaigns` like any scheduled campaign. Everything downstream —
the dialler, the brief, the outcomes, the page — already works on a campaign and does not
learn the word "series". That is the whole reason to do it this way: the run *is* a
campaign, so nothing that proves a campaign works has to be proved twice.

**The list.** A run copies the template's contacts, which is the one thing `duplicateCampaign`
deliberately does not do ("copying the contacts would silently re-ring everyone"). Here
re-ringing everyone is the point, so the series carries the permission the duplicate lacks.
Two refinements worth having from the first version:

- **Suppressed stays suppressed.** A number that refused on run 3 is not on run 4. The
  contact-level do-not-call already holds this; the copy must read it rather than the
  template's row status.
- **Edits to the template land on the next run.** The operator changes the purpose on the
  template campaign; run n+1 picks it up because it is copied at run creation, not at series
  creation. This is also why the template is a real campaign and not a frozen snapshot —
  it is the thing they edit.

**The clock.** `next_run_at = anchor_at + n * every`, computed in Postgres with `interval`
arithmetic so "1 month" from the 31st does what Postgres does (lands on the 30th/28th) and
we do not write calendar code. The sweeper's existing tick (`start_due_campaigns`) gains a
sibling `create_due_runs()` that runs first: for each series with `next_run_at <= now()` and
no run already created for that `n`, create the run and advance `next_run_at`. Idempotent
by `(series_id, run_number)` unique.

**Consent and the window.** Unchanged and unbypassable. A series cannot ring outside
08:00–20:00 WAT any more than a campaign can; every placed call still goes through `mayCall`.
A series that starts at 02:00 simply has its first calls placed at 08:00.

## What the operator sees

- On a campaign page: **"Run this again"** → every *N* weeks/months, from *date*, each run
  open for *window*. That turns the campaign into a series' template. The page then shows
  the series' rhythm and the list of runs so far, each a link to an ordinary campaign page.
- A run's page says "Run 4 of *Rent reminder*, created automatically" and links back.
- Pause / resume / end on the series, distinct from pausing a run. Pausing a series stops
  future runs being created; a run in progress finishes.
- The campaigns list groups runs under their series, collapsed, so a monthly series does
  not become twelve cards a year.

## Not in the first version

- Rules over contacts (product B). See above.
- Per-run list changes ("skip Amaka this month"). Edit the template's contacts; it lands
  next run. Per-run exceptions are a real need and a small later slice.
- Notifying anyone that a run was created. The audit log gets a row; email is later.
- Cron expressions. An interval and an anchor cover every case in the catalogue, and a cron
  is a way to write "every third Tuesday" that nobody on the phone has ever asked for.

## Size

Migration (one table, two columns, one unique index, one SQL function), a `series` module in
`packages/db`, three endpoints (create series from campaign, patch series, list runs), one
sweeper sibling in `outbound/dialer.sweeper.ts`, and two console surfaces (the "Run this
again" card and the grouped list). Roughly the same size as pace plus the calling-window
editor together. Rule 1 applies: it is done when a series creates a run on its own and that
run rings a handset without anybody touching the console.
