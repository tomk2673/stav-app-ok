-- No line can be appended after an inventory has been closed.
create or replace function public.prevent_inventory_line_insert_when_closed()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $$
declare session_status text;
begin
  select status into session_status from public.inventory_sessions where id = new.inventory_session_id;
  if session_status is null then
    raise exception 'Inventory session not found';
  end if;
  if session_status in ('closed','reviewed') then
    raise exception 'Cannot add lines to a closed inventory';
  end if;
  return new;
end;
$$;
revoke all on function public.prevent_inventory_line_insert_when_closed() from public, anon;
grant execute on function public.prevent_inventory_line_insert_when_closed() to authenticated;
drop trigger if exists trg_prevent_late_inventory_line_insert on public.inventory_lines;
create trigger trg_prevent_late_inventory_line_insert
before insert on public.inventory_lines
for each row execute function public.prevent_inventory_line_insert_when_closed();
