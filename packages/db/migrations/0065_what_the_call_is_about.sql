-- What an outbound call is about.
--
-- A campaign said who rings (`agent_id`) and when (`calling_window`), and never why. That was
-- not a small omission. `prompts/outbound.ts` instructs the model to open by saying "who you
-- are, which company, and why you are calling — all of it before anything else", and nothing
-- in the system supplied the third. The agent a campaign points at is configured for inbound:
-- Oakhaven's greeting asks "are you calling about a property to rent, to buy, to lease?",
-- which is the one question an outbound call must never ask, because we rang them.
--
-- So a campaign now carries a brief: why it is ringing, how it opens, the conversation it
-- wants to have, what counts as done, what to do if a machine answers, and how many times to
-- try. The agent stays what it was — a voice, a persona, a set of tools — and the campaign
-- supplies the purpose, which is the division that lets one agent serve many campaigns.
--
-- **The brief is frozen once the campaign runs.** Not by a column: `status` already says it,
-- and a second source for the same fact is a second thing to get wrong. Draft and scheduled
-- are editable; running, paused and done are not. The reason is the reason behind Rule 4 — a
-- call must not have its purpose changed underneath it while it is in flight — and a campaign
-- has no draft/publish cycle to lean on, so the lifecycle it does have carries the rule.
--
-- Every column is nullable or defaulted. Campaigns exist already, and a migration that
-- demanded a purpose for them would be inventing one.

alter table campaigns
  -- One line, in the operator's words: "to confirm your viewing on Tuesday". This is what the
  -- agent says it is calling about, so it is prose rather than a code.
  add column if not exists purpose text,
  -- The first thing said, if the operator wants to write it themselves. Null means the agent
  -- composes one from the organisation's name and the purpose, which is usually better.
  add column if not exists opening text,
  -- The conversation, as a graph, in the same shape and the same builder an agent's flow uses.
  -- Null means there is no script beyond the purpose: the agent says why it rang and listens.
  add column if not exists flow jsonb,
  -- What counts as done, as an ordered list of names the agent picks from at the end. Null or
  -- empty means the campaign is not asking for a verdict, only for the call to happen.
  add column if not exists outcomes jsonb,
  -- What to do when a machine answers: {"mode":"hang_up"} or {"mode":"leave_message","message":"…"}.
  -- Null means hang up, which is the safe default — a message left by accident is a message
  -- that cannot be taken back.
  add column if not exists voicemail jsonb,
  -- How many times one person may be rung for this campaign, in total. Three is a working
  -- default and the ceiling exists at all because `attempts` was a counter with nothing
  -- watching it: nothing stopped a campaign ringing somebody forever.
  add column if not exists max_attempts integer not null default 3,
  -- How long to wait before trying again. Four hours moves a retry to a different part of the
  -- day, which is the point: ringing three times in ten minutes is harassment, not diligence.
  add column if not exists retry_after_minutes integer not null default 240,
  add constraint campaigns_max_attempts_check check (max_attempts between 1 and 10),
  add constraint campaigns_retry_gap_check check (retry_after_minutes between 15 and 10080),
  add constraint campaigns_flow_is_object check (flow is null or jsonb_typeof(flow) = 'object'),
  add constraint campaigns_outcomes_is_array check (outcomes is null or jsonb_typeof(outcomes) = 'array'),
  add constraint campaigns_voicemail_is_object check (voicemail is null or jsonb_typeof(voicemail) = 'object');

comment on column campaigns.purpose is
  'Why this campaign rings, in one line and in the operator''s words. The agent says it in the opening, because prompts/outbound.ts requires a reason and this is where it comes from.';

comment on column campaigns.flow is
  'The conversation as a graph, same shape as an agent flow. Frozen once the campaign is running: a call in flight must not have its script changed underneath it.';

comment on column campaigns.voicemail is
  'What to do when a machine answers. Null means hang up. CLAUDE.md: an agent that holds a two-minute conversation with a greeting is both useless and billed.';

-- ---------------------------------------------------------------------------
-- What this particular person's call is about
-- ---------------------------------------------------------------------------

alter table scheduled_calls
  -- The facts that differ per person: the date of their viewing, the reference of their order.
  -- Merged into what the agent says, so a campaign can be about one thing and still be
  -- specific to each person it rings. An object of plain strings; the API shapes it.
  add column if not exists facts jsonb,
  add constraint scheduled_calls_facts_is_object check (facts is null or jsonb_typeof(facts) = 'object');

comment on column scheduled_calls.facts is
  'Per-contact detail merged into the call: {"when":"Tuesday at 2","property":"14 Adeola Odeku"}. Lets one campaign say something specific to each person.';

-- ---------------------------------------------------------------------------
-- Which campaign a call belongs to
-- ---------------------------------------------------------------------------

-- Without this the orchestrator cannot know why it is on the phone. The campaign's brief is
-- read from here on every outbound call, so the link is not reporting — it is the mechanism.
-- `set null` rather than cascade: deleting a campaign must not delete the record that a call
-- happened, which is the thing a regulator asks about.
alter table calls
  add column if not exists campaign_id uuid references campaigns(id) on delete set null;

create index if not exists calls_campaign_idx
  on calls (organization_id, campaign_id, created_at desc)
  where campaign_id is not null;

comment on column calls.campaign_id is
  'The campaign that placed this call, or null for an inbound one. How the orchestrator finds the brief that says why it rang.';
