create table if not exists public.invoice_capture_jobs (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  venue_id uuid not null references public.venues(id) on delete cascade,
  created_by uuid not null references auth.users(id) on delete restrict default auth.uid(),
  source_path text not null,
  source_file_name text,
  source_fingerprint text,
  mime_type text,
  status text not null default 'queued' check (status in ('queued','processing','review','done','failed')),
  provider text,
  result jsonb,
  error_message text,
  created_at timestamptz not null default now(),
  started_at timestamptz,
  finished_at timestamptz
);

create unique index if not exists invoice_capture_jobs_org_fingerprint_uq
  on public.invoice_capture_jobs (organization_id, source_fingerprint)
  where source_fingerprint is not null;
create index if not exists invoice_capture_jobs_queue_idx
  on public.invoice_capture_jobs (status, created_at);

alter table public.invoice_capture_jobs enable row level security;

drop policy if exists invoice_capture_jobs_read_member on public.invoice_capture_jobs;
create policy invoice_capture_jobs_read_member on public.invoice_capture_jobs
for select to authenticated
using (public.has_org_role(organization_id, array['owner','manager','staff']));

drop policy if exists invoice_capture_jobs_insert_member on public.invoice_capture_jobs;
create policy invoice_capture_jobs_insert_member on public.invoice_capture_jobs
for insert to authenticated
with check (
  created_by = auth.uid()
  and public.has_org_role(organization_id, array['owner','manager','staff'])
);

drop policy if exists invoice_capture_jobs_delete_own_queued on public.invoice_capture_jobs;
create policy invoice_capture_jobs_delete_own_queued on public.invoice_capture_jobs
for delete to authenticated
using (
  (created_by = auth.uid() and status = 'queued')
  or public.has_org_role(organization_id, array['owner','manager'])
);

grant select, insert, delete on public.invoice_capture_jobs to authenticated;
grant all on public.invoice_capture_jobs to service_role;

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('invoice-sources', 'invoice-sources', false, 8388608, array['image/jpeg','image/png','application/pdf'])
on conflict (id) do update set
  public = excluded.public,
  file_size_limit = excluded.file_size_limit,
  allowed_mime_types = excluded.allowed_mime_types;

drop policy if exists invoice_sources_insert_member on storage.objects;
create policy invoice_sources_insert_member on storage.objects
for insert to authenticated
with check (
  bucket_id = 'invoice-sources'
  and array_length(storage.foldername(name), 1) >= 4
  and public.has_org_role((storage.foldername(name))[1]::uuid, array['owner','manager','staff'])
  and (storage.foldername(name))[3] = auth.uid()::text
);

drop policy if exists invoice_sources_read_member on storage.objects;
create policy invoice_sources_read_member on storage.objects
for select to authenticated
using (
  bucket_id = 'invoice-sources'
  and array_length(storage.foldername(name), 1) >= 4
  and public.has_org_role((storage.foldername(name))[1]::uuid, array['owner','manager','staff'])
);

drop policy if exists invoice_sources_delete_own on storage.objects;
create policy invoice_sources_delete_own on storage.objects
for delete to authenticated
using (
  bucket_id = 'invoice-sources'
  and array_length(storage.foldername(name), 1) >= 4
  and (
    (storage.foldername(name))[3] = auth.uid()::text
    or public.has_org_role((storage.foldername(name))[1]::uuid, array['owner','manager'])
  )
);
