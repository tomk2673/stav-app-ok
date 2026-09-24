-- PUB GURU V1: privileged transitions for invoices and closings.

create unique index if not exists purchase_price_invoice_line_once_idx
on public.purchase_price_history(invoice_line_id)
where invoice_line_id is not null;

drop policy if exists closings_insert_member on public.closings;
create policy closings_insert_member on public.closings
for insert to authenticated
with check (
  created_by = (select auth.uid())
  and (
    public.has_org_role(organization_id, array['owner','manager'])
    or (
      public.has_org_role(organization_id, array['staff'])
      and status = 'review'
      and finalized_at is null
      and finalized_by is null
    )
  )
);

create or replace function public.guard_closing_privileged_transition()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $$
begin
  if new.status = 'finalized' then
    if not private.has_org_role(new.organization_id, array['owner','manager']) then
      raise exception 'Only owner or manager may finalize a closing';
    end if;
    if new.finalized_by is distinct from auth.uid() then
      raise exception 'finalized_by must match current user';
    end if;
    if new.finalized_at is null then new.finalized_at := now(); end if;
  elsif tg_op = 'INSERT' and private.has_org_role(new.organization_id, array['staff']) then
    new.finalized_at := null;
    new.finalized_by := null;
  end if;
  return new;
end;
$$;
revoke all on function public.guard_closing_privileged_transition() from public, anon;
grant execute on function public.guard_closing_privileged_transition() to authenticated;
drop trigger if exists trg_guard_closing_privileged_transition on public.closings;
create trigger trg_guard_closing_privileged_transition
before insert or update on public.closings
for each row execute function public.guard_closing_privileged_transition();

create or replace function public.guard_privileged_audit_events()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $$
begin
  if new.event_type in ('invoice.posted','closing.finalized','closing.corrected_from_ocr','stock.manual_correction','product.saved')
     and not private.has_org_role(new.organization_id, array['owner','manager']) then
    raise exception 'This audit event requires owner or manager role';
  end if;
  return new;
end;
$$;
revoke all on function public.guard_privileged_audit_events() from public, anon;
grant execute on function public.guard_privileged_audit_events() to authenticated;
drop trigger if exists trg_guard_privileged_audit_events on public.audit_events;
create trigger trg_guard_privileged_audit_events
before insert on public.audit_events
for each row execute function public.guard_privileged_audit_events();

create or replace function public.finalize_invoice_from_audit()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $$
declare
  inv public.invoices%rowtype;
  line record;
  product_volume numeric;
begin
  if new.event_type <> 'invoice.posted' or new.entity_type <> 'invoice' or new.entity_id is null then return new; end if;
  if not private.has_org_role(new.organization_id, array['owner','manager']) then raise exception 'Only owner or manager may post an invoice'; end if;
  if new.actor_user_id is distinct from auth.uid() then raise exception 'Invoice posting actor mismatch'; end if;

  select * into inv from public.invoices where id = new.entity_id for update;
  if not found then raise exception 'Invoice not found'; end if;
  if inv.organization_id <> new.organization_id then raise exception 'Invoice organization mismatch'; end if;
  if inv.status = 'posted' then return new; end if;
  if inv.status <> 'approved' then raise exception 'Invoice must be approved before posting'; end if;
  if not exists (select 1 from public.invoice_lines il where il.invoice_id = inv.id and il.status = 'approved') then
    raise exception 'Cannot post invoice without approved lines';
  end if;

  for line in
    select il.id, il.product_id, il.quantity
    from public.invoice_lines il
    where il.invoice_id = inv.id and il.status = 'approved' and il.product_id is not null
  loop
    select p.volume_ml into product_volume from public.products p where p.id = line.product_id;
    if product_volume is null or product_volume <= 0 then raise exception 'Product % has no valid package volume', line.product_id; end if;
    if line.quantity is null or line.quantity <= 0 then raise exception 'Invoice line % has invalid quantity', line.id; end if;
    insert into public.stock_movements(
      organization_id, venue_id, product_id, movement_type, quantity_ml,
      source_type, source_id, reason, occurred_at, created_by
    ) values (
      inv.organization_id, inv.venue_id, line.product_id, 'receipt', line.quantity * product_volume,
      'invoice_line', line.id, 'Příjem z faktury ' || coalesce(inv.invoice_number, inv.id::text),
      coalesce(inv.issue_date::timestamptz, now()), new.actor_user_id
    ) on conflict do nothing;
  end loop;

  update public.invoices
  set status = 'posted', approved_at = now(), approved_by = new.actor_user_id
  where id = inv.id;
  return new;
end;
$$;
revoke all on function public.finalize_invoice_from_audit() from public, anon;
grant execute on function public.finalize_invoice_from_audit() to authenticated;
