-- One SQL statement gives inventory a consistent ledger snapshot, without the
-- PostgREST per-table row cap. Existing table RLS still applies to every subquery.
create function public.pos_inventory_snapshot(p_venue uuid)
returns jsonb language sql stable security invoker set search_path='' as $$
 select jsonb_build_object(
  'asOf',statement_timestamp(),
  'products',coalesce((select jsonb_agg(to_jsonb(p) order by p.name,p.id) from public.products p where p.organization_id=v.organization_id and p.archived_at is null),'[]'::jsonb),
  'movements',coalesce((select jsonb_agg(to_jsonb(m) order by m.occurred_at,m.id) from public.stock_movements m where m.organization_id=v.organization_id and m.venue_id=v.id),'[]'::jsonb),
  'pendingPosCount',(select count(*) from public.pos_stock_lines l where l.organization_id=v.organization_id and l.venue_id=v.id and l.status='missing_recipe')
 ) from public.venues v where v.id=p_venue;
$$;
revoke all on function public.pos_inventory_snapshot(uuid) from public,anon;
grant execute on function public.pos_inventory_snapshot(uuid) to authenticated,service_role;
comment on function public.pos_inventory_snapshot(uuid) is 'RLS-protected, consistent shared inventory snapshot including POS sales, invoice receipts and pending recipe count.';
