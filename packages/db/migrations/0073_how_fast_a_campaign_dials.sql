-- How fast a campaign dials, as two numbers the dialler cannot be talked out of.
--
-- The dialler placed up to five calls every ten seconds for every campaign alike — eighteen
-- hundred an hour, if the list held out. That is the right ceiling for the machine and the
-- wrong one for almost every organisation using it: an office of two that takes the
-- transfers cannot have five people on hold, and a carrier watching a number burst that
-- fast reads it as a robodialler, which is what it is at that rate.
--
-- `max_concurrent_calls` is how many may be on the phone at once. Countable now that a
-- placed row waits at `placing` until the carrier settles it (0072); before that every call
-- was `answered` the moment it was queued and there was nothing truthful to count.
-- `max_calls_per_hour` is the rolling budget, counted from `last_attempt_at`, which every
-- placement bumps. Null on either means no cap beyond the dialler's own batch, which is
-- what every campaign did before this. Both are read on every sweep, so a change bites on
-- the next one. Bounds are here so a value the console did not produce still cannot make
-- the dialler run flat out.

alter table campaigns
  add column if not exists max_concurrent_calls integer
    check (max_concurrent_calls between 1 and 50),
  add column if not exists max_calls_per_hour integer
    check (max_calls_per_hour between 1 and 1000);

comment on column campaigns.max_concurrent_calls is
  'How many of this campaign''s calls may be in progress at once. Null is no cap beyond the dialler''s batch.';
comment on column campaigns.max_calls_per_hour is
  'How many calls this campaign may place in any rolling hour. Null is no cap.';

-- The per-campaign load the dialler reads on every sweep. Both counts walk this.
create index if not exists scheduled_calls_campaign_last_attempt_idx
  on scheduled_calls (campaign_id, last_attempt_at)
  where last_attempt_at is not null;
