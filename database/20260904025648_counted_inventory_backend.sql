-- Preserve counted packaging and consumables through the authenticated backend.
-- Stock remains an append-only ledger. Negative counted movements are capped at
-- the recorded balance and the remainder is retained as untracked evidence.

alter table public.products
  add column if not exists item_kind text not null default 'product',
  add column if not exists item_subtype text,
  add column if not exists count_unit text not null default 'ks';

alter table public.products drop constraint if exists products_unit_mode_check;
alter table public.products add constraint products_unit_mode_check
  check (unit_mode in ('liquid','unit','counted'));

alter table public.products drop constraint if exists products_item_kind_check;
alter table public.products add constraint products_item_kind_check
  check (item_kind in ('product','packaging','consumable'));

alter table public.products drop constraint if exists products_counted_metadata_check;
alter table public.products add constraint products_counted_metadata_check
  check (
    (
      unit_mode = 'counted'
      and item_kind in ('packaging','consumable')
      and nullif(btrim(item_subtype),'') is not null
      and nullif(btrim(count_unit),'') is not null
    )
    or (
      unit_mode in ('liquid','unit')
      and item_kind = 'product'
      and item_subtype is null
    )
  );

alter table public.stock_movements
  add column if not exists quantity_units numeric,
  add column if not exists requested_quantity_units numeric,
  add column if not exists untracked_units numeric not null default 0;

alter table public.stock_movements alter column quantity_ml set default 0;
alter table public.stock_movements drop constraint if exists stock_movements_movement_type_check;
alter table public.stock_movements add constraint stock_movements_movement_type_check
  check (movement_type in ('receipt','return','sale','waste','transfer_in','transfer_out','manual_correction'));
alter table public.stock_movements drop constraint if exists stock_movements_untracked_units_check;
alter table public.stock_movements add constraint stock_movements_untracked_units_check
  check (untracked_units >= 0);

alter table public.inventory_lines
  add column if not exists expected_units numeric,
  add column if not exists measured_units numeric,
  add column if not exists difference_units numeric;
alter table public.inventory_lines alter column measured_ml drop not null;
alter table public.inventory_lines drop constraint if exists inventory_lines_measurement_shape_check;
alter table public.inventory_lines add constraint inventory_lines_measurement_shape_check
  check (
    (
      measured_ml is not null
      and expected_units is null
      and measured_units is null
      and difference_units is null
    )
    or (
      measured_ml is null
      and measured_units is not null
      and expected_ml is null
      and difference_ml is null
    )
  );

drop index if exists public.stock_movements_invoice_line_once_idx;
create unique index stock_movements_invoice_line_once_idx
  on public.stock_movements(venue_id, source_type, source_id, product_id)
  where source_id is not null and source_type = 'invoice_line';

drop policy if exists stock_movements_insert_ops on public.stock_movements;
create policy stock_movements_insert_ops on public.stock_movements
for insert to authenticated
with check (
  created_by = (select auth.uid())
  and (
    (
      public.has_org_role(organization_id, array['owner','manager'])
      and (
        movement_type in ('sale','waste','transfer_in','transfer_out')
        or (movement_type = 'manual_correction' and nullif(btrim(reason),'') is not null)
        or (movement_type in ('receipt','return') and source_type = 'invoice_line' and source_id is not null)
      )
    )
    or (
      public.has_org_role(organization_id, array['staff'])
      and movement_type in ('sale','waste')
      and (movement_type <> 'waste' or nullif(btrim(reason),'') is not null)
    )
  )
);

create or replace function public.normalize_stock_movement_quantity()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $$
declare
  product_mode text;
  current_units numeric;
  requested_units numeric;
  effective_quantity numeric;
begin
  select p.unit_mode
  into product_mode
  from public.products p
  where p.id = new.product_id
    and p.organization_id = new.organization_id;

  if not found then
    raise exception 'Stock movement product does not belong to the organization';
  end if;
  if not exists (
    select 1 from public.venues v
    where v.id = new.venue_id and v.organization_id = new.organization_id
  ) then
    raise exception 'Stock movement venue does not belong to the organization';
  end if;

  if product_mode = 'counted' then
    requested_units := coalesce(new.requested_quantity_units, new.quantity_units);
    if requested_units is null or requested_units = 0 then
      raise exception 'Counted stock movement requires a non-zero unit quantity';
    end if;

    perform pg_catalog.pg_advisory_xact_lock(
      pg_catalog.hashtextextended(new.venue_id::text || ':' || new.product_id::text, 0)
    );
    new.quantity_ml := 0;
    new.requested_quantity_units := requested_units;

    if requested_units < 0 then
      select greatest(coalesce(sum(sm.quantity_units), 0), 0)
      into current_units
      from public.stock_movements sm
      where sm.organization_id = new.organization_id
        and sm.venue_id = new.venue_id
        and sm.product_id = new.product_id;
      new.quantity_units := greatest(requested_units, -current_units);
      new.untracked_units := abs(requested_units - new.quantity_units);
    else
      new.quantity_units := requested_units;
      new.untracked_units := 0;
    end if;
    effective_quantity := requested_units;
  else
    if new.quantity_ml is null or new.quantity_ml = 0 then
      raise exception 'Liquid stock movement requires a non-zero milliliter quantity';
    end if;
    if new.quantity_units is not null
       or new.requested_quantity_units is not null
       or coalesce(new.untracked_units, 0) <> 0 then
      raise exception 'Liquid stock movement cannot contain counted-unit quantities';
    end if;
    new.untracked_units := 0;
    effective_quantity := new.quantity_ml;
  end if;

  if new.movement_type in ('receipt','transfer_in') and effective_quantity <= 0 then
    raise exception 'Inbound stock movement requires a positive quantity';
  end if;
  if new.movement_type in ('return','sale','waste','transfer_out') and effective_quantity >= 0 then
    raise exception 'Outbound stock movement requires a negative quantity';
  end if;
  if new.movement_type = 'manual_correction' and effective_quantity = 0 then
    raise exception 'Manual correction requires a non-zero quantity';
  end if;

  return new;
end;
$$;
revoke all on function public.normalize_stock_movement_quantity() from public, anon;
grant execute on function public.normalize_stock_movement_quantity() to authenticated;
drop trigger if exists trg_normalize_stock_movement_quantity on public.stock_movements;
create trigger trg_normalize_stock_movement_quantity
before insert on public.stock_movements
for each row execute function public.normalize_stock_movement_quantity();

create or replace function public.validate_stock_movement_source()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $$
begin
  if new.movement_type in ('receipt','return') then
    if new.source_type <> 'invoice_line' or new.source_id is null then
      raise exception 'Invoice stock movement requires invoice_line source';
    end if;
    if not exists (
      select 1
      from public.invoice_lines il
      join public.invoices i on i.id = il.invoice_id
      where il.id = new.source_id
        and il.product_id = new.product_id
        and il.organization_id = new.organization_id
        and i.organization_id = new.organization_id
        and i.venue_id = new.venue_id
        and il.status = 'approved'
        and i.status in ('approved','posted')
        and (
          (new.movement_type = 'receipt' and il.quantity > 0)
          or (new.movement_type = 'return' and il.quantity < 0)
        )
    ) then
      raise exception 'Invoice movement source does not match an approved invoice line';
    end if;
  end if;
  if new.movement_type = 'manual_correction' and nullif(btrim(new.reason),'') is null then
    raise exception 'Manual correction requires reason';
  end if;
  if new.movement_type = 'waste' and nullif(btrim(new.reason),'') is null then
    raise exception 'Waste movement requires reason';
  end if;
  return new;
end;
$$;
revoke all on function public.validate_stock_movement_source() from public, anon;
grant execute on function public.validate_stock_movement_source() to authenticated;

create or replace function public.finalize_invoice_from_audit()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $$
declare
  inv public.invoices%rowtype;
  line record;
  product_record record;
  movement_kind text;
begin
  if new.event_type <> 'invoice.posted' or new.entity_type <> 'invoice' or new.entity_id is null then
    return new;
  end if;
  if not private.has_org_role(new.organization_id, array['owner','manager']) then
    raise exception 'Only owner or manager may post an invoice';
  end if;
  if new.actor_user_id is distinct from auth.uid() then
    raise exception 'Invoice posting actor mismatch';
  end if;

  select * into inv from public.invoices where id = new.entity_id for update;
  if not found then raise exception 'Invoice not found'; end if;
  if inv.organization_id <> new.organization_id then raise exception 'Invoice organization mismatch'; end if;
  if inv.venue_id is null then raise exception 'Invoice venue is required for posting'; end if;
  if inv.status = 'posted' then return new; end if;
  if inv.status <> 'approved' then raise exception 'Invoice must be approved before posting'; end if;
  if not exists (
    select 1 from public.invoice_lines il
    where il.invoice_id = inv.id and il.status = 'approved'
  ) then
    raise exception 'Cannot post invoice without approved lines';
  end if;
  if exists (
    select 1 from public.invoice_lines il
    where il.invoice_id = inv.id
      and il.status = 'approved'
      and (il.product_id is null or il.quantity is null or il.quantity = 0)
  ) then
    raise exception 'Every approved invoice line requires a product and non-zero quantity';
  end if;

  for line in
    select il.id, il.product_id, il.quantity
    from public.invoice_lines il
    where il.invoice_id = inv.id and il.status = 'approved'
    order by (il.quantity < 0), il.created_at, il.id
  loop
    select p.unit_mode, p.volume_ml
    into product_record
    from public.products p
    where p.id = line.product_id
      and p.organization_id = inv.organization_id;
    if not found then
      raise exception 'Invoice product % does not belong to the organization', line.product_id;
    end if;
    if product_record.unit_mode <> 'counted'
       and (product_record.volume_ml is null or product_record.volume_ml <= 0) then
      raise exception 'Product % has no valid package volume', line.product_id;
    end if;

    movement_kind := case when line.quantity < 0 then 'return' else 'receipt' end;
    insert into public.stock_movements(
      organization_id, venue_id, product_id, movement_type, quantity_ml,
      quantity_units, requested_quantity_units, source_type, source_id,
      reason, occurred_at, created_by
    ) values (
      inv.organization_id,
      inv.venue_id,
      line.product_id,
      movement_kind,
      case when product_record.unit_mode = 'counted' then 0 else line.quantity * product_record.volume_ml end,
      case when product_record.unit_mode = 'counted' then line.quantity else null end,
      case when product_record.unit_mode = 'counted' then line.quantity else null end,
      'invoice_line',
      line.id,
      case when movement_kind = 'return' then 'Vrácení z faktury ' else 'Příjem z faktury ' end
        || coalesce(inv.invoice_number, inv.id::text),
      coalesce(inv.issue_date::timestamptz, now()),
      new.actor_user_id
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
