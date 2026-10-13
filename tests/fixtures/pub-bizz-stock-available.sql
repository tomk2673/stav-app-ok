-- Read-only snapshot of deployed stock functions, retrieved 2026-10-13.
-- Applied only to isolated PGlite test databases to preserve existing substitutions.
CREATE OR REPLACE FUNCTION public.pos_post_stock_line_v1(p_receipt uuid, p_line jsonb, p_recipe jsonb, p_actor uuid)
 RETURNS void
 LANGUAGE plpgsql
 SET search_path TO ''
AS $function$
declare
 r public.pos_receipts%rowtype;
 existing_status text;
 c jsonb;
 pr public.products%rowtype;
 q numeric;
 short_units numeric;
 has_shortage boolean:=false;
 why text;
begin
 select * into strict r from public.pos_receipts where id=p_receipt and kind='sale';
 select status into existing_status from public.pos_stock_lines where receipt_id=p_receipt and line_id=(p_line->>'id')::uuid for update;
 if found and existing_status <> 'missing_recipe' then raise exception 'Stock line already processed'; end if;
 if p_recipe is null or p_recipe='null'::jsonb then why:='Chybí receptura';
 elsif p_recipe->>'mode'='no_stock' then
  if nullif(btrim(p_recipe->>'reason'),'') is null then raise exception 'No-stock reason required'; end if;
 elsif p_recipe->>'mode'='recipe' and jsonb_array_length(p_recipe->'components') between 1 and 30 then
  for c in select value from jsonb_array_elements(p_recipe->'components') loop
   select * into pr from public.products where id=(c->>'productId')::uuid and organization_id=r.organization_id and archived_at is null;
   if not found then why:='Surovina není dostupná ve skladu'; exit; end if;
   if (c->>'quantity')::numeric <= 0 or (c->>'quantity')::numeric > 1000000 then raise exception 'Invalid recipe quantity'; end if;
   if c->>'unit' is distinct from (case when pr.unit_mode='counted' then 'ks' else 'ml' end) then why:='Změněná jednotka suroviny'; exit; end if;
  end loop;
 else raise exception 'Invalid recipe'; end if;
 insert into public.pos_stock_lines(receipt_id,line_id,venue_id,organization_id,pos_product_id,label,quantity,status,recipe,reason)
 values(r.id,(p_line->>'id')::uuid,r.venue_id,r.organization_id,p_line->>'productId',p_line->>'name',(p_line->>'quantity')::numeric,
 case when why is not null then 'missing_recipe' when p_recipe->>'mode'='no_stock' then 'no_stock' else 'posted' end,p_recipe,coalesce(why,p_recipe->>'reason'))
 on conflict(receipt_id,line_id) do update set status=excluded.status,recipe=excluded.recipe,reason=excluded.reason,updated_at=now();
 if why is not null or p_recipe->>'mode'='no_stock' then return; end if;
 -- Deterministic order also avoids lock inversion with counted-stock ledger locks.
 for c in select value from jsonb_array_elements(p_recipe->'components') order by value->>'productId' loop
  q:=(c->>'quantity')::numeric * (p_line->>'quantity')::numeric;
  insert into public.stock_movements(organization_id,venue_id,product_id,movement_type,quantity_ml,quantity_units,source_type,source_id,reason,occurred_at,created_by)
  values(r.organization_id,r.venue_id,(c->>'productId')::uuid,'sale',case when c->>'unit'='ml' then -q else 0 end,
    case when c->>'unit'='ks' then -q else null end,'pos_receipt',r.id,'PUB-BIZZ '||(r.payload->>'number'),r.occurred_at,p_actor)
  returning untracked_units into short_units;
  if short_units > 0 then has_shortage:=true; end if;
 end loop;
 if has_shortage then update public.pos_stock_lines set status='shortage',reason='Část kusového prodeje neměla naskladněný zůstatek; viz skladové pohyby.' where receipt_id=r.id and line_id=(p_line->>'id')::uuid; end if;
end;
$function$;
ALTER TABLE public.pos_stock_lines DROP CONSTRAINT pos_stock_lines_status_check;
ALTER TABLE public.pos_stock_lines ADD CONSTRAINT pos_stock_lines_status_check CHECK ((status = ANY (ARRAY['missing_recipe'::text, 'posted'::text, 'no_stock'::text, 'shortage'::text, 'awaiting_stock'::text, 'restocked'::text, 'cancelled'::text])));
CREATE OR REPLACE FUNCTION public.pos_post_stock_line(p_receipt uuid, p_line jsonb, p_recipe jsonb, p_actor uuid)
 RETURNS void
 LANGUAGE plpgsql
 SET search_path TO ''
AS $function$
declare
 r public.pos_receipts%rowtype; old public.pos_stock_lines%rowtype;
 c jsonb; resolved jsonb:='[]'; reserved jsonb:='{}';
 candidate text; lock_id text; ids jsonb; pr public.products%rowtype;
 remaining numeric; available numeric; portions numeric; need numeric; q numeric;
 why text; final_status text;
begin
 select * into strict r from public.pos_receipts where id=p_receipt and kind='sale';
 select * into old from public.pos_stock_lines where receipt_id=p_receipt and line_id=(p_line->>'id')::uuid for update;
 if found and old.status not in ('missing_recipe','awaiting_stock') then raise exception 'Stock line already processed'; end if;
 -- A retry may not silently change the historical recipe or substitution order.
 if old.status='awaiting_stock' then p_recipe:=old.recipe-'resolvedComponents'; end if;
 if coalesce(p_recipe->>'selection','')<>'available' or p_recipe->>'mode'='no_stock' then
  perform public.pos_post_stock_line_v1(p_receipt,p_line,p_recipe,p_actor); return;
 end if;
 if p_recipe->>'mode'<>'recipe' or jsonb_array_length(p_recipe->'components') not between 1 and 30 then raise exception 'Invalid recipe'; end if;
 if (p_line->>'quantity')::numeric<=0 then raise exception 'Invalid sale quantity'; end if;
 -- Lock ALL candidates in stable order before checking their live balances.
 for lock_id in
  select distinct id from jsonb_array_elements(p_recipe->'components') component
  cross join lateral jsonb_array_elements_text(jsonb_build_array(component->>'productId')||coalesce(component->'alternatives','[]')) a(id)
  order by id
 loop
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(r.venue_id::text||':'||lock_id,0));
 end loop;
 for c in select value from jsonb_array_elements(p_recipe->'components') loop
  need:=(c->>'quantity')::numeric;
  if need is null or need<=0 or need>1000000 then raise exception 'Invalid recipe quantity'; end if;
  remaining:=(p_line->>'quantity')::numeric;
  ids:=jsonb_build_array(c->>'productId')||coalesce(c->'alternatives','[]');
  if jsonb_array_length(ids)>6 then raise exception 'Too many alternatives'; end if;
  for candidate in select value from jsonb_array_elements_text(ids) loop
   select * into pr from public.products where id=candidate::uuid and organization_id=r.organization_id;
   if not found or (c->>'unit') is distinct from (case when pr.unit_mode='counted' then 'ks' else 'ml' end) then raise exception 'Invalid candidate or unit'; end if;
   if pr.archived_at is not null then continue; end if;
   select coalesce(sum(case when c->>'unit'='ks' then m.quantity_units else m.quantity_ml end),0)
    into available from public.stock_movements m where m.venue_id=r.venue_id and m.product_id=pr.id and m.organization_id=r.organization_id;
   available:=greatest(available-coalesce((reserved->>candidate)::numeric,0),0);
   portions:=least(remaining,floor(available/need));
   if portions>0 then
    q:=portions*need;
    reserved:=jsonb_set(reserved,array[candidate],to_jsonb(coalesce((reserved->>candidate)::numeric,0)+q));
    resolved:=resolved||jsonb_build_array(jsonb_build_object('productId',candidate,'requestedProductId',c->>'productId','quantity',q,'unit',c->>'unit','portions',portions,'substituted',candidate<>c->>'productId'));
    remaining:=remaining-portions;
   end if;
   exit when remaining=0;
  end loop;
  if remaining>0 then why:='Chybí evidovaná zásoba pro surovinu nebo její náhrady. Prodej je uložený; ověř výchozí inventuru a skutečně použitou surovinu.'; exit; end if;
 end loop;
 final_status:=case when why is null then 'posted' else 'awaiting_stock' end;
 insert into public.pos_stock_lines(receipt_id,line_id,venue_id,organization_id,pos_product_id,label,quantity,status,recipe,reason)
 values(r.id,(p_line->>'id')::uuid,r.venue_id,r.organization_id,p_line->>'productId',p_line->>'name',(p_line->>'quantity')::numeric,
 final_status,p_recipe||jsonb_build_object('resolvedComponents',case when why is null then resolved else '[]'::jsonb end),coalesce(why,p_recipe->>'reason'))
 on conflict(receipt_id,line_id) do update set status=excluded.status,recipe=excluded.recipe,reason=excluded.reason,updated_at=now();
 if why is not null then return; end if;
 for c in select value from jsonb_array_elements(resolved) order by value->>'productId' loop
  q:=(c->>'quantity')::numeric;
  insert into public.stock_movements(organization_id,venue_id,product_id,movement_type,quantity_ml,quantity_units,source_type,source_id,reason,occurred_at,created_by)
  values(r.organization_id,r.venue_id,(c->>'productId')::uuid,'sale',case when c->>'unit'='ml' then -q else 0 end,case when c->>'unit'='ks' then -q else null end,
   'pos_receipt',r.id,'POS '||(p_line->>'id')||': '||(p_line->>'name')||case when (c->>'substituted')::boolean then ' [náhrada za '||(c->>'requestedProductId')||']' else '' end,r.occurred_at,p_actor);
 end loop;
end; $function$;
