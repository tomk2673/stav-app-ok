create unique index if not exists stock_movements_invoice_line_once_idx
on public.stock_movements(venue_id, movement_type, source_type, source_id, product_id)
where source_id is not null and source_type = 'invoice_line' and movement_type = 'receipt';

create or replace function public.stage_invoice_before_post()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $$
begin
  if new.status = 'posted' then
    new.status := 'approved';
    new.approved_at := null;
    new.approved_by := null;
  end if;
  return new;
end;
$$;
revoke all on function public.stage_invoice_before_post() from public, anon;
grant execute on function public.stage_invoice_before_post() to authenticated;
drop trigger if exists trg_stage_invoice_before_post on public.invoices;
create trigger trg_stage_invoice_before_post
before insert on public.invoices
for each row execute function public.stage_invoice_before_post();

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
  if new.event_type <> 'invoice.posted' or new.entity_type <> 'invoice' or new.entity_id is null then
    return new;
  end if;

  select * into inv from public.invoices where id = new.entity_id for update;
  if not found then raise exception 'Invoice not found'; end if;
  if inv.organization_id <> new.organization_id then raise exception 'Invoice organization mismatch'; end if;
  if inv.status = 'posted' then return new; end if;

  if not exists (select 1 from public.invoice_lines il where il.invoice_id = inv.id and il.status = 'approved') then
    raise exception 'Cannot post invoice without approved lines';
  end if;

  for line in
    select il.id, il.product_id, il.quantity
    from public.invoice_lines il
    where il.invoice_id = inv.id and il.status = 'approved' and il.product_id is not null
  loop
    select p.volume_ml into product_volume from public.products p where p.id = line.product_id;
    if product_volume is null or product_volume <= 0 then
      raise exception 'Product % has no valid package volume', line.product_id;
    end if;
    if line.quantity is null or line.quantity <= 0 then
      raise exception 'Invoice line % has invalid quantity', line.id;
    end if;

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
drop trigger if exists trg_finalize_invoice_from_audit on public.audit_events;
create trigger trg_finalize_invoice_from_audit
after insert on public.audit_events
for each row execute function public.finalize_invoice_from_audit();
