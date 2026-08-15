-- Dates for tools that were stored before there were dates.
--
-- `createdAt` and `updatedAt` per HTTP tool arrived with the tools table columns, and every
-- tool already in a `tool_config` predates them — so the console showed an em dash for all
-- of them, which is honest and useless. Re-saving each tool would stamp it, but with today's
-- date, which would be a lie about a tool added last week.
--
-- The evidence is already in `agent_prompt_versions`: every publish snapshots the whole
-- `tool_config` beside its `published_at`. So both dates can be read rather than guessed.
--
--   createdAt — the earliest published version whose document contains a tool of that name.
--   updatedAt — the earliest published version whose copy of that tool matches the one in
--               force today. "When did it last change" and "when did the current definition
--               first appear" are the same question asked from opposite ends, and only the
--               second is answerable from snapshots.
--
-- Both stamps are stripped before comparing, or a version would differ from the one after it
-- by the very field being computed. Idempotent: a tool that already has a `createdAt` is left
-- alone, so re-running this cannot overwrite a real stamp with a derived one.

with current_tools as (
  select
    o.id as organization_id,
    entry.ordinality as position,
    entry.tool
  from organizations o
  cross join lateral jsonb_array_elements(coalesce(o.tool_config -> 'http', '[]'::jsonb))
    with ordinality as entry(tool, ordinality)
  where o.tool_config is not null
),

-- Every appearance of every tool in every published snapshot, with the stamps removed so one
-- definition can be compared with another honestly.
appearances as (
  select
    v.organization_id,
    seen.tool ->> 'name' as name,
    v.published_at,
    seen.tool - 'createdAt' - 'updatedAt' as shape
  from agent_prompt_versions v
  cross join lateral jsonb_array_elements(coalesce(v.tool_config -> 'http', '[]'::jsonb))
    as seen(tool)
  where v.tool_config is not null
),

derived as (
  select
    t.organization_id,
    t.position,
    t.tool,
    (
      select min(a.published_at)
      from appearances a
      where a.organization_id = t.organization_id
        and a.name = t.tool ->> 'name'
    ) as created_at,
    (
      select min(a.published_at)
      from appearances a
      where a.organization_id = t.organization_id
        and a.name = t.tool ->> 'name'
        and a.shape = t.tool - 'createdAt' - 'updatedAt'
    ) as updated_at
  from current_tools t
  -- Only the unstamped. A tool saved since the columns landed already knows its own dates.
  where t.tool -> 'createdAt' is null
),

rebuilt as (
  select
    d.organization_id,
    jsonb_agg(
      case
        when d.created_at is null then d.tool
        else d.tool
             || jsonb_build_object(
                  'createdAt',
                  to_char(d.created_at at time zone 'utc', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
                  -- A tool present in history but never in its current shape has been edited
                  -- outside a publish. Its creation is still known, and falling back to that
                  -- is better than a null sitting beside a real date.
                  'updatedAt',
                  to_char(coalesce(d.updated_at, d.created_at) at time zone 'utc', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
                )
      end
      order by d.position
    ) as http
  from derived d
  group by d.organization_id
)

update organizations o
   set tool_config = jsonb_set(o.tool_config, '{http}', r.http)
  from rebuilt r
 where o.id = r.organization_id
   -- Every unstamped tool of this organisation is in `r.http`; if some were stamped already
   -- the array would be short and this would drop them. Refusing that case outright is
   -- cheaper than merging, and it cannot arise for a document written before the columns.
   and jsonb_array_length(r.http) = jsonb_array_length(o.tool_config -> 'http');
