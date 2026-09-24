-- Reconcile the supplier-learning schema with the repository and keep browser roles least-privileged.
create table if not exists public.supplier_product_mappings (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  supplier_key text not null,
  supplier_name text,
  source_code text,
  raw_name text,
  normalized_raw_name text,
  product_id uuid not null references public.products(id) on delete cascade,
  confidence numeric not null default 1,
  confirmed_by uuid references auth.users(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (organization_id, supplier_key, source_code)
);

create index if not exists supplier_product_mappings_lookup_idx
  on public.supplier_product_mappings (organization_id, supplier_key, source_code);
create index if not exists supplier_product_mappings_name_idx
  on public.supplier_product_mappings (organization_id, supplier_key, normalized_raw_name);

alter table public.supplier_product_mappings enable row level security;

drop policy if exists supplier_product_mappings_read_member on public.supplier_product_mappings;
create policy supplier_product_mappings_read_member
on public.supplier_product_mappings for select to authenticated
using (public.has_org_role(organization_id, array['owner','manager','staff']));

drop policy if exists supplier_product_mappings_write_manager on public.supplier_product_mappings;
create policy supplier_product_mappings_write_manager
on public.supplier_product_mappings for all to authenticated
using (public.has_org_role(organization_id, array['owner','manager']))
with check (public.has_org_role(organization_id, array['owner','manager']));

revoke all on table public.invoice_capture_jobs from anon;
revoke all on table public.invoice_capture_jobs from authenticated;
grant select, insert, delete on table public.invoice_capture_jobs to authenticated;
grant all on table public.invoice_capture_jobs to service_role;

revoke all on table public.supplier_product_mappings from anon;
revoke all on table public.supplier_product_mappings from authenticated;
grant select, insert, update, delete on table public.supplier_product_mappings to authenticated;
grant all on table public.supplier_product_mappings to service_role;

alter default privileges for role postgres in schema public
  revoke select, insert, update, delete, truncate, references, trigger on tables from anon, authenticated;
alter default privileges for role postgres in schema public
  revoke usage, select, update on sequences from anon, authenticated;
alter default privileges for role postgres in schema public
  revoke execute on functions from public, anon, authenticated;
