-- =====================================================================
-- 02 — Private progress photos (bucket 'progress-photos')
--
-- Run after 01. Put the same account email on the  <<< EDIT  line.
--
-- WHAT IT DOES — ONE statement (a DO block), all-or-nothing.
--   1. Makes the bucket private (photos are no longer reachable by URL;
--      the app shows them through short-lived signed URLs).
--   2. Replaces any existing policies that mention this bucket with
--      owner-only policies:
--        * new photos go in a folder named after the user id (<uid>/...),
--          and only that user can read/write/delete inside it;
--        * photos uploaded before accounts existed (stored at the bucket
--          root, no owner) are readable/deletable only by YOUR account.
-- It does not move, rename or delete any photo files.
-- =====================================================================
do $storage$
declare
  owner_email text := 'YOUR-EMAIL@example.com';   -- <<< EDIT
  owner_uid text;
  own_folder text := '(storage.foldername(name))[1] = (select auth.uid()::text)';
  legacy text;
  r record;
begin
  select id::text into owner_uid from auth.users where lower(email) = lower(owner_email);
  if owner_uid is null then
    raise exception 'Owner account "%" not found — check the email in this script.', owner_email;
  end if;

  -- 1. Private bucket
  update storage.buckets set public = false where id = 'progress-photos';

  -- 2. Old policies for this bucket (e.g. "anyone can upload/read").
  for r in
    select policyname from pg_policies
    where schemaname = 'storage' and tablename = 'objects'
      and (coalesce(qual, '') ilike '%progress-photos%' or coalesce(with_check, '') ilike '%progress-photos%')
  loop
    execute format('drop policy %I on storage.objects', r.policyname);
  end loop;

  -- Root-level (pre-account) photos belong to the owner account only.
  legacy := format('(position(''/'' in name) = 0 and (select auth.uid()::text) = %L)', owner_uid);

  execute format($p$create policy "progress-photos: owner can read" on storage.objects
    for select to authenticated
    using (bucket_id = 'progress-photos' and (%s or %s))$p$, own_folder, legacy);

  execute format($p$create policy "progress-photos: owner can upload" on storage.objects
    for insert to authenticated
    with check (bucket_id = 'progress-photos' and %s)$p$, own_folder);

  execute format($p$create policy "progress-photos: owner can update" on storage.objects
    for update to authenticated
    using (bucket_id = 'progress-photos' and %s)
    with check (bucket_id = 'progress-photos' and %s)$p$, own_folder, own_folder);

  execute format($p$create policy "progress-photos: owner can delete" on storage.objects
    for delete to authenticated
    using (bucket_id = 'progress-photos' and (%s or %s))$p$, own_folder, legacy);
end
$storage$;

-- CHECK
select id, public from storage.buckets where id = 'progress-photos';
select policyname, cmd, roles from pg_policies
where schemaname = 'storage' and tablename = 'objects' order by policyname;
