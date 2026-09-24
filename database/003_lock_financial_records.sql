-- Immutable evidence: posted invoices and closed inventories cannot be rewritten.
create or replace function public.prevent_posted_invoice_mutation()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $$
begin
  if old.status = 'posted' then
    raise exception 'Posted invoice is immutable';
  end if;
  return new;
end;
$$;
revoke all on function public.prevent_posted_invoice_mutation() from public, anon;
grant execute on function public.prevent_posted_invoice_mutation() to authenticated;
drop trigger if exists trg_prevent_posted_invoice_update on public.invoices;
create trigger trg_prevent_posted_invoice_update before update on public.invoices
for each row execute function public.prevent_posted_invoice_mutation();

create or replace function public.prevent_closed_inventory_mutation()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $$
begin
  if old.status in ('closed','reviewed') then
    raise exception 'Closed inventory is immutable';
  end if;
  return new;
end;
$$;
revoke all on function public.prevent_closed_inventory_mutation() from public, anon;
grant execute on function public.prevent_closed_inventory_mutation() to authenticated;
drop trigger if exists trg_prevent_closed_inventory_update on public.inventory_sessions;
create trigger trg_prevent_closed_inventory_update before update on public.inventory_sessions
for each row execute function public.prevent_closed_inventory_mutation();

create or replace function public.prevent_inventory_line_mutation_when_closed()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $$
declare session_status text;
begin
  select status into session_status from public.inventory_sessions where id = old.inventory_session_id;
  if session_status in ('closed','reviewed') then
    raise exception 'Inventory line belongs to a closed inventory and is immutable';
  end if;
  return new;
end;
$$;
revoke all on function public.prevent_inventory_line_mutation_when_closed() from public, anon;
grant execute on function public.prevent_inventory_line_mutation_when_closed() to authenticated;
drop trigger if exists trg_prevent_closed_inventory_line_update on public.inventory_lines;
create trigger trg_prevent_closed_inventory_line_update before update on public.inventory_lines
for each row execute function public.prevent_inventory_line_mutation_when_closed();
