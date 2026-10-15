-- Customer prepaid credit is monetary value, separate from loyalty rewards.
-- Harden pos_commit so wallet movements cannot be smuggled through unrelated commands.
do $migration$
declare
 definition text := pg_get_functiondef('public.pos_commit(uuid,uuid,uuid,text,bigint,text,jsonb,jsonb)'::regprocedure);
 staff_old text := '''checkout'',''reassignReceipt'',''backup''';
 staff_new text := '''checkout'',''reassignReceipt'',''creditTopup'',''backup''';
 all_old text := '''checkout'',''reassignReceipt'',''backup'',''product''';
 all_new text := '''checkout'',''reassignReceipt'',''creditTopup'',''backup'',''product''';
 receipt_old text := 'or (p_result->>''card'')::bigint is distinct from -(r.payload->>''card'')::bigint';
 receipt_new text := 'or (p_result->>''card'')::bigint is distinct from -(r.payload->>''card'')::bigint
     or coalesce((p_result->>''credit'')::bigint,0) is distinct from -coalesce((r.payload->>''credit'')::bigint,0)';
 guard_anchor text := ' -- POS_RECEIPT_TERMINAL_GUARD_V1';
 closing_old text := '''cashDifference'',(p_result->>''difference'')::numeric/100)';
 closing_new text := '''cashDifference'',(p_result->>''difference'')::numeric/100,
      ''creditAmount'',coalesce((p_result#>>''{summary,credit}'')::numeric,0)/100,
      ''creditTopupCash'',coalesce((p_result#>>''{summary,creditTopupCash}'')::numeric,0)/100,
      ''creditTopupCard'',coalesce((p_result#>>''{summary,creditTopupCard}'')::numeric,0)/100,
      ''creditTopups'',coalesce((p_result#>>''{summary,creditTopups}'')::numeric,0)/100,
      ''terminalTotal'',coalesce((p_result#>>''{summary,terminal}'')::numeric,0)/100)';
 wallet_guard text := $guard$
 -- POS_CUSTOMER_CREDIT_GUARD_V1
 if p_type='creditTopup' then
  if p_result->>'type' is distinct from 'topup'
     or p_result->>'orderId' is null
     or p_result->>'customerId' is null
     or p_result->>'customerName' is null
     or p_result->>'shiftId' is null
     or p_result->>'actorId' is distinct from p_actor::text
     or p_result->>'method' not in ('cash','card')
     or jsonb_typeof(p_result->'amount') is distinct from 'number'
     or (p_result->>'amount')::bigint not between 1000 and 100000000
     or (p_result->>'method'='card' and p_result->'cardConfirmed' is distinct from 'true'::jsonb)
     or (p_result->>'method'='cash' and p_result->'cardConfirmed' is distinct from 'false'::jsonb)
     or p_state - array['revision','audit','orders','customers','creditLedger'] is distinct from old.state - array['revision','audit','orders','customers','creditLedger']
     or (p_state->>'revision')::bigint is distinct from old.revision+1
     or not exists(select 1 from jsonb_array_elements(old.state->'orders') o
       where o->>'id'=p_result->>'orderId' and o->>'name'=p_result->>'customerName' and o->>'id'<>'bar')
     or p_state->'orders' is distinct from (
       select jsonb_agg(case when o->>'id'=p_result->>'orderId'
         then jsonb_set(o,'{customerId}',to_jsonb(p_result->>'customerId'),true)
         else o end order by n)
       from jsonb_array_elements(old.state->'orders') with ordinality as t(o,n))
     or jsonb_typeof(p_state->'customers') is distinct from 'array'
     or (select count(*) from jsonb_array_elements(p_state->'customers') c where c->>'id'=p_result->>'customerId')<>1
     or not exists(select 1 from jsonb_array_elements(p_state->'customers') c
       where c->>'id'=p_result->>'customerId'
         and c->>'name'=p_result->>'customerName'
         and jsonb_typeof(c->'aliases')='array'
         and jsonb_typeof(c->'createdAt')='string'
         and c - array['id','name','aliases','createdAt'] = '{}'::jsonb
         and exists(select 1 from jsonb_array_elements_text(c->'aliases') a where lower(a)=lower(p_result->>'customerName')))
     or (select coalesce(jsonb_agg(c order by c->>'id'),'[]'::jsonb) from jsonb_array_elements(p_state->'customers') c where c->>'id'<>p_result->>'customerId')
        is distinct from
        (select coalesce(jsonb_agg(c order by c->>'id'),'[]'::jsonb) from jsonb_array_elements(coalesce(old.state->'customers','[]'::jsonb)) c where c->>'id'<>p_result->>'customerId')
     or exists(
       select 1 from jsonb_array_elements(coalesce(old.state->'customers','[]'::jsonb)) oc
       join jsonb_array_elements(p_state->'customers') nc on nc->>'id'=oc->>'id'
       where oc->>'id'=p_result->>'customerId'
         and (nc->>'createdAt' is distinct from oc->>'createdAt' or not coalesce(oc->'aliases','[]'::jsonb) <@ coalesce(nc->'aliases','[]'::jsonb)))
     or jsonb_typeof(p_state->'creditLedger') is distinct from 'array'
     or jsonb_array_length(p_state->'creditLedger') is distinct from jsonb_array_length(coalesce(old.state->'creditLedger','[]'::jsonb))+1
     or (p_state->'creditLedger') - jsonb_array_length(coalesce(old.state->'creditLedger','[]'::jsonb)) is distinct from coalesce(old.state->'creditLedger','[]'::jsonb)
     or p_state#>array['creditLedger',(jsonb_array_length(p_state->'creditLedger')-1)::text] is distinct from p_result-'balance'
     or (p_result->>'balance')::bigint is distinct from (
       select coalesce(sum((x->>'amount')::bigint),0) from jsonb_array_elements(p_state->'creditLedger') x where x->>'customerId'=p_result->>'customerId')
     or jsonb_typeof(p_state->'audit') is distinct from 'array'
     or jsonb_array_length(p_state->'audit') is distinct from jsonb_array_length(old.state->'audit')+1
     or (p_state->'audit') - jsonb_array_length(old.state->'audit') is distinct from old.state->'audit'
     or p_state#>>array['audit',jsonb_array_length(old.state->'audit')::text,'type'] is distinct from 'creditTopup'
     or p_state#>>array['audit',jsonb_array_length(old.state->'audit')::text,'actorId'] is distinct from p_actor::text then
    raise exception 'Credit topup must append one verified wallet movement only';
  end if;
 end if;

 if p_type='checkout' then
  if coalesce((p_result->>'credit')::bigint,0)>0 then
   if (p_result->>'cash')::bigint<>0
      or (p_result->>'card')::bigint<>0
      or (p_result->>'total')::bigint is distinct from (p_result->>'credit')::bigint
      or coalesce((p_result->>'rounding')::bigint,0)<>0
      or p_result->>'customerId' is null
      or jsonb_array_length(coalesce(p_state->'creditLedger','[]'::jsonb)) is distinct from jsonb_array_length(coalesce(old.state->'creditLedger','[]'::jsonb))+1
      or coalesce(p_state->'creditLedger','[]'::jsonb) - jsonb_array_length(coalesce(old.state->'creditLedger','[]'::jsonb)) is distinct from coalesce(old.state->'creditLedger','[]'::jsonb)
      or jsonb_typeof(p_state#>array['creditLedger',(jsonb_array_length(p_state->'creditLedger')-1)::text,'id']) is distinct from 'string'
      or (p_state#>array['creditLedger',(jsonb_array_length(p_state->'creditLedger')-1)::text]) - 'id' is distinct from
        jsonb_build_object('type','spend','customerId',p_result->>'customerId','customerName',p_result->>'orderName',
          'orderId',p_result->>'orderId','shiftId',p_result->>'shiftId','amount',-(p_result->>'credit')::bigint,
          'method','credit','receiptId',p_result->>'id','at',p_result->>'at','actorId',p_actor::text)
      or (select coalesce(sum((x->>'amount')::bigint),0) from jsonb_array_elements(coalesce(old.state->'creditLedger','[]'::jsonb)) x
          where x->>'customerId'=p_result->>'customerId') < (p_result->>'credit')::bigint then
     raise exception 'Credit checkout must debit exactly one funded wallet';
   end if;
  elsif coalesce(p_state->'creditLedger','[]'::jsonb) is distinct from coalesce(old.state->'creditLedger','[]'::jsonb) then
   raise exception 'Non-credit checkout cannot change customer credit';
  end if;
 end if;

 if p_type in ('refund','restoreReceipt') then
  if coalesce((p_result->>'credit')::bigint,0)<0 then
   if p_result->>'customerId' is null
      or jsonb_array_length(coalesce(p_state->'creditLedger','[]'::jsonb)) is distinct from jsonb_array_length(coalesce(old.state->'creditLedger','[]'::jsonb))+1
      or coalesce(p_state->'creditLedger','[]'::jsonb) - jsonb_array_length(coalesce(old.state->'creditLedger','[]'::jsonb)) is distinct from coalesce(old.state->'creditLedger','[]'::jsonb)
      or jsonb_typeof(p_state#>array['creditLedger',(jsonb_array_length(p_state->'creditLedger')-1)::text,'id']) is distinct from 'string'
      or (p_state#>array['creditLedger',(jsonb_array_length(p_state->'creditLedger')-1)::text]) - 'id' is distinct from
        jsonb_build_object('type','refund','customerId',p_result->>'customerId','customerName',p_result->>'orderName',
          'orderId',p_result->>'orderId','shiftId',p_result->>'shiftId','amount',-(p_result->>'credit')::bigint,
          'method','credit','receiptId',p_result->>'id','refundOf',p_result->>'refundOf','at',p_result->>'at','actorId',p_actor::text) then
     raise exception 'Credit refund must restore exactly one wallet movement';
   end if;
  elsif coalesce(p_state->'creditLedger','[]'::jsonb) is distinct from coalesce(old.state->'creditLedger','[]'::jsonb) then
   raise exception 'Non-credit refund cannot change customer credit';
  end if;
 end if;
$guard$;
begin
 if strpos(definition,'-- POS_CUSTOMER_CREDIT_GUARD_V1')>0 then return; end if;
 if (length(definition)-length(replace(definition,staff_old,'')))/length(staff_old) <> 1
    or (length(definition)-length(replace(definition,all_old,'')))/length(all_old) <> 1
    or (length(definition)-length(replace(definition,receipt_old,'')))/length(receipt_old) <> 1
    or (length(definition)-length(replace(definition,guard_anchor,'')))/length(guard_anchor) <> 1
    or (length(definition)-length(replace(definition,closing_old,'')))/length(closing_old) <> 1 then
  raise exception 'pos_commit changed: review customer-credit anchors before applying';
 end if;
 definition:=replace(definition,staff_old,staff_new);
 definition:=replace(definition,all_old,all_new);
 definition:=replace(definition,receipt_old,receipt_new);
 definition:=replace(definition,guard_anchor,wallet_guard||E'\n'||guard_anchor);
 definition:=replace(definition,closing_old,closing_new);
 execute definition;
 update public.pos_registers
 set state=jsonb_set(jsonb_set(state,'{customers}',coalesce(state->'customers','[]'::jsonb),true),'{creditLedger}',coalesce(state->'creditLedger','[]'::jsonb),true)
 where state->'customers' is null or state->'creditLedger' is null;
end;
$migration$;
