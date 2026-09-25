-- One register per venue. Only the authenticated Edge Function can mutate it.
create table public.pos_registers (
 venue_id uuid primary key references public.venues(id),
 organization_id uuid not null references public.organizations(id),
 revision bigint not null default 0 check(revision >= 0),
 state jsonb not null,
 updated_at timestamptz not null default now()
);
create table public.pos_requests (
 venue_id uuid not null references public.pos_registers(venue_id),
 request_id uuid not null,
 organization_id uuid not null references public.organizations(id),
 actor_id uuid not null references auth.users(id),
 request_hash text not null,
 result jsonb,
 revision bigint not null,
 created_at timestamptz not null default now(),
 primary key(venue_id,request_id)
);
create table public.pos_receipts (
 id uuid primary key,
 venue_id uuid not null references public.venues(id),
 organization_id uuid not null references public.organizations(id),
 actor_id uuid not null references auth.users(id),
 request_id uuid not null,
 kind text not null check(kind in ('sale','refund')),
 occurred_at timestamptz not null,
 payload jsonb not null,
 unique(venue_id,request_id)
);
create table public.pos_stock_lines (
 receipt_id uuid not null references public.pos_receipts(id),
 line_id uuid not null,
 venue_id uuid not null references public.venues(id),
 organization_id uuid not null references public.organizations(id),
 pos_product_id text not null,
 label text not null,
 quantity numeric not null check(quantity > 0),
 status text not null check(status in ('missing_recipe','posted','no_stock','shortage','restocked','cancelled')),
 recipe jsonb,
 reason text,
 updated_at timestamptz not null default now(),
 primary key(receipt_id,line_id)
);
create index pos_registers_org on public.pos_registers(organization_id);
create index pos_requests_org on public.pos_requests(organization_id);
create index pos_requests_actor on public.pos_requests(actor_id);
create index pos_receipts_org on public.pos_receipts(organization_id);
create index pos_receipts_actor on public.pos_receipts(actor_id);
create index pos_stock_lines_org on public.pos_stock_lines(organization_id);
create index pos_stock_lines_pending on public.pos_stock_lines(venue_id,status);
alter table public.pos_registers enable row level security;
alter table public.pos_requests enable row level security;
alter table public.pos_receipts enable row level security;
alter table public.pos_stock_lines enable row level security;
revoke all on public.pos_registers,public.pos_requests,public.pos_receipts,public.pos_stock_lines from anon,authenticated;
grant select on public.pos_registers,public.pos_receipts,public.pos_stock_lines to authenticated;
grant all on public.pos_registers,public.pos_requests,public.pos_receipts,public.pos_stock_lines to service_role;
create policy pos_register_read on public.pos_registers for select to authenticated using (
 exists(select 1 from public.memberships m where m.organization_id=pos_registers.organization_id and m.user_id=(select auth.uid()) and m.role in ('owner','manager','staff','accountant'))
);
create policy pos_receipt_read on public.pos_receipts for select to authenticated using (
 exists(select 1 from public.memberships m where m.organization_id=pos_receipts.organization_id and m.user_id=(select auth.uid()) and m.role in ('owner','manager','staff','accountant'))
);
create policy pos_stock_read on public.pos_stock_lines for select to authenticated using (
 exists(select 1 from public.memberships m where m.organization_id=pos_stock_lines.organization_id and m.user_id=(select auth.uid()) and m.role in ('owner','manager','staff','accountant'))
);
-- No client access to command deduplication or writes. Service role bypasses RLS.

create function public.pos_post_stock_line(p_receipt uuid,p_line jsonb,p_recipe jsonb,p_actor uuid)
returns void language plpgsql security invoker set search_path='' as $$
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
$$;

create function public.pos_commit(p_venue uuid,p_actor uuid,p_request uuid,p_hash text,p_expected bigint,p_type text,p_state jsonb,p_result jsonb)
returns jsonb language plpgsql security invoker set search_path='' as $$
declare
 org uuid;
 actor_role text;
 tz text;
 old public.pos_registers%rowtype;
 duplicate public.pos_requests%rowtype;
 l jsonb;
 r public.pos_receipts%rowtype;
 movement public.stock_movements%rowtype;
 receipt_uuid uuid;
 shift_id text;
 refund_total numeric;
begin
 select v.organization_id,v.timezone,m.role into org,tz,actor_role from public.venues v join public.memberships m on m.organization_id=v.organization_id and m.user_id=p_actor where v.id=p_venue;
 if org is null or actor_role not in ('owner','manager','staff') then raise exception 'Forbidden' using errcode='42501'; end if;
 if p_type not in ('openShift','newOrder','deleteOrder','addLine','removeLine','checkout','backup') and actor_role not in ('owner','manager') then raise exception 'Manager required' using errcode='42501'; end if;
 if p_type not in ('openShift','newOrder','deleteOrder','addLine','removeLine','checkout','backup','product','archiveProduct','importProducts','refund','cashMovement','closeShift','settings','recipe','resolveStock') then raise exception 'Unknown command'; end if;
 if p_state->>'venueId' is distinct from p_venue::text or jsonb_typeof(p_state->'orders') <> 'array' then raise exception 'Invalid register'; end if;
 insert into public.pos_registers(venue_id,organization_id,state) values(p_venue,org,'{}') on conflict(venue_id) do nothing;
 select * into strict old from public.pos_registers where venue_id=p_venue for update;
 select * into duplicate from public.pos_requests where venue_id=p_venue and request_id=p_request;
 if found then
  if duplicate.request_hash<>p_hash or duplicate.actor_id<>p_actor then raise exception 'Request ID reused with different input'; end if;
  return jsonb_build_object('revision',old.revision,'result',duplicate.result,'duplicate',true);
 end if;
 if old.revision<>p_expected then return jsonb_build_object('conflict',true,'revision',old.revision); end if;
 if (p_state->>'revision')::bigint <= p_expected then raise exception 'Invalid revision'; end if;
 if p_type in ('checkout','refund') then
  receipt_uuid:=(p_result->>'id')::uuid;
  if p_result->>'venueId' is distinct from p_venue::text then raise exception 'Receipt venue mismatch'; end if;
  insert into public.pos_receipts(id,venue_id,organization_id,actor_id,request_id,kind,occurred_at,payload)
  values(receipt_uuid,p_venue,org,p_actor,p_request,p_result->>'kind',(p_result->>'at')::timestamptz,p_result);
  if p_type='checkout' then
   for l in select value from jsonb_array_elements(p_result->'lines') loop
    perform public.pos_post_stock_line(receipt_uuid,l,l->'stockRecipe',p_actor);
   end loop;
  elsif coalesce((p_result->>'restock')::boolean,false) then
   select * into strict r from public.pos_receipts where id=(p_result->>'refundOf')::uuid and venue_id=p_venue and kind='sale';
   -- Return actual deducted quantities only. A financial refund alone never returns consumed stock.
   for movement in select * from public.stock_movements where venue_id=p_venue and source_type='pos_receipt' and source_id=r.id and movement_type='sale' order by product_id loop
    if movement.quantity_ml < 0 or movement.quantity_units < 0 then
     insert into public.stock_movements(organization_id,venue_id,product_id,movement_type,quantity_ml,quantity_units,source_type,source_id,reason,occurred_at,created_by)
     values(org,p_venue,movement.product_id,'manual_correction',-movement.quantity_ml,case when movement.quantity_units is not null then -movement.quantity_units else null end,'pos_refund',receipt_uuid,'Vrácené zboží: '||(p_result->>'reason'),(p_result->>'at')::timestamptz,p_actor);
    end if;
   end loop;
   update public.pos_stock_lines set status=case when status='missing_recipe' then 'cancelled' else 'restocked' end,updated_at=now() where receipt_id=r.id and status<>'no_stock';
  end if;
 elsif p_type='resolveStock' then
  select * into strict r from public.pos_receipts where id=(p_result->>'receiptId')::uuid and venue_id=p_venue and kind='sale';
  select value into strict l from jsonb_array_elements(r.payload->'lines') where value->>'id'=p_result->>'lineId';
  perform public.pos_post_stock_line(r.id,l,p_result->'recipe',p_actor);
 elsif p_type='closeShift' then
  shift_id:=p_result->>'id';
  select coalesce(sum(-(value->>'total')::numeric/100),0) into refund_total from jsonb_array_elements(p_state->'receipts') where value->>'shiftId'=shift_id and value->>'kind'='refund';
  insert into public.closings(organization_id,venue_id,business_date,source_type,source_fingerprint,cash_amount,card_amount,total_amount,transaction_count,refunds_amount,extracted_values,status,created_by)
  values(org,p_venue,((p_result->>'closedAt')::timestamptz at time zone coalesce(tz,'Europe/Prague'))::date,'pub_bizz_pos','pub-bizz-shift:'||shift_id,
    (p_result#>>'{summary,cash}')::numeric/100,(p_result#>>'{summary,card}')::numeric/100,(p_result#>>'{summary,total}')::numeric/100,(p_result#>>'{summary,count}')::integer,refund_total,
    jsonb_build_object('posShiftId',shift_id,'openedAt',p_result->>'openedAt','closedAt',p_result->>'closedAt','countedCash',(p_result->>'counted')::numeric/100,'cashDifference',(p_result->>'difference')::numeric/100),
    'review',p_actor);
 end if;
 update public.pos_registers set state=p_state,revision=(p_state->>'revision')::bigint,updated_at=now() where venue_id=p_venue;
 insert into public.pos_requests(venue_id,request_id,organization_id,actor_id,request_hash,result,revision)
 values(p_venue,p_request,org,p_actor,p_hash,p_result,(p_state->>'revision')::bigint);
 insert into public.audit_events(organization_id,venue_id,actor_user_id,event_type,entity_type,entity_id,after_data)
 values(org,p_venue,p_actor,'pos.'||p_type,'pos_register',p_venue,jsonb_build_object('requestId',p_request,'revision',p_state->'revision','receiptId',receipt_uuid));
 return jsonb_build_object('revision',p_state->'revision','result',p_result,'duplicate',false);
end;
$$;
revoke all on function public.pos_post_stock_line(uuid,jsonb,jsonb,uuid) from public,anon,authenticated;
revoke all on function public.pos_commit(uuid,uuid,uuid,text,bigint,text,jsonb,jsonb) from public,anon,authenticated;
grant execute on function public.pos_post_stock_line(uuid,jsonb,jsonb,uuid) to service_role;
grant execute on function public.pos_commit(uuid,uuid,uuid,text,bigint,text,jsonb,jsonb) to service_role;
comment on function public.pos_commit is 'Service-only atomic POS state, receipt, stock ledger and closing commit. The Edge Function validates the user and executes trusted domain commands.';
