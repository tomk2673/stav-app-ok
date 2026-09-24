-- Supplier document profiles: reusable, organization-scoped training data for invoice extraction.
create table if not exists public.supplier_document_profiles (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  supplier_key text not null,
  supplier_name text not null,
  identification_hints jsonb not null default '{}'::jsonb,
  required_fields text[] not null default array[
    'supplier_name','invoice_number','issue_date','total_gross'
  ]::text[],
  line_fields text[] not null default array[
    'source_code','item_name','quantity','unit','vat_rate','unit_price_gross','line_total_gross'
  ]::text[],
  status text not null default 'active' check (status in ('active','paused')),
  created_by uuid not null references auth.users(id) on delete restrict default auth.uid(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (organization_id, supplier_key)
);

create table if not exists public.supplier_document_samples (
  id uuid primary key default gen_random_uuid(),
  profile_id uuid not null references public.supplier_document_profiles(id) on delete cascade,
  organization_id uuid not null references public.organizations(id) on delete cascade,
  venue_id uuid references public.venues(id) on delete set null,
  source_path text not null,
  source_file_name text,
  source_fingerprint text,
  mime_type text,
  page_count integer,
  annotations jsonb not null default '[]'::jsonb,
  raw_ocr_text text,
  confirmed boolean not null default true,
  created_by uuid not null references auth.users(id) on delete restrict default auth.uid(),
  created_at timestamptz not null default now(),
  unique (organization_id, source_fingerprint)
);

create index if not exists supplier_document_profiles_lookup_idx
  on public.supplier_document_profiles (organization_id, supplier_key);
create index if not exists supplier_document_samples_profile_idx
  on public.supplier_document_samples (profile_id, created_at desc);

alter table public.supplier_document_profiles enable row level security;
alter table public.supplier_document_samples enable row level security;

drop policy if exists supplier_document_profiles_read_member on public.supplier_document_profiles;
create policy supplier_document_profiles_read_member
on public.supplier_document_profiles for select to authenticated
using (public.has_org_role(organization_id, array['owner','manager','staff']));

drop policy if exists supplier_document_profiles_write_lead on public.supplier_document_profiles;
create policy supplier_document_profiles_write_lead
on public.supplier_document_profiles for all to authenticated
using (public.has_org_role(organization_id, array['owner','manager']))
with check (public.has_org_role(organization_id, array['owner','manager']));

drop policy if exists supplier_document_samples_read_member on public.supplier_document_samples;
create policy supplier_document_samples_read_member
on public.supplier_document_samples for select to authenticated
using (public.has_org_role(organization_id, array['owner','manager','staff']));

drop policy if exists supplier_document_samples_write_lead on public.supplier_document_samples;
create policy supplier_document_samples_write_lead
on public.supplier_document_samples for all to authenticated
using (public.has_org_role(organization_id, array['owner','manager']))
with check (public.has_org_role(organization_id, array['owner','manager']));

revoke all on table public.supplier_document_profiles from anon, authenticated;
revoke all on table public.supplier_document_samples from anon, authenticated;
grant select, insert, update, delete on table public.supplier_document_profiles to authenticated;
grant select, insert, update, delete on table public.supplier_document_samples to authenticated;
grant all on table public.supplier_document_profiles to service_role;
grant all on table public.supplier_document_samples to service_role;
