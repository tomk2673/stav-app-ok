-- Uses only temporary fixture rows; every write is rolled back.
begin;
set local statement_timeout = '10s';
set local lock_timeout = '2s';
set local role service_role;
do $test$
declare
 actor uuid; org uuid := gen_random_uuid(); venue uuid := gen_random_uuid();
 request uuid := gen_random_uuid(); state jsonb; merged jsonb; result jsonb; answer jsonb;
begin
 select user_id into strict actor from public.memberships where role='owner' limit 1;
 insert into public.organizations(id,name,created_by) values(org,'POS merge regression',actor);
 insert into public.memberships(organization_id,user_id,role) values(org,actor,'staff');
 insert into public.venues(id,organization_id,name,created_by) values(venue,org,'POS merge regression',actor);
 state := jsonb_build_object('schema',1,'venueId',venue,'revision',0,'orders',
  '[{"id":"bar","name":"Rychlý prodej","revision":0,"lines":[]},{"id":"source","name":"Stůl 1","revision":1,"lines":[{"id":"a","price":4200,"quantity":1}]},{"id":"target","name":"Petr","revision":1,"lines":[{"id":"b","price":4200,"quantity":2}]}]'::jsonb);
 insert into public.pos_registers(venue_id,organization_id,state,revision) values(venue,org,state,0);
 merged := state || jsonb_build_object('revision',1,'orders',
  '[{"id":"bar","name":"Rychlý prodej","revision":0,"lines":[]},{"id":"source","name":"Stůl 1","revision":2,"lines":[]},{"id":"target","name":"Petr","revision":2,"lines":[{"id":"b","price":4200,"quantity":3}]}]'::jsonb);
 result := '{"type":"mergeOrders","orderId":"target","name":"Petr","sourceOrderId":"source","sourceName":"Stůl 1","sourceTotal":4200,"total":12600,"movedQuantity":1}'::jsonb;
 answer := public.pos_commit(venue,actor,request,'merge-regression',0,'mergeOrders',merged,result);
 if answer->>'duplicate'<>'false' or answer->'result' is distinct from result then raise exception 'Staff merge failed'; end if;
 if (select r.state from public.pos_registers r where venue_id=venue) is distinct from merged then raise exception 'Merge was not stored atomically'; end if;
 answer := public.pos_commit(venue,actor,request,'merge-regression',0,'mergeOrders',merged,result);
 if answer->>'duplicate'<>'true' then raise exception 'Retry not deduplicated'; end if;
 if (select count(*) from public.pos_requests where venue_id=venue)<>1 then raise exception 'Duplicate journal'; end if;
 if (select count(*) from public.audit_events where venue_id=venue and event_type='pos.mergeOrders' and after_data->'merge'=result)<>1 then raise exception 'Missing or duplicate merge audit'; end if;
 answer := public.pos_commit(venue,actor,gen_random_uuid(),'stale-merge',0,'mergeOrders',merged,result);
 if answer->>'conflict'<>'true' then raise exception 'Stale register accepted'; end if;
 begin
  perform public.pos_commit(venue,actor,gen_random_uuid(),'staff-settings',1,'settings',merged,result);
  raise exception 'Staff settings unexpectedly accepted';
 exception when insufficient_privilege then null;
 end;
 update public.memberships set role='accountant' where organization_id=org and user_id=actor;
 begin
  perform public.pos_commit(venue,actor,gen_random_uuid(),'accountant-merge',1,'mergeOrders',merged,result);
  raise exception 'Accountant merge unexpectedly accepted';
 exception when insufficient_privilege then null;
 end;
 if exists(select 1 from public.pos_receipts where venue_id=venue) then raise exception 'Merge created a receipt'; end if;
 if exists(select 1 from public.stock_movements where venue_id=venue) then raise exception 'Merge changed stock'; end if;
end;
$test$;
rollback;
