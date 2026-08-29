-- PUB GURU database blueprint
-- Source-of-truth schema for the first production backend.
-- Intentionally not named as a Supabase migration until a dedicated PUB GURU project exists.

create extension if not exists pgcrypto;

create table if not exists public.organizations (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  created_at timestamptz not null default now(),
  created_by uuid not null references auth.users(id)
);

create table if not exists public.venues (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  name text not null,
  timezone text not null default 'Europe/Prague',
  currency text not null default 'CZK',
  created_at timestamptz not null default now(),
  created_by uuid not null references auth.users(id)
);

create table if not exists public.memberships (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  role text not null check (role in ('owner','manager','staff','accountant','service')),
  created_at timestamptz not null default now(),
  unique (organization_id, user_id)
);

create table if not exists public.products (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  name text not null,
  category text,
  ean text,
  volume_ml numeric,
  abv numeric,
  shot_ml numeric,
  sale_price numeric,
  current_purchase_price numeric,
  tare_g numeric,
  full_weight_g numeric,
  ml_per_g numeric,
  ref_temp_c numeric default 20,
  temp_coeff_pct_per_10c numeric,
  calibration_status text not null default 'missing' check (calibration_status in ('missing','provisional','verified')),
  calibration_source text,
  archived_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (organization_id, ean)
);

create table if not exists public.invoices (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  venue_id uuid references public.venues(id) on delete set null,
  supplier_name text,
  supplier_ico text,
  invoice_number text,
  issue_date date,
  total_amount numeric,
  currency text not null default 'CZK',
  source_fingerprint text,
  source_file_name text,
  raw_extraction jsonb not null default '{}'::jsonb,
  extraction_provider text,
  status text not null default 'review' check (status in ('review','approved','posted','rejected')),
  created_at timestamptz not null default now(),
  created_by uuid not null references auth.users(id),
  approved_at timestamptz,
  approved_by uuid references auth.users(id),
  unique (organization_id, source_fingerprint)
);

create table if not exists public.invoice_lines (
  id uuid primary key default gen_random_uuid(),
  invoice_id uuid not null references public.invoices(id) on delete cascade,
  organization_id uuid not null references public.organizations(id) on delete cascade,
  raw_name text not null,
  product_id uuid references public.products(id) on delete set null,
  quantity numeric,
  unit text,
  unit_price numeric,
  line_total numeric,
  match_confidence numeric,
  match_method text,
  status text not null default 'review' check (status in ('review','approved','ignored')),
  original_values jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create table if not exists public.purchase_price_history (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  venue_id uuid references public.venues(id) on delete set null,
  product_id uuid not null references public.products(id) on delete cascade,
  invoice_line_id uuid references public.invoice_lines(id) on delete set null,
  unit_price numeric not null,
  recorded_at timestamptz not null default now()
);

create table if not exists public.stock_movements (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  venue_id uuid not null references public.venues(id) on delete cascade,
  product_id uuid not null references public.products(id) on delete restrict,
  movement_type text not null check (movement_type in ('receipt','sale','waste','transfer_in','transfer_out','manual_correction')),
  quantity_ml numeric not null,
  source_type text,
  source_id uuid,
  reason text,
  occurred_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  created_by uuid not null references auth.users(id)
);

create table if not exists public.inventory_sessions (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  venue_id uuid not null references public.venues(id) on delete cascade,
  status text not null default 'open' check (status in ('open','closed','reviewed')),
  started_at timestamptz not null default now(),
  closed_at timestamptz,
  created_by uuid not null references auth.users(id)
);

create table if not exists public.inventory_lines (
  id uuid primary key default gen_random_uuid(),
  inventory_session_id uuid not null references public.inventory_sessions(id) on delete cascade,
  organization_id uuid not null references public.organizations(id) on delete cascade,
  product_id uuid not null references public.products(id) on delete restrict,
  expected_ml numeric,
  measured_ml numeric not null,
  difference_ml numeric,
  gross_weight_g numeric,
  sealed_count numeric,
  temperature_c numeric,
  purchase_value_difference numeric,
  sale_value_difference numeric,
  note text,
  measured_at timestamptz not null default now(),
  measured_by uuid not null references auth.users(id),
  original_measurement jsonb not null default '{}'::jsonb
);

create table if not exists public.closings (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  venue_id uuid not null references public.venues(id) on delete cascade,
  business_date date not null,
  source_type text not null default 'terminal',
  source_fingerprint text,
  source_file_name text,
  cash_amount numeric,
  card_amount numeric,
  total_amount numeric,
  transaction_count integer,
  refunds_amount numeric,
  raw_ocr_text text,
  extracted_values jsonb not null default '{}'::jsonb,
  status text not null default 'review' check (status in ('review','finalized','void')),
  created_at timestamptz not null default now(),
  created_by uuid not null references auth.users(id),
  finalized_at timestamptz,
  finalized_by uuid references auth.users(id),
  unique (organization_id, venue_id, source_fingerprint)
);

create table if not exists public.closing_corrections (
  id uuid primary key default gen_random_uuid(),
  closing_id uuid not null references public.closings(id) on delete restrict,
  organization_id uuid not null references public.organizations(id) on delete cascade,
  field_name text not null,
  original_value jsonb,
  corrected_value jsonb not null,
  reason text not null,
  created_at timestamptz not null default now(),
  created_by uuid not null references auth.users(id)
);

create table if not exists public.audit_events (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  venue_id uuid references public.venues(id) on delete set null,
  actor_user_id uuid references auth.users(id) on delete set null,
  event_type text not null,
  entity_type text not null,
  entity_id uuid,
  before_data jsonb,
  after_data jsonb,
  reason text,
  created_at timestamptz not null default now()
);

create index if not exists memberships_user_org_idx on public.memberships(user_id, organization_id);
create index if not exists products_org_idx on public.products(organization_id);
create index if not exists invoices_org_date_idx on public.invoices(organization_id, issue_date desc);
create index if not exists stock_movements_venue_product_time_idx on public.stock_movements(venue_id, product_id, occurred_at desc);
create index if not exists inventory_sessions_venue_time_idx on public.inventory_sessions(venue_id, started_at desc);
create index if not exists closings_venue_date_idx on public.closings(venue_id, business_date desc);
create index if not exists audit_events_org_time_idx on public.audit_events(organization_id, created_at desc);

-- RLS: all operational data is organization-scoped. No anonymous access.
alter table public.organizations enable row level security;
alter table public.venues enable row level security;
alter table public.memberships enable row level security;
alter table public.products enable row level security;
alter table public.invoices enable row level security;
alter table public.invoice_lines enable row level security;
alter table public.purchase_price_history enable row level security;
alter table public.stock_movements enable row level security;
alter table public.inventory_sessions enable row level security;
alter table public.inventory_lines enable row level security;
alter table public.closings enable row level security;
alter table public.closing_corrections enable row level security;
alter table public.audit_events enable row level security;

revoke all on public.organizations, public.venues, public.memberships, public.products, public.invoices, public.invoice_lines, public.purchase_price_history, public.stock_movements, public.inventory_sessions, public.inventory_lines, public.closings, public.closing_corrections, public.audit_events from anon, authenticated;
grant select, insert, update on public.organizations, public.venues, public.memberships, public.products, public.invoices, public.invoice_lines, public.purchase_price_history, public.stock_movements, public.inventory_sessions, public.inventory_lines, public.closings, public.closing_corrections to authenticated;
grant select, insert on public.audit_events to authenticated;

create policy memberships_read_own on public.memberships for select to authenticated
using ((select auth.uid()) = user_id);

create policy organizations_read_member on public.organizations for select to authenticated
using (exists (select 1 from public.memberships m where m.organization_id = organizations.id and m.user_id = (select auth.uid())));

create policy organizations_insert_self on public.organizations for insert to authenticated
with check (created_by = (select auth.uid()));

create policy venues_member_all on public.venues for all to authenticated
using (exists (select 1 from public.memberships m where m.organization_id = venues.organization_id and m.user_id = (select auth.uid())))
with check (exists (select 1 from public.memberships m where m.organization_id = venues.organization_id and m.user_id = (select auth.uid())));

create policy products_member_all on public.products for all to authenticated
using (exists (select 1 from public.memberships m where m.organization_id = products.organization_id and m.user_id = (select auth.uid())))
with check (exists (select 1 from public.memberships m where m.organization_id = products.organization_id and m.user_id = (select auth.uid())));

create policy invoices_member_all on public.invoices for all to authenticated
using (exists (select 1 from public.memberships m where m.organization_id = invoices.organization_id and m.user_id = (select auth.uid())))
with check (exists (select 1 from public.memberships m where m.organization_id = invoices.organization_id and m.user_id = (select auth.uid())));

create policy invoice_lines_member_all on public.invoice_lines for all to authenticated
using (exists (select 1 from public.memberships m where m.organization_id = invoice_lines.organization_id and m.user_id = (select auth.uid())))
with check (exists (select 1 from public.memberships m where m.organization_id = invoice_lines.organization_id and m.user_id = (select auth.uid())));

create policy price_history_member_all on public.purchase_price_history for all to authenticated
using (exists (select 1 from public.memberships m where m.organization_id = purchase_price_history.organization_id and m.user_id = (select auth.uid())))
with check (exists (select 1 from public.memberships m where m.organization_id = purchase_price_history.organization_id and m.user_id = (select auth.uid())));

create policy stock_movements_member_all on public.stock_movements for all to authenticated
using (exists (select 1 from public.memberships m where m.organization_id = stock_movements.organization_id and m.user_id = (select auth.uid())))
with check (exists (select 1 from public.memberships m where m.organization_id = stock_movements.organization_id and m.user_id = (select auth.uid())));

create policy inventory_sessions_member_all on public.inventory_sessions for all to authenticated
using (exists (select 1 from public.memberships m where m.organization_id = inventory_sessions.organization_id and m.user_id = (select auth.uid())))
with check (exists (select 1 from public.memberships m where m.organization_id = inventory_sessions.organization_id and m.user_id = (select auth.uid())));

create policy inventory_lines_member_all on public.inventory_lines for all to authenticated
using (exists (select 1 from public.memberships m where m.organization_id = inventory_lines.organization_id and m.user_id = (select auth.uid())))
with check (exists (select 1 from public.memberships m where m.organization_id = inventory_lines.organization_id and m.user_id = (select auth.uid())));

create policy closings_member_all on public.closings for all to authenticated
using (exists (select 1 from public.memberships m where m.organization_id = closings.organization_id and m.user_id = (select auth.uid())))
with check (exists (select 1 from public.memberships m where m.organization_id = closings.organization_id and m.user_id = (select auth.uid())));

create policy closing_corrections_member_all on public.closing_corrections for all to authenticated
using (exists (select 1 from public.memberships m where m.organization_id = closing_corrections.organization_id and m.user_id = (select auth.uid())))
with check (exists (select 1 from public.memberships m where m.organization_id = closing_corrections.organization_id and m.user_id = (select auth.uid())));

create policy audit_events_read_member on public.audit_events for select to authenticated
using (exists (select 1 from public.memberships m where m.organization_id = audit_events.organization_id and m.user_id = (select auth.uid())));

create policy audit_events_insert_member on public.audit_events for insert to authenticated
with check (
  actor_user_id = (select auth.uid()) and
  exists (select 1 from public.memberships m where m.organization_id = audit_events.organization_id and m.user_id = (select auth.uid()))
);

-- Finalized closings are immutable. Corrections must go to closing_corrections.
create or replace function public.prevent_finalized_closing_mutation()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $$
begin
  if old.status = 'finalized' then
    raise exception 'Finalized closing is immutable; create a correction record instead';
  end if;
  return new;
end;
$$;

revoke all on function public.prevent_finalized_closing_mutation() from public, anon, authenticated;
grant execute on function public.prevent_finalized_closing_mutation() to authenticated;

drop trigger if exists trg_prevent_finalized_closing_update on public.closings;
create trigger trg_prevent_finalized_closing_update
before update on public.closings
for each row execute function public.prevent_finalized_closing_mutation();

-- Inventory closing deliberately DOES NOT auto-create an adjustment movement.
-- Difference remains evidence until an authorized user explicitly records a correction.
