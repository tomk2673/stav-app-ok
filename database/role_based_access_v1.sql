-- PUB GURU role-based access v1
-- owner: full control inside organization
-- manager: operational control, no ownership/member administration
-- staff: execute day-to-day workflows, no financial/admin rewrites

create or replace function public.has_org_role(p_org uuid, p_roles text[])
returns boolean
language sql
stable
security invoker
set search_path = public
as $$
  select exists (
    select 1 from public.memberships m
    where m.organization_id = p_org
      and m.user_id = (select auth.uid())
      and m.role = any(p_roles)
  );
$$;
revoke all on function public.has_org_role(uuid,text[]) from public, anon;
grant execute on function public.has_org_role(uuid,text[]) to authenticated;

-- Replace broad member policies with role-aware policies.
drop policy if exists venues_member_all on public.venues;
drop policy if exists products_member_all on public.products;
drop policy if exists invoices_member_all on public.invoices;
drop policy if exists invoice_lines_member_all on public.invoice_lines;
drop policy if exists price_history_member_all on public.purchase_price_history;
drop policy if exists stock_movements_member_all on public.stock_movements;
drop policy if exists inventory_sessions_member_all on public.inventory_sessions;
drop policy if exists inventory_lines_member_all on public.inventory_lines;
drop policy if exists closings_member_all on public.closings;
drop policy if exists closing_corrections_member_all on public.closing_corrections;

create policy organizations_update_owner on public.organizations for update to authenticated
using (public.has_org_role(id, array['owner']))
with check (public.has_org_role(id, array['owner']));

create policy memberships_read_owner on public.memberships for select to authenticated
using (public.has_org_role(organization_id, array['owner']));

create policy venues_read_member on public.venues for select to authenticated
using (public.has_org_role(organization_id, array['owner','manager','staff','accountant','service']));
create policy venues_insert_lead on public.venues for insert to authenticated
with check (created_by = (select auth.uid()) and public.has_org_role(organization_id, array['owner','manager']));
create policy venues_update_lead on public.venues for update to authenticated
using (public.has_org_role(organization_id, array['owner','manager']))
with check (public.has_org_role(organization_id, array['owner','manager']));

create policy products_read_member on public.products for select to authenticated
using (public.has_org_role(organization_id, array['owner','manager','staff','accountant','service']));
create policy products_insert_lead on public.products for insert to authenticated
with check (public.has_org_role(organization_id, array['owner','manager']));
create policy products_update_lead on public.products for update to authenticated
using (public.has_org_role(organization_id, array['owner','manager']))
with check (public.has_org_role(organization_id, array['owner','manager']));

create policy invoices_read_member on public.invoices for select to authenticated
using (public.has_org_role(organization_id, array['owner','manager','staff','accountant']));
create policy invoices_insert_capture on public.invoices for insert to authenticated
with check (
  created_by = (select auth.uid())
  and public.has_org_role(organization_id, array['owner','manager','staff'])
  and (public.has_org_role(organization_id, array['owner','manager']) or status = 'review')
);
create policy invoices_update_lead on public.invoices for update to authenticated
using (public.has_org_role(organization_id, array['owner','manager']))
with check (public.has_org_role(organization_id, array['owner','manager']));

create policy invoice_lines_read_member on public.invoice_lines for select to authenticated
using (public.has_org_role(organization_id, array['owner','manager','staff','accountant']));
create policy invoice_lines_insert_capture on public.invoice_lines for insert to authenticated
with check (
  public.has_org_role(organization_id, array['owner','manager'])
  or (public.has_org_role(organization_id, array['staff']) and status = 'review')
);
create policy invoice_lines_update_lead on public.invoice_lines for update to authenticated
using (public.has_org_role(organization_id, array['owner','manager']))
with check (public.has_org_role(organization_id, array['owner','manager']));

create policy price_history_read_finance on public.purchase_price_history for select to authenticated
using (public.has_org_role(organization_id, array['owner','manager','accountant']));
create policy price_history_write_lead on public.purchase_price_history for insert to authenticated
with check (public.has_org_role(organization_id, array['owner','manager']));

create policy stock_movements_read_member on public.stock_movements for select to authenticated
using (public.has_org_role(organization_id, array['owner','manager','staff']));
create policy stock_movements_insert_ops on public.stock_movements for insert to authenticated
with check (
  created_by = (select auth.uid()) and (
    public.has_org_role(organization_id, array['owner','manager'])
    or (public.has_org_role(organization_id, array['staff']) and movement_type in ('sale','waste'))
  )
);
create policy stock_movements_update_lead on public.stock_movements for update to authenticated
using (public.has_org_role(organization_id, array['owner','manager']))
with check (public.has_org_role(organization_id, array['owner','manager']));

create policy inventory_sessions_read_member on public.inventory_sessions for select to authenticated
using (public.has_org_role(organization_id, array['owner','manager','staff']));
create policy inventory_sessions_insert_member on public.inventory_sessions for insert to authenticated
with check (created_by = (select auth.uid()) and public.has_org_role(organization_id, array['owner','manager','staff']));
create policy inventory_sessions_update_member on public.inventory_sessions for update to authenticated
using (public.has_org_role(organization_id, array['owner','manager','staff']))
with check (public.has_org_role(organization_id, array['owner','manager','staff']));

create policy inventory_lines_read_member on public.inventory_lines for select to authenticated
using (public.has_org_role(organization_id, array['owner','manager','staff']));
create policy inventory_lines_insert_member on public.inventory_lines for insert to authenticated
with check (measured_by = (select auth.uid()) and public.has_org_role(organization_id, array['owner','manager','staff']));
create policy inventory_lines_update_lead on public.inventory_lines for update to authenticated
using (public.has_org_role(organization_id, array['owner','manager']))
with check (public.has_org_role(organization_id, array['owner','manager']));

create policy closings_read_member on public.closings for select to authenticated
using (public.has_org_role(organization_id, array['owner','manager','staff','accountant']));
create policy closings_insert_member on public.closings for insert to authenticated
with check (created_by = (select auth.uid()) and public.has_org_role(organization_id, array['owner','manager','staff']));
create policy closings_update_lead on public.closings for update to authenticated
using (public.has_org_role(organization_id, array['owner','manager']))
with check (public.has_org_role(organization_id, array['owner','manager']));

create policy closing_corrections_read_finance on public.closing_corrections for select to authenticated
using (public.has_org_role(organization_id, array['owner','manager','accountant']));
create policy closing_corrections_insert_lead on public.closing_corrections for insert to authenticated
with check (created_by = (select auth.uid()) and public.has_org_role(organization_id, array['owner','manager']));

drop policy if exists audit_events_insert_member on public.audit_events;
create policy audit_events_insert_member on public.audit_events for insert to authenticated
with check (
  actor_user_id = (select auth.uid())
  and public.has_org_role(organization_id, array['owner','manager','staff','accountant','service'])
);
