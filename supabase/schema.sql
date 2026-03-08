create extension if not exists pgcrypto;

create table if not exists public.app_state (
  id integer primary key check (id = 1),
  data jsonb not null default '{}'::jsonb,
  revision bigint not null default 0,
  editor_id text,
  updated_at timestamptz not null default timezone('utc', now())
);

create table if not exists public.github_sync_state (
  id integer primary key check (id = 1),
  last_synced_hash text,
  last_synced_at timestamptz,
  last_backup_at timestamptz,
  last_requested_at timestamptz,
  last_error text
);

alter table public.app_state enable row level security;
alter table public.github_sync_state enable row level security;

drop policy if exists "app_state_select_anon" on public.app_state;
create policy "app_state_select_anon"
  on public.app_state
  for select
  to anon
  using (true);

drop policy if exists "app_state_insert_anon" on public.app_state;
create policy "app_state_insert_anon"
  on public.app_state
  for insert
  to anon
  with check (true);

drop policy if exists "app_state_update_anon" on public.app_state;
create policy "app_state_update_anon"
  on public.app_state
  for update
  to anon
  using (true)
  with check (true);

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('page-images', 'page-images', true, 5242880, array['image/*'])
on conflict (id) do update
set public = excluded.public,
    file_size_limit = excluded.file_size_limit,
    allowed_mime_types = excluded.allowed_mime_types;

drop policy if exists "page_images_select_anon" on storage.objects;
create policy "page_images_select_anon"
  on storage.objects
  for select
  to anon
  using (bucket_id = 'page-images');

drop policy if exists "page_images_insert_anon" on storage.objects;
create policy "page_images_insert_anon"
  on storage.objects
  for insert
  to anon
  with check (bucket_id = 'page-images');

drop policy if exists "page_images_update_anon" on storage.objects;
create policy "page_images_update_anon"
  on storage.objects
  for update
  to anon
  using (bucket_id = 'page-images')
  with check (bucket_id = 'page-images');

insert into public.github_sync_state (id)
values (1)
on conflict (id) do nothing;

alter table public.app_state replica identity full;

do $$
begin
  if not exists (
    select 1
    from pg_publication_tables
    where pubname = 'supabase_realtime'
      and schemaname = 'public'
      and tablename = 'app_state'
  ) then
    alter publication supabase_realtime add table public.app_state;
  end if;
end $$;
