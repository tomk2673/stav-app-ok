-- Stable bridge from the original STAV product IDs to PUB GURU UUID products.
alter table public.products add column if not exists client_key text;
alter table public.products add column if not exists aliases text[] not null default '{}';
create unique index if not exists products_org_client_key_uidx
  on public.products(organization_id, client_key)
  where client_key is not null;
