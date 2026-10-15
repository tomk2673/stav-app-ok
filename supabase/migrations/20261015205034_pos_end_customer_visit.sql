-- Add a service-only visit closure command. It cannot change a debt, receipt or stock.
do $migration$
declare
 definition text := pg_get_functiondef('public.pos_commit(uuid,uuid,uuid,text,bigint,text,jsonb,jsonb)'::regprocedure);
 commands text := '''renameOrder'',''deleteOrder''';
 anchor text := ' if (p_state->>''revision'')::bigint <= p_expected then raise exception ''Invalid revision''; end if;';
 audit text := '''receiptId'',receipt_uuid)';
 guard text := $guard$
 -- POS_END_CUSTOMER_VISIT_GUARD_V1
 if p_type='endVisit' then
  if p_result->>'type' is distinct from 'endVisit'
     or p_result->>'orderId' is null or p_result->>'orderId'='bar'
     or p_result->>'reason' is distinct from 'manual'
     or (p_result->>'estimated')::boolean is distinct from false
     or (p_result->>'active')::boolean is distinct from false
     or (p_result->>'endedAt')::timestamptz > statement_timestamp()+interval '5 seconds'
     or (p_result->>'endedAt')::timestamptz < (p_result->>'startedAt')::timestamptz
     or (p_result->>'durationMinutes')::bigint is distinct from floor(extract(epoch from ((p_result->>'endedAt')::timestamptz-(p_result->>'startedAt')::timestamptz))/60)::bigint
     or p_state - array['revision','audit','orders'] is distinct from old.state - array['revision','audit','orders']
     or (p_state->>'revision')::bigint is distinct from old.revision+1
     or not exists(select 1 from jsonb_array_elements(old.state->'orders') o
       where o->>'id'=p_result->>'orderId' and o->>'visitStartedAt' is not null
         and (p_result->>'startedAt')::timestamptz >= (o->>'visitStartedAt')::timestamptz
         and o->'paymentLock' is null)
     or p_state->'orders' is distinct from (
       select jsonb_agg(case when o->>'id'=p_result->>'orderId'
         then jsonb_set(jsonb_set(jsonb_set(o,'{visitEndedAt}',p_result->'endedAt'),'{visitEndEstimated}','false'::jsonb),'{revision}',to_jsonb((o->>'revision')::bigint+1))
         else o end order by n) from jsonb_array_elements(old.state->'orders') with ordinality as t(o,n))
     or jsonb_typeof(p_state->'audit') is distinct from 'array'
     or jsonb_array_length(p_state->'audit') is distinct from jsonb_array_length(old.state->'audit')+1
     or (p_state->'audit') - jsonb_array_length(old.state->'audit') is distinct from old.state->'audit'
     or p_state#>array['audit',jsonb_array_length(old.state->'audit')::text,'visit'] is distinct from p_result
     or p_state#>>array['audit',jsonb_array_length(old.state->'audit')::text,'actorId'] is distinct from p_actor::text then
   raise exception 'Visit closure must preserve account items, debts, receipts, money and stock';
  end if;
 end if;
$guard$;
begin
 if strpos(definition,'-- POS_END_CUSTOMER_VISIT_GUARD_V1')>0 then return; end if;
 if (length(definition)-length(replace(definition,commands,'')))/length(commands) <> 2
    or (length(definition)-length(replace(definition,anchor,'')))/length(anchor) <> 1
    or (length(definition)-length(replace(definition,audit,'')))/length(audit) <> 1 then
  raise exception 'pos_commit changed: review visit command anchors before applying';
 end if;
 definition := replace(definition,commands,'''renameOrder'',''endVisit'',''deleteOrder''');
 definition := replace(definition,anchor,anchor || guard);
 definition := replace(definition,audit,audit || ' || case when p_type=''endVisit'' then jsonb_build_object(''visit'',p_result) else ''{}''::jsonb end');
 execute definition;
end;
$migration$;
