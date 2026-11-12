-- Enable Supabase Realtime for the dashboard's sync table.
--
-- Every page syncs through one row per section in public.app_state and
-- listens for changes to it over Realtime (postgres_changes). Realtime only
-- broadcasts tables that are in the `supabase_realtime` publication — without
-- this, live updates fall back to the 20-second poll in sync.js.
--
-- Run once in the Supabase dashboard → SQL Editor. Safe to re-run.
-- It does not change the table, its data or its RLS policies; Realtime
-- delivers rows only to clients that can already SELECT them.

do $$
begin
  if not exists (
    select 1 from pg_publication_tables
    where pubname = 'supabase_realtime'
      and schemaname = 'public'
      and tablename = 'app_state'
  ) then
    alter publication supabase_realtime add table public.app_state;
  end if;
end
$$;

-- Check: should return one row.
select pubname, schemaname, tablename
from pg_publication_tables
where pubname = 'supabase_realtime' and tablename = 'app_state';
