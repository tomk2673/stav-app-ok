-- Add rename to the service-only command path while retaining live payment/stock logic.
-- Existing accounts, receipts, balances and stock are not rewritten by this migration.
do $migration$
declare
 definition text := pg_get_functiondef('public.pos_commit(uuid,uuid,uuid,text,bigint,text,jsonb,jsonb)'::regprocedure);
 commands text := '''newOrder'',''deleteOrder''';
 anchor text := ' if (p_state->>''revision'')::bigint <= p_expected then raise exception ''Invalid revision''; end if;';
 audit text := '''receiptId'',receipt_uuid)';
 guard text := $guard$
 -- POS_RENAME_ORDER_GUARD_V1
 if p_type='renameOrder' then
  if p_result->>'type' is distinct from 'renameOrder'
     or p_result->>'orderId' is null or p_result->>'orderId'='bar'
     or jsonb_typeof(p_result->'name') is distinct from 'string'
     or coalesce(length(p_result->>'name'),0) not between 1 and 120
     or p_result->>'name' is distinct from btrim(p_result->>'name')
     or p_state - array['revision','audit','orders'] is distinct from old.state - array['revision','audit','orders']
     or (p_state->>'revision')::bigint is distinct from old.revision+1
     or not exists(select 1 from jsonb_array_elements(old.state->'orders') o
       where o->>'id'=p_result->>'orderId' and o->>'name'=p_result->>'previousName'
         and o->'paymentLock' is null)
     or exists(select 1 from jsonb_array_elements(old.state->'orders') o
       where o->>'id'<>p_result->>'orderId' and lower(o->>'name')=lower(p_result->>'name'))
     or p_state->'orders' is distinct from (
       select jsonb_agg(case when o->>'id'=p_result->>'orderId'
         then jsonb_set(jsonb_set(o,'{name}',p_result->'name'),'{revision}',to_jsonb((o->>'revision')::bigint+1))
         else o end order by n) from jsonb_array_elements(old.state->'orders') with ordinality as t(o,n))
     or jsonb_typeof(p_state->'audit') is distinct from 'array'
     or jsonb_array_length(p_state->'audit') is distinct from jsonb_array_length(old.state->'audit')+1
     or (p_state->'audit') - jsonb_array_length(old.state->'audit') is distinct from old.state->'audit'
     or p_state#>array['audit',jsonb_array_length(old.state->'audit')::text,'rename'] is distinct from p_result
     or p_state#>>array['audit',jsonb_array_length(old.state->'audit')::text,'actorId'] is distinct from p_actor::text then
   raise exception 'Rename must preserve account items, visits, receipts, money and stock';
  end if;
 end if;
$guard$;
begin
 if strpos(definition,'-- POS_RENAME_ORDER_GUARD_V1')>0 then return; end if;
 if (length(definition)-length(replace(definition,commands,'')))/length(commands) <> 2
    or (length(definition)-length(replace(definition,anchor,'')))/length(anchor) <> 1
    or (length(definition)-length(replace(definition,audit,'')))/length(audit) <> 1 then
  raise exception 'pos_commit changed: review rename command anchors before applying';
 end if;
 definition := replace(definition,commands,'''newOrder'',''renameOrder'',''deleteOrder''');
 definition := replace(definition,anchor,anchor || guard);
 definition := replace(definition,audit,audit || ' || case when p_type=''renameOrder'' then jsonb_build_object(''rename'',p_result) else ''{}''::jsonb end');
 execute definition;
end;
$migration$;
