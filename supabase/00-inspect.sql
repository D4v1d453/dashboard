-- =====================================================================
-- 00 — Inspect (READ-ONLY). Run first in Supabase → SQL Editor.
-- Changes nothing. Shows what exists today so the migration can be
-- checked against it. Each query is a separate result tab.
-- =====================================================================

-- 1. Tables in the public schema and whether Row Level Security is on.
select c.relname as table_name,
       c.relrowsecurity as rls_enabled,
       c.relforcerowsecurity as rls_forced,
       (select count(*) from pg_policies p where p.schemaname = 'public' and p.tablename = c.relname) as policies
from pg_class c
join pg_namespace n on n.oid = c.relnamespace
where n.nspname = 'public' and c.relkind = 'r'
order by 1;

-- 2. Every policy on public tables and on storage.objects.
select schemaname, tablename, policyname, cmd, roles, qual as using_expr, with_check
from pg_policies
where schemaname in ('public', 'storage')
order by schemaname, tablename, policyname;

-- 3. app_state columns.
select column_name, data_type, is_nullable, column_default
from information_schema.columns
where table_schema = 'public' and table_name = 'app_state'
order by ordinal_position;

-- 4. app_state constraints (primary key / unique).
select conname, contype, pg_get_constraintdef(oid) as definition
from pg_constraint
where conrelid = 'public.app_state'::regclass;

-- 5. app_state rows (no data shown — just which rows exist).
select key, updated_at, pg_column_size(data) as bytes
from public.app_state order by key;

-- 6. Table privileges for the API roles.
select grantee, privilege_type
from information_schema.role_table_grants
where table_schema = 'public' and table_name = 'app_state' and grantee in ('anon', 'authenticated')
order by 1, 2;

-- 7. Storage buckets and how many objects each has.
select b.id, b.public, count(o.id) as objects
from storage.buckets b left join storage.objects o on o.bucket_id = b.id
group by b.id, b.public order by 1;

-- 8. Existing user accounts (emails only).
select id, email, email_confirmed_at is not null as confirmed, created_at
from auth.users order by created_at;
