-- Run against a seeded database as an administrator. All writes are rolled back.
begin;
set local role service_role;
do $test$
declare
 v uuid; actor uuid; org uuid; rev bigint; s jsonb;
 req uuid:=gen_random_uuid(); answer jsonb; n integer;
begin
 select x.id,x.organization_id,m.user_id into strict v,org,actor
 from public.venues x join public.memberships m on m.organization_id=x.organization_id
 where m.role='owner' order by x.id limit 1;
 select revision,state into rev,s from public.pos_registers where venue_id=v;
 rev:=coalesce(rev,0);
 s:=coalesce(s,'{}'::jsonb)||jsonb_build_object('venueId',v,'revision',rev+1,'orders',coalesce(s->'orders','[]'::jsonb));
 answer:=public.pos_commit(v,actor,req,'audit-guard-regression',rev,'openShift',s,'{}'::jsonb);
 if answer->>'duplicate'<>'false' or answer->>'revision'<>(rev+1)::text then raise exception 'Initial commit failed: %',answer; end if;
 answer:=public.pos_commit(v,actor,req,'audit-guard-regression',rev,'openShift',s,'{}'::jsonb);
 if answer->>'duplicate'<>'true' then raise exception 'Duplicate not detected'; end if;
 select count(*) into n from public.audit_events where after_data->>'requestId'=req::text;
 if n<>1 then raise exception 'Expected exactly one audit, got %',n; end if;
 begin
  perform public.pos_commit(v,gen_random_uuid(),gen_random_uuid(),'unauthorized',rev+1,'openShift',s,'{}'::jsonb);
  raise exception 'Unauthorized actor accepted';
 exception when insufficient_privilege then null;
 end;
 begin
  insert into public.audit_events(organization_id,venue_id,actor_user_id,event_type,entity_type,entity_id)
  values(org,v,actor,'product.saved','pos_register',v);
  raise exception 'Privileged audit guard bypassed';
 exception when insufficient_privilege then null;
 end;
end;
$test$;
rollback;