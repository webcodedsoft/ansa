-- "Have I spoken to this person before, and how recently?"
--
-- Asked once as a call connects, so the agent can open with "hi again" rather than making
-- somebody explain the same problem for the third time this week. It runs while the
-- greeting is playing and must not still be running when the caller finishes their first
-- sentence, which is a tighter budget than any dashboard query has.
--
-- `calls` had three indexes and not one of them was keyed on the caller: the existing
-- filter in `listCallPage` pages by `created_at` and reaches the number as a heap
-- predicate, which is fine for a dashboard and not for this. `created_at desc` trails the
-- caller, so the most recent prior call is the first row read rather than a sort over all
-- of them.
--
-- Nulls are excluded. A withheld number is not an identity, and every such call would
-- otherwise collide with every other one — a caller with no CLI would be told they had
-- rung eleven times this week because ten strangers had.

create index if not exists calls_caller_recent_idx
  on calls (organization_id, caller, created_at desc)
  where caller is not null;
