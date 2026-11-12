-- =====================================================================
-- 01 — Per-user data + Row Level Security for public.app_state
--
-- BEFORE RUNNING
--   * Your account must exist (Authentication → Users → it's listed).
--   * Put your account email on the line marked  <<< EDIT  below.
--
-- WHAT IT DOES — everything is ONE statement (a DO block), so it is
-- all-or-nothing: if any step fails, NOTHING changes.
--   1. Finds your account; stops with an error if it doesn't exist.
--   2. Backs up every app_state row to public.app_state_backup_pre_auth
--      (private table: RLS on, no policies, no API access).
--   3. Adds user_id and assigns ALL existing rows to your account.
--   4. Makes each row unique per (user_id, key) instead of per key.
--   5. Turns on Row Level Security and replaces every existing policy on
--      app_state with owner-only policies (select/insert/update/delete
--      only where user_id = auth.uid()). Removes anon access entirely.
--
-- It deletes no rows and never touches row data. Safe to re-run.
-- =====================================================================
do $migration$
declare
  owner_email text := 'YOUR-EMAIL@example.com';   -- <<< EDIT
  owner_id uuid;
  uid_att smallint;
  r record;
begin
  -- 1. Owner of the existing data ---------------------------------------
  select id into owner_id from auth.users where lower(email) = lower(owner_email);
  if owner_id is null then
    raise exception 'Owner account "%" not found. Create it first (Authentication → Users → Add user) and check the email in this script.', owner_email;
  end if;

  -- 2. Backup (private) ---------------------------------------------------
  if to_regclass('public.app_state_backup_pre_auth') is null then
    execute 'create table public.app_state_backup_pre_auth as
               select a.*, now() as backed_up_at from public.app_state a';
  end if;
  alter table public.app_state_backup_pre_auth enable row level security;  -- no policies = no API access
  revoke all on table public.app_state_backup_pre_auth from anon, authenticated;

  -- 3. Owner column -------------------------------------------------------
  alter table public.app_state add column if not exists user_id uuid;
  update public.app_state set user_id = owner_id where user_id is null;
  alter table public.app_state alter column user_id set not null;
  alter table public.app_state alter column user_id set default auth.uid();

  if not exists (select 1 from pg_constraint
                 where conrelid = 'public.app_state'::regclass and conname = 'app_state_user_id_fkey') then
    -- No cascade: deleting an account that still has data is refused
    -- instead of silently deleting the data.
    alter table public.app_state
      add constraint app_state_user_id_fkey foreign key (user_id) references auth.users(id);
  end if;

  -- 4. One row per (user_id, key) ------------------------------------------
  -- Drop any primary key / unique constraint or unique index that does not
  -- include user_id (e.g. the old "key is unique" rule — with several users
  -- every user has a 'goals' row). Data is untouched.
  select attnum into uid_att from pg_attribute
   where attrelid = 'public.app_state'::regclass and attname = 'user_id';

  for r in
    select conname from pg_constraint
    where conrelid = 'public.app_state'::regclass and contype in ('p', 'u')
      and not (uid_att = any (conkey))
  loop
    execute format('alter table public.app_state drop constraint %I', r.conname);
  end loop;

  for r in
    select ic.relname from pg_index x
    join pg_class ic on ic.oid = x.indexrelid
    where x.indrelid = 'public.app_state'::regclass and x.indisunique
      and not exists (select 1 from pg_constraint c where c.conindid = x.indexrelid)
      and not (uid_att = any (x.indkey::smallint[]))
  loop
    execute format('drop index public.%I', r.relname);
  end loop;

  if not exists (select 1 from pg_constraint
                 where conrelid = 'public.app_state'::regclass and contype = 'p') then
    alter table public.app_state add constraint app_state_pkey primary key (user_id, key);
  elsif not exists (select 1 from pg_constraint
                    where conrelid = 'public.app_state'::regclass and contype in ('p', 'u')
                      and pg_get_constraintdef(oid) ilike '%(user_id, key)%') then
    alter table public.app_state add constraint app_state_user_id_key_key unique (user_id, key);
  end if;

  -- 5. Row Level Security: owner-only ---------------------------------------
  alter table public.app_state enable row level security;

  for r in select policyname from pg_policies where schemaname = 'public' and tablename = 'app_state'
  loop
    execute format('drop policy %I on public.app_state', r.policyname);
  end loop;

  create policy "app_state: owner can read"
    on public.app_state for select to authenticated
    using ((select auth.uid()) = user_id);

  create policy "app_state: owner can insert"
    on public.app_state for insert to authenticated
    with check ((select auth.uid()) = user_id);

  create policy "app_state: owner can update"
    on public.app_state for update to authenticated
    using ((select auth.uid()) = user_id)
    with check ((select auth.uid()) = user_id);

  create policy "app_state: owner can delete"
    on public.app_state for delete to authenticated
    using ((select auth.uid()) = user_id);

  revoke all on table public.app_state from anon;
  grant select, insert, update, delete on table public.app_state to authenticated;

  raise notice 'Done: % row(s) now owned by %.', (select count(*) from public.app_state where user_id = owner_id), owner_email;
end
$migration$;

-- ---------------------------------------------------------------------
-- CHECK — every row now has an owner, the row count matches the backup,
-- and only the four owner-only policies exist.
-- ---------------------------------------------------------------------
select a.key, u.email as owner, a.updated_at
from public.app_state a join auth.users u on u.id = a.user_id
order by a.key;

select (select count(*) from public.app_state) as rows_now,
       (select count(*) from public.app_state_backup_pre_auth) as rows_in_backup;

select policyname, cmd, roles from pg_policies
where schemaname = 'public' and tablename = 'app_state' order by policyname;
