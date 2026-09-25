create or replace function public.pos_commit(p_venue uuid,p_actor uuid,p_request uuid,p_hash text,p_expected bigint,p_type text,p_state jsonb,p_result jsonb)
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
 if p_type not in ('openShift','newOrder','deleteOrder','addLine','removeLine','beginPayment','cancelPayment','checkout','backup') and actor_role not in ('owner','manager') then raise exception 'Manager required' using errcode='42501'; end if;
 if p_type not in ('openShift','newOrder','deleteOrder','addLine','removeLine','beginPayment','cancelPayment','checkout','backup','product','archiveProduct','importProducts','refund','cashMovement','closeShift','settings','recipe','resolveStock') then raise exception 'Unknown command'; end if;
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

create policy pos_requests_no_client on public.pos_requests for all to authenticated using (false) with check (false);
