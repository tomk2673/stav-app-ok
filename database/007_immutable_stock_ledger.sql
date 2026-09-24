revoke update, delete on public.stock_movements from authenticated;
drop policy if exists stock_movements_update_lead on public.stock_movements;
drop policy if exists stock_movements_insert_ops on public.stock_movements;
create policy stock_movements_insert_ops on public.stock_movements for insert to authenticated
with check (
  created_by = (select auth.uid())
  and (
    (
      public.has_org_role(organization_id, array['owner','manager'])
      and (
        movement_type in ('sale','waste','transfer_in','transfer_out')
        or (movement_type = 'manual_correction' and nullif(btrim(reason),'') is not null)
        or (movement_type = 'receipt' and source_type = 'invoice_line' and source_id is not null)
      )
    )
    or (
      public.has_org_role(organization_id, array['staff'])
      and movement_type in ('sale','waste')
      and (movement_type <> 'waste' or nullif(btrim(reason),'') is not null)
    )
  )
);

create or replace function public.validate_stock_movement_source()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $$
begin
  if new.movement_type = 'receipt' then
    if new.source_type <> 'invoice_line' or new.source_id is null then
      raise exception 'Receipt requires invoice_line source';
    end if;
    if not exists (
      select 1
      from public.invoice_lines il
      join public.invoices i on i.id = il.invoice_id
      where il.id = new.source_id
        and il.product_id = new.product_id
        and il.organization_id = new.organization_id
        and i.venue_id = new.venue_id
        and il.status = 'approved'
        and i.status in ('approved','posted')
    ) then
      raise exception 'Receipt source does not match an approved invoice line';
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
drop trigger if exists trg_validate_stock_movement_source on public.stock_movements;
create trigger trg_validate_stock_movement_source
before insert on public.stock_movements
for each row execute function public.validate_stock_movement_source();
