-- Patch the existing service-only commit without replacing live stock/closing logic.
-- No financial, receipt or inventory rows are rewritten by this migration.
do $migration$
declare
 definition text := pg_get_functiondef('public.pos_commit(uuid,uuid,uuid,text,bigint,text,jsonb,jsonb)'::regprocedure);
 commands text := '''checkout'',''restoreReceipt'',''backup''';
 refunds text := '''importProducts'',''refund'',''cashMovement''';
 branch text := ' if p_type in (''checkout'',''refund'',''restoreReceipt'') then';
 audit text := '''receiptId'',receipt_uuid)';
 guard text := $guard$
 -- POS_RECEIPT_TERMINAL_GUARD_V1
 if p_type in ('refund','restoreReceipt') then
  select * into strict r from public.pos_receipts
   where id=(p_result->>'refundOf')::uuid and venue_id=p_venue and kind='sale';
  if p_result->>'kind' is distinct from 'refund'
     or jsonb_typeof(r.payload->'card') is distinct from 'number'
     or (p_result->>'cash')::bigint is distinct from -(r.payload->>'cash')::bigint
     or (p_result->>'card')::bigint is distinct from -(r.payload->>'card')::bigint
     or (p_result->>'total')::bigint is distinct from -(r.payload->>'total')::bigint
     or (p_result->>'rounding')::bigint is distinct from -(r.payload->>'rounding')::bigint
     or nullif(btrim(p_result->>'reason'),'') is null then
   raise exception 'Invalid receipt reversal';
  end if;
  if exists(select 1 from public.pos_receipts x where x.venue_id=p_venue and x.payload->>'refundOf'=r.id::text) then
   raise exception 'Receipt already reversed';
  end if;
  -- Use the immutable original card exposure, including combined payments.
  if (r.payload->>'card')::bigint > 0 and (
     p_result#>>'{terminalConfirmation,method}' is distinct from 'manual'
     or p_result#>'{terminalConfirmation,confirmed}' is distinct from 'true'::jsonb
     or jsonb_typeof(p_result#>'{terminalConfirmation,reference}') is distinct from 'string'
     or coalesce(length(btrim(p_result#>>'{terminalConfirmation,reference}')),0) not between 1 and 120
     or p_result#>>'{terminalConfirmation,actorId}' is distinct from p_actor::text
     or p_result#>>'{terminalConfirmation,at}' is distinct from p_result->>'at') then
   raise exception 'Terminal refund confirmation required';
  end if;
 elsif p_type='reassignReceipt' then
  select * into strict r from public.pos_receipts where id=(p_result->>'receiptId')::uuid and venue_id=p_venue and kind='sale';
  if p_result->>'type' is distinct from 'reassignReceipt'
     or p_state - array['revision','audit','receiptAssignments'] is distinct from old.state - array['revision','audit','receiptAssignments']
     or jsonb_typeof(p_state->'receiptAssignments') is distinct from 'object'
     or (p_state->'receiptAssignments') - r.id::text is distinct from coalesce(old.state->'receiptAssignments','{}'::jsonb) - r.id::text
     or (p_state->'receiptAssignments')->r.id::text is distinct from jsonb_build_object('orderId',p_result->>'orderId','orderName',p_result->>'orderName','at',p_result->>'at')
     or p_result->>'previousOrderId' is distinct from coalesce(old.state#>>array['receiptAssignments',r.id::text,'orderId'],r.payload->>'orderId')
     or p_result->>'orderId' is not distinct from p_result->>'previousOrderId'
     or nullif(btrim(p_result->>'reason'),'') is null
     or not exists(select 1 from jsonb_array_elements(old.state->'orders') o where o->>'id'=p_result->>'orderId' and o->>'name'=p_result->>'orderName')
     or exists(select 1 from public.pos_receipts x where x.venue_id=p_venue and x.payload->>'refundOf'=r.id::text) then
   raise exception 'Receipt assignment must preserve paid receipts, orders, money and stock';
  end if;
 end if;
$guard$;
begin
 if strpos(definition,'-- POS_RECEIPT_TERMINAL_GUARD_V1')>0 then return; end if;
 if (length(definition)-length(replace(definition,commands,'')))/length(commands) <> 2
    or (length(definition)-length(replace(definition,refunds,'')))/length(refunds) <> 1
    or strpos(definition,branch)=0 or strpos(definition,audit)=0 then
  raise exception 'pos_commit changed: review receipt command guards before applying';
 end if;
 definition := replace(definition,commands,'''checkout'',''reassignReceipt'',''backup''');
 definition := replace(definition,refunds,'''importProducts'',''refund'',''restoreReceipt'',''cashMovement''');
 definition := replace(definition,branch,guard || branch);
 definition := replace(definition,audit,audit || ' || case when p_type in (''refund'',''restoreReceipt'',''reassignReceipt'') then jsonb_build_object(''correction'',p_result) else ''{}''::jsonb end');
 execute definition;
end;
$migration$;
notify pgrst, 'reload schema';
