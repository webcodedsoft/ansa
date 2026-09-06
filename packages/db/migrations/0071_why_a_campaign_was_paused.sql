-- One line on why a campaign stopped, for whoever opens it tomorrow.
--
-- "Paused" on a badge answers what and not why, and the why is the only thing the next
-- person needs: "paused — waiting for legal sign-off" and "paused — the venue cancelled" want
-- opposite responses, and today they look identical. A campaign can sit paused for days
-- across a handover, so this lives on the row rather than in anybody's head.
--
-- Cleared when the campaign leaves `paused`, so a stale reason cannot be read against a
-- campaign that has since resumed. Free text, capped by the API rather than here — the
-- limit belongs with the other CAMPAIGN_LIMITS so the console and the API agree on it.

alter table campaigns
  add column if not exists pause_reason text;

comment on column campaigns.pause_reason is
  'Why the campaign is paused, in the operator''s words. Set when it enters paused and cleared when it leaves, so it is never read against a campaign that has moved on.';
