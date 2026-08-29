alter table public.products add column if not exists unit_mode text not null default 'liquid' check (unit_mode in ('liquid','unit'));
alter table public.products add column if not exists storage_zone_key text;
create index if not exists products_org_client_key_idx on public.products(organization_id, client_key);
