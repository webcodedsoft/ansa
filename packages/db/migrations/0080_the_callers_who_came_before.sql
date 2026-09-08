-- The callers who rang before anyone was filing them.
--
-- 0075 said "every call belongs to someone" and made it true going forward: `recordCallStarted`
-- resolves the counterparty and mints the person in the same statement that opens the call.
-- Its backfill did not do the same job. It reads
--
--     update calls c set contact_id = ct.id from contacts ct where ct.phone = <counterparty>
--
-- which *links* a call to a person who already exists and never creates one. So the backfill's
-- reach was exactly the set of people who had already confirmed a value — the ones the old
-- `merge_captures_into_contact` path had minted as a side effect. Every other call stayed
-- unfiled, silently, because an update that matches nothing is not an error.
--
-- On the organisation this was found on that meant 24 calls, 0 filed, 0 contacts, and a
-- directory reading "Nobody yet" over a call log with two dozen rows in it. The requirement
-- was "any caller should be added to the contact list"; what shipped was "any caller who had
-- already been added stays added".
--
-- This mints the missing people and then links. Both halves are guarded on `contact_id is null`
-- and the insert takes `on conflict (organization_id, phone) do nothing`, so running it twice
-- is a no-op — and so is running it on a database where 0075's link already did the work.

-- The counterparty is not the same column on both directions: inbound it is who rang us,
-- outbound it is who we rang. `nullif(trim(...), '')` because a withheld number arrives as
-- either null or empty and both mean the same thing — nobody to file this under.
create or replace function pg_temp.counterparty(direction text, caller text, dialled text)
  returns text language sql immutable as $$
    select nullif(trim(case when direction = 'outbound' then dialled else caller end), '')
  $$;

insert into contacts (organization_id, phone, source)
select distinct c.organization_id,
       pg_temp.counterparty(c.direction, c.caller, c.dialled),
       'call'
  from calls c
 where c.contact_id is null
   and pg_temp.counterparty(c.direction, c.caller, c.dialled) is not null
on conflict (organization_id, phone) do nothing;

update calls c
   set contact_id = ct.id
  from contacts ct
 where c.contact_id is null
   and ct.organization_id = c.organization_id
   and ct.phone = pg_temp.counterparty(c.direction, c.caller, c.dialled);

-- `identified` is deliberately left alone, and left false for everyone this created.
--
-- These are people who rang and whose call recorded no confirmed value. That is precisely what
-- 0075's own comment says false means — "a caller we have rung or who rang us and who has told
-- us nothing yet" — so marking them identified to make the default directory look populated
-- would be putting misdials in front of customers to avoid an empty screen. They are behind the
-- Everyone filter, which is where they belong until they tell us something.
