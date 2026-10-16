-- Inventory issue vouchers share the immutable POS document store, but are NOT
-- financial receipts: they never enter state.receipts, revenue, points or payments.
alter table public.pos_receipts drop constraint pos_receipts_kind_check;
alter table public.pos_receipts add constraint pos_receipts_kind_check check(kind in ('sale','refund','issue'));
alter table public.pos_stock_lines drop constraint pos_stock_lines_status_check;
alter table public.pos_stock_lines add constraint pos_stock_lines_status_check
 check(status in ('missing_recipe','posted','no_stock','shortage','awaiting_stock','restocked','cancelled','issued'));

create or replace function public.pos_customer_key(p_name text) returns text
language sql immutable strict set search_path='' as $$
 select btrim(regexp_replace(normalize(lower(p_name),NFD),U&'[\0300-\036f]','','g'));
$$;
create or replace function public.pos_customer_like(p_name text) returns boolean
language sql immutable set search_path='' as $$
 select coalesce(public.pos_customer_key(p_name) not in ('','rychly prodej') and p_name !~* '^(st[ůu]l\s*#?\s*)?\d+\y',false);
$$;

create or replace function public.pos_guard_customer_rename(a jsonb,b jsonb,r jsonb,actor uuid) returns void
language plpgsql set search_path='' as $$
declare o jsonb;c jsonb;expected jsonb;aliases jsonb;alias text;named boolean;
begin
 select value into o from jsonb_array_elements(a->'orders') where value->>'id'=r->>'orderId';
 named:=public.pos_customer_like(r->>'name');
 select value into c from jsonb_array_elements(coalesce(a->'customers','[]')) where value->>'id'=o->>'customerId';
 expected:=coalesce(a->'customers','[]');
 if c is not null and named then
  aliases:=coalesce(c->'aliases','[]');
  foreach alias in array array[o->>'name',r->>'name'] loop
   if not exists(select 1 from jsonb_array_elements_text(aliases) x where public.pos_customer_key(x)=public.pos_customer_key(alias)) then aliases:=aliases||jsonb_build_array(alias);end if;
  end loop;
  select jsonb_agg(case when x->>'id'=c->>'id' then jsonb_set(jsonb_set(x,'{name}',r->'name'),'{aliases}',aliases) else x end order by n)
   into expected from jsonb_array_elements(expected) with ordinality as t(x,n);
 end if;
 if r->>'type' is distinct from 'renameOrder' or o is null or o->>'id'='bar'
    or jsonb_typeof(r->'name') is distinct from 'string' or length(r->>'name') not between 1 and 120 or r->>'name' is distinct from btrim(r->>'name')
    or o->>'name' is distinct from r->>'previousName' or o->'paymentLock' is not null
    or exists(select 1 from jsonb_array_elements(a->'orders') x where x->>'id'<>o->>'id' and lower(x->>'name')=lower(r->>'name'))
    or (named and exists(select 1 from jsonb_array_elements(coalesce(a->'customers','[]')) x
      where x->>'id' is distinct from o->>'customerId' and (public.pos_customer_key(x->>'name')=public.pos_customer_key(r->>'name')
       or exists(select 1 from jsonb_array_elements_text(x->'aliases') y where public.pos_customer_key(y)=public.pos_customer_key(r->>'name')))))
    or (not named and (select coalesce(sum((x->>'amount')::bigint),0) from jsonb_array_elements(coalesce(a->'creditLedger','[]')) x where x->>'customerId'=o->>'customerId')<>0)
    or b-array['revision','audit','orders','customers'] is distinct from a-array['revision','audit','orders','customers']
    or coalesce(b->'customers','[]') is distinct from expected
    or (b->>'revision')::bigint is distinct from (a->>'revision')::bigint+1
    or b->'orders' is distinct from (select jsonb_agg(case when x->>'id'=o->>'id'
      then jsonb_set(jsonb_set(case when named then x else x-'customerId' end,'{name}',r->'name'),'{revision}',to_jsonb((x->>'revision')::bigint+1)) else x end order by n)
      from jsonb_array_elements(a->'orders') with ordinality as t(x,n))
    or jsonb_array_length(b->'audit') is distinct from jsonb_array_length(a->'audit')+1
    or (b->'audit')-jsonb_array_length(a->'audit') is distinct from a->'audit'
    or b#>array['audit',jsonb_array_length(a->'audit')::text,'rename'] is distinct from r
    or b#>>array['audit',jsonb_array_length(a->'audit')::text,'actorId'] is distinct from actor::text then
  raise exception 'Rename must preserve customer identity, account items, visits, receipts, money and stock';
 end if;
end;$$;

create or replace function public.pos_guard_credit_v2(a jsonb,b jsonb,command text,r jsonb,actor uuid) returns void
language plpgsql set search_path='' as $$
declare previous jsonb:=coalesce(a->'creditLedger','[]');ledger jsonb:=coalesce(b->'creditLedger','[]');original jsonb;entry jsonb;shift text;
begin
 if command not in ('creditTopup','creditReverse','checkout','refund','restoreReceipt') and ledger is distinct from previous then raise exception 'Only a verified monetary command may change credit';end if;
 if exists(select 1 from jsonb_array_elements(ledger) x group by x->>'id' having count(*)>1)
    or exists(select 1 from jsonb_array_elements(ledger) x group by x->>'customerId' having sum((x->>'amount')::bigint)<0)
    or exists(select 1 from jsonb_array_elements(ledger) x where not exists(select 1 from jsonb_array_elements(coalesce(b->'customers','[]')) c where c->>'id'=x->>'customerId')) then raise exception 'Invalid credit ledger or negative balance';end if;
 if command='creditTopup' and (not exists(select 1 from jsonb_array_elements(a->'shifts') x where x->>'id'=r->>'shiftId' and x->'closedAt'='null'::jsonb)
    or (r->>'method'='cash' and (r->>'amount')::bigint%100<>0)) then raise exception 'Credit topup must belong to the open shift and use whole cash CZK';end if;
 if command='creditTopup' and r->>'method'='card' and not exists(select 1 from jsonb_array_elements(a->'orders') x where x->>'id'=r->>'orderId'
    and x#>>'{paymentLock,purpose}'='creditTopup' and x#>>'{paymentLock,shiftId}'=r->>'shiftId' and (x#>>'{paymentLock,amount}')::bigint=(r->>'amount')::bigint)
    then raise exception 'Card credit topup requires its original payment reservation';end if;
 if command='checkout' and exists(select 1 from jsonb_array_elements(a->'orders') x where x->>'id'=r->>'orderId' and x#>>'{paymentLock,purpose}'='creditTopup') then raise exception 'Funding reservation cannot be used for a sale';end if;
 if command='checkout' and coalesce((r->>'credit')::bigint,0)>0 and not exists(select 1 from jsonb_array_elements(a->'orders') x where x->>'id'=r->>'orderId' and x->>'customerId'=r->>'customerId') then raise exception 'Credit checkout must use the account owner wallet';end if;
 if command in ('refund','restoreReceipt') and coalesce((r->>'credit')::bigint,0)<0 and not exists(select 1 from public.pos_receipts x where x.id=(r->>'refundOf')::uuid and x.venue_id=(a->>'venueId')::uuid and x.payload->>'customerId'=r->>'customerId') then raise exception 'Credit refund must restore the original payer wallet';end if;
 if command='creditReverse' then
  select value into original from jsonb_array_elements(previous) where value->>'id'=r->>'reversalOf' and value->>'type'='topup';
  select value->>'id' into shift from jsonb_array_elements(a->'shifts') where value->'closedAt'='null'::jsonb;
  entry:=r-'balance';
  if original is null or shift is null or r->>'type' is distinct from 'reversal'
     or r->>'shiftId' is distinct from shift or r->>'actorId' is distinct from actor::text
     or r->>'customerId' is distinct from original->>'customerId' or r->>'customerName' is distinct from original->>'customerName'
     or r->>'orderId' is distinct from original->>'orderId' or r->>'method' is distinct from original->>'method'
     or jsonb_typeof(r->'amount') is distinct from 'number' or (r->>'amount')::bigint is distinct from -(original->>'amount')::bigint
     or nullif(btrim(r->>'reason'),'') is null or r->>'id' is null
     or exists(select 1 from jsonb_array_elements(previous) x where x->>'reversalOf'=original->>'id')
     or b-array['revision','audit','creditLedger'] is distinct from a-array['revision','audit','creditLedger']
     or ledger is distinct from previous||jsonb_build_array(entry)
     or (r->>'balance')::bigint is distinct from (select sum((x->>'amount')::bigint) from jsonb_array_elements(ledger) x where x->>'customerId'=r->>'customerId')
     or (b->>'revision')::bigint is distinct from (a->>'revision')::bigint+1
     or jsonb_array_length(b->'audit') is distinct from jsonb_array_length(a->'audit')+1
     or (b->'audit')-jsonb_array_length(a->'audit') is distinct from a->'audit'
     or b#>>array['audit',jsonb_array_length(a->'audit')::text,'type'] is distinct from command
     or b#>>array['audit',jsonb_array_length(a->'audit')::text,'actorId'] is distinct from actor::text then raise exception 'Credit reversal must append one exact audited reversal of the original topup';end if;
  if original->>'method'='card' and (r#>'{terminalConfirmation,confirmed}' is distinct from 'true'::jsonb
     or r#>>'{terminalConfirmation,method}' is distinct from 'manual' or nullif(btrim(r#>>'{terminalConfirmation,reference}'),'') is null
     or length(r#>>'{terminalConfirmation,reference}')>120 or r#>>'{terminalConfirmation,actorId}' is distinct from actor::text
     or r#>>'{terminalConfirmation,at}' is distinct from r->>'at') then raise exception 'Terminal refund confirmation required for credit reversal';end if;
 end if;
end;$$;

-- A normalized union of issued portion ranges survives splitting, merging and
-- receipt restoration. Overlaps are rejected, so no portion can be paid twice.
create or replace function public.pos_issue_coverage(s jsonb) returns jsonb
language plpgsql set search_path='' as $$
declare coverage jsonb;overlap boolean;
begin
 with lines as (
  select l from jsonb_array_elements(s->'orders') o cross join lateral jsonb_array_elements(o->'lines') l
  union all
  select l from jsonb_array_elements(s->'receipts') r cross join lateral jsonb_array_elements(r->'lines') l
   where r->>'kind'='sale' and not exists(select 1 from jsonb_array_elements(s->'receipts') f where f->>'refundOf'=r->>'id' and f->>'restoredToOrderId' is not null)
 ), ranges as (
  select l#>>'{stockIssue,id}' id,range_agg(int4range((l#>>'{stockIssue,offset}')::int,(l#>>'{stockIssue,offset}')::int+(l->>'quantity')::int,'[)')) spans,sum((l->>'quantity')::int) quantity
  from lines where l->'stockIssue' is not null group by l#>>'{stockIssue,id}'
 ), checked as (
  select *, (select sum(upper(x)-lower(x)) from unnest(spans) x) units from ranges
 ) select coalesce(jsonb_agg(jsonb_build_object('id',id,'spans',spans::text) order by id),'[]'),coalesce(bool_or(units<>quantity),false) into coverage,overlap from checked;
 if overlap then raise exception 'Issued portions overlap: duplicate payment or debt';end if;
 return coverage;
end;$$;

create or replace function public.pos_issue_recipe(l jsonb,recipes jsonb) returns jsonb
language plpgsql set search_path='' as $$
declare recipe jsonb;components jsonb;
begin
 if l ? 'stockRecipe' then return l->'stockRecipe';end if;
 recipe:=coalesce(recipes->(l->>'productId'),'null');
 if l->>'servingMl'='20' and recipe<>'null' and recipe->>'mode'<>'no_stock' then
  if (l->>'baseServingMl')::int not in (20,40) or recipe->>'mode'<>'recipe'
     or exists(select 1 from jsonb_array_elements(recipe->'components') c where c->>'unit'<>'ml' or (c->>'quantity')::numeric<=0)
     or (select sum((c->>'quantity')::numeric) from jsonb_array_elements(recipe->'components') c) is distinct from (l->>'baseServingMl')::numeric then raise exception 'Invalid 2cl issue recipe';end if;
  select jsonb_agg(jsonb_set(c,'{quantity}',to_jsonb(round((c->>'quantity')::numeric*20/(l->>'baseServingMl')::numeric,6))) order by n) into components from jsonb_array_elements(recipe->'components') with ordinality as t(c,n);
  recipe:=jsonb_set(recipe,'{components}',components);
 end if;
 return recipe;
end;$$;

create or replace function public.pos_guard_close_issues(a jsonb,b jsonb,r jsonb,actor uuid) returns void
language plpgsql set search_path='' as $$
declare o jsonb;l jsonb;i jsonb;expected_orders jsonb:='[]';lines jsonb;issues jsonb:=coalesce(a->'stockIssues','[]');ids jsonb:='[]';changed int;recipe jsonb;sh jsonb;
 cash bigint;card bigint;credit bigint;tc bigint;td bigint;movements bigint;summary jsonb;debts jsonb;
begin
 select value into sh from jsonb_array_elements(a->'shifts') where value->>'id'=r->>'id' and value->'closedAt'='null'::jsonb;
 if sh is null or r->>'closedAt' is null or exists(select 1 from jsonb_array_elements(a->'orders') x where x->'paymentLock' is not null)
    or exists(select 1 from jsonb_array_elements(a->'orders') x where jsonb_array_length(x->'lines')>0 and not public.pos_customer_like(x->>'name')) then raise exception 'Close blocked by payment reservation or unpaid table';end if;
 for o in select value from jsonb_array_elements(a->'orders') loop
  lines:='[]';changed:=0;
  for l in select value from jsonb_array_elements(o->'lines') loop
   if l->'stockIssue' is null then
    select value into i from jsonb_array_elements(coalesce(b->'stockIssues','[]')) x where x->>'orderId'=o->>'id' and x#>>'{lines,0,id}'=l->>'id' and not exists(select 1 from jsonb_array_elements(issues) y where y->>'id'=x->>'id');
    recipe:=public.pos_issue_recipe(l,a->'recipes');
    if i is null or i->>'id' is null or i-'id' is distinct from jsonb_build_object('kind','issue','number','VÝDEJ · '||(o->>'name'),'at',r->>'closedAt','shiftId',sh->>'id','orderId',o->>'id','orderName',o->>'name','venueId',a->>'venueId','actorId',actor::text,'lines',jsonb_build_array(jsonb_set(l,'{stockRecipe}',recipe,true))) then raise exception 'Close must issue exactly the original unpaid portions';end if;
    issues:=issues||jsonb_build_array(i);ids:=ids||jsonb_build_array(i->>'id');changed:=changed+1;
    l:=jsonb_set(jsonb_set(l,'{stockRecipe}',recipe,true),'{stockIssue}',jsonb_build_object('id',i->>'id','offset',0),true);
   end if;
   lines:=lines||jsonb_build_array(l);
  end loop;
  expected_orders:=expected_orders||jsonb_build_array(jsonb_set(jsonb_set(o,'{lines}',lines),'{revision}',to_jsonb((o->>'revision')::bigint+changed)));
 end loop;
 select coalesce(sum((x->>'cash')::bigint),0),coalesce(sum((x->>'card')::bigint),0),coalesce(sum(coalesce((x->>'credit')::bigint,0)),0) into cash,card,credit from jsonb_array_elements(a->'receipts') x where x->>'shiftId'=sh->>'id';
 select coalesce(sum((x->>'amount')::bigint) filter(where x->>'method'='cash'),0),coalesce(sum((x->>'amount')::bigint) filter(where x->>'method'='card'),0) into tc,td from jsonb_array_elements(coalesce(a->'creditLedger','[]')) x where x->>'shiftId'=sh->>'id' and x->>'type' in ('topup','reversal');
 select coalesce(sum((x->>'amount')::bigint),0) into movements from jsonb_array_elements(sh->'movements') x;
 select coalesce(jsonb_agg(jsonb_build_object('orderId',x->>'id','name',x->>'name','amount',(select sum((ln->>'price')::bigint*(ln->>'quantity')::bigint) from jsonb_array_elements(x->'lines') ln),'itemCount',(select sum((ln->>'quantity')::int) from jsonb_array_elements(x->'lines') ln)) order by n),'[]') into debts from jsonb_array_elements(a->'orders') with ordinality as t(x,n) where jsonb_array_length(x->'lines')>0;
 summary:=jsonb_build_object('cash',cash,'card',card,'credit',credit,'total',cash+card+credit,'count',(select count(*) from jsonb_array_elements(a->'receipts') x where x->>'shiftId'=sh->>'id' and x->>'kind'='sale'),'refunds',(select count(*) from jsonb_array_elements(a->'receipts') x where x->>'shiftId'=sh->>'id' and x->>'kind'='refund'),'movements',movements,'opening',(sh->>'opening')::bigint,'creditTopupCash',tc,'creditTopupCard',td,'creditTopups',tc+td,'expected',(sh->>'opening')::bigint+cash+tc+movements,'terminal',card+td,'unpaidAccounts',debts,'unpaidTotal',(select coalesce(sum((x->>'amount')::bigint),0) from jsonb_array_elements(debts) x));
 if b->'orders' is distinct from expected_orders or coalesce(b->'stockIssues','[]') is distinct from issues or r->'stockIssueIds' is distinct from ids
    or r->'summary' is distinct from summary or (r->>'counted')::bigint<0 or (r->>'difference')::bigint is distinct from (r->>'counted')::bigint-(summary->>'expected')::bigint
    or r-array['summary','closedAt','counted','difference','stockIssueIds'] is distinct from sh-array['summary','closedAt','counted','difference','stockIssueIds']
    or b-array['revision','audit','orders','shifts','stockIssues'] is distinct from a-array['revision','audit','orders','shifts','stockIssues']
    or b->'shifts' is distinct from (select jsonb_agg(case when x->>'id'=sh->>'id' then r else x end order by n) from jsonb_array_elements(a->'shifts') with ordinality as t(x,n))
    or (b->>'revision')::bigint is distinct from (a->>'revision')::bigint+1
    or jsonb_array_length(b->'audit') is distinct from jsonb_array_length(a->'audit')+1 or (b->'audit')-jsonb_array_length(a->'audit') is distinct from a->'audit' then raise exception 'Close must preserve money and issue all unpaid stock exactly once';end if;
end;$$;

-- Exact physical stock belonging to a range of an already issued line. The
-- original issue contains one line, so actual shortages and substitutions can
-- be allocated deterministically without returning stock that was never posted.
create or replace function public.pos_issue_stock_slice(p_issue uuid,p_offset int,p_quantity int)
returns table(product_id uuid,quantity_ml numeric,quantity_units numeric)
language plpgsql set search_path='' as $$
declare r public.pos_receipts%rowtype;s public.pos_stock_lines%rowtype;c jsonb;part jsonb;starts jsonb:='{}';began numeric;pieces numeric;need numeric;actual numeric;
begin
 select * into strict r from public.pos_receipts where id=p_issue and kind='issue';
 select * into strict s from public.pos_stock_lines where receipt_id=p_issue;
 if s.status in ('missing_recipe','awaiting_stock') then raise exception 'Nejdřív ověř a doplň skladový odpis vydaných porcí.';end if;
 if s.status='no_stock' then return;end if;
 if jsonb_array_length(coalesce(s.recipe->'resolvedComponents','[]'))>0 then
  for part in select value from jsonb_array_elements(s.recipe->'resolvedComponents') loop
   began:=coalesce((starts->>(part->>'requestedProductId'))::numeric,0);
   pieces:=greatest(0,least(began+(part->>'portions')::numeric,p_offset+p_quantity)-greatest(began,p_offset));
   starts:=jsonb_set(starts,array[part->>'requestedProductId'],to_jsonb(began+(part->>'portions')::numeric));
   product_id:=(part->>'productId')::uuid;need:=pieces*(part->>'quantity')::numeric/(part->>'portions')::numeric;
   quantity_ml:=case when part->>'unit'='ml' then need else 0 end;quantity_units:=case when part->>'unit'='ks' then need else null end;
   if need>0 then return next;end if;
  end loop;
 else
  for c in select value from jsonb_array_elements(s.recipe->'components') loop
   product_id:=(c->>'productId')::uuid;need:=(c->>'quantity')::numeric;
   select coalesce(sum(case when c->>'unit'='ks' then -m.quantity_units else -m.quantity_ml end),0) into actual from public.stock_movements m where m.source_type='pos_receipt' and m.source_id=p_issue and m.product_id=(c->>'productId')::uuid and m.movement_type='sale';
   actual:=greatest(0,least(need*p_quantity,actual-need*p_offset));
   quantity_ml:=case when c->>'unit'='ml' then actual else 0 end;quantity_units:=case when c->>'unit'='ks' then actual else null end;
   if actual>0 then return next;end if;
  end loop;
 end if;
end;$$;

create or replace function public.pos_restock_issued(p_sale uuid,p_refund uuid,p_actor uuid) returns void
language plpgsql set search_path='' as $$
declare sale public.pos_receipts%rowtype;refund public.pos_receipts%rowtype;l jsonb;m record;
begin
 select * into strict sale from public.pos_receipts where id=p_sale and kind='sale';
 select * into strict refund from public.pos_receipts where id=p_refund and kind='refund' and venue_id=sale.venue_id;
 if refund.payload->>'restoredToOrderId' is not null then return;end if;
 for l in select value from jsonb_array_elements(sale.payload->'lines') where value->'stockIssue' is not null loop
  for m in select * from public.pos_issue_stock_slice((l#>>'{stockIssue,id}')::uuid,(l#>>'{stockIssue,offset}')::int,(l->>'quantity')::int) loop
   insert into public.stock_movements(organization_id,venue_id,product_id,movement_type,quantity_ml,quantity_units,source_type,source_id,reason,occurred_at,created_by)
   values(sale.organization_id,sale.venue_id,m.product_id,'manual_correction',m.quantity_ml,m.quantity_units,'pos_refund',refund.id,'Vrácené vydané zboží: '||(refund.payload->>'reason'),refund.occurred_at,p_actor);
  end loop;
 end loop;
end;$$;

do $migration$
declare
 definition text:=pg_get_functiondef('public.pos_commit(uuid,uuid,uuid,text,bigint,text,jsonb,jsonb)'::regprocedure);
 helper text;name text;start_at int;end_at int;
 anchor text:=' -- POS_CUSTOMER_CREDIT_GUARD_V1';
 guard text:=$guard$
 -- POS_CUSTOMER_CREDIT_INTEGRITY_V2
 perform public.pos_guard_credit_v2(old.state,p_state,p_type,p_result,p_actor);
 if p_type='closeShift' then
  perform public.pos_guard_close_issues(old.state,p_state,p_result,p_actor);
 elsif coalesce(p_state->'stockIssues','[]') is distinct from coalesce(old.state->'stockIssues','[]') then raise exception 'Only closing may append inventory issues';
 end if;
 if p_type<>'closeShift' and public.pos_issue_coverage(p_state) is distinct from public.pos_issue_coverage(old.state) then raise exception 'Issued portions must remain accounted for';end if;
 for l in select x from jsonb_array_elements(p_state->'orders') o cross join lateral jsonb_array_elements(o->'lines') x
   union all select x from jsonb_array_elements(p_state->'receipts') receipt cross join lateral jsonb_array_elements(receipt->'lines') x loop
  if l->'stockIssue' is not null and not exists(select 1 from jsonb_array_elements(coalesce(p_state->'stockIssues','[]')) i
    where i->>'id'=l#>>'{stockIssue,id}' and i->>'venueId'=p_venue::text
      and l-array['id','quantity','stockIssue'] is not distinct from (i#>'{lines,0}')-array['id','quantity']
      and jsonb_typeof(l#>'{stockIssue,offset}')='number' and (l#>>'{stockIssue,offset}')::int>=0
      and (l#>>'{stockIssue,offset}')::int+(l->>'quantity')::int<=(i#>>'{lines,0,quantity}')::int) then raise exception 'Invalid issued portion reference';end if;
 end loop;
 if p_type in ('refund','restoreReceipt') and p_result->'lines' is distinct from (select payload->'lines' from public.pos_receipts where id=(p_result->>'refundOf')::uuid and venue_id=p_venue) then raise exception 'Refund must preserve original issued portions';end if;
$guard$;
begin
 if strpos(definition,'-- POS_CUSTOMER_CREDIT_INTEGRITY_V2')>0 then return;end if;
 if strpos(definition,anchor)=0 or strpos(definition,'-- POS_END_CUSTOMER_VISIT_GUARD_V1')=0 then raise exception 'Apply credit V1 and visit guards before integrity migration';end if;
 start_at:=strpos(definition,' -- POS_RENAME_ORDER_GUARD_V1');end_at:=strpos(definition,anchor);
 if start_at=0 or end_at<=start_at then raise exception 'Review customer rename anchors';end if;
 definition:=substr(definition,1,start_at-1)||E' -- POS_RENAME_ORDER_GUARD_V1\n if p_type=''renameOrder'' then perform public.pos_guard_customer_rename(old.state,p_state,p_result,p_actor);end if;\n'||substr(definition,end_at);
 definition:=replace(definition,anchor,guard||E'\n'||anchor);
 definition:=replace(definition,'''restoreReceipt'',''cashMovement''','''restoreReceipt'',''creditReverse'',''cashMovement''');
 definition:=replace(definition,'''orderName'',p_result->>''orderName'',''at'',p_result->>''at'')','''orderName'',p_result->>''orderName'',''customerId'',p_result->''customerId'',''at'',p_result->>''at'')');
 definition:=replace(definition,'and o->>''name''=p_result->>''orderName'')','and o->>''name''=p_result->>''orderName'' and coalesce(o->''customerId'',''null''::jsonb) is not distinct from p_result->''customerId'')');
 definition:=replace(definition,'  shift_id:=p_result->>''id'';', $issue$
  for l in select value from jsonb_array_elements(coalesce(p_state->'stockIssues','[]')) x where not exists(select 1 from jsonb_array_elements(coalesce(old.state->'stockIssues','[]')) y where y->>'id'=x->>'id') loop
   insert into public.pos_receipts(id,venue_id,organization_id,actor_id,request_id,kind,occurred_at,payload)
   values((l->>'id')::uuid,p_venue,org,p_actor,(l->>'id')::uuid,'issue',(l->>'at')::timestamptz,l);
   perform public.pos_post_stock_line((l->>'id')::uuid,l#>'{lines,0}',l#>'{lines,0,stockRecipe}',p_actor);
  end loop;
  shift_id:=p_result->>'id';$issue$);
 definition:=replace(definition,'   update public.pos_stock_lines set status=case when status=''missing_recipe''',E'   perform public.pos_restock_issued(r.id,receipt_uuid,p_actor);\n   update public.pos_stock_lines set status=case when status=''missing_recipe''');
 definition:=replace(definition,'and venue_id=p_venue and kind=''sale'';'||E'\n  select value into strict l','and venue_id=p_venue and kind in (''sale'',''issue'');'||E'\n  select value into strict l');
 definition:=replace(definition,'''receiptId'',receipt_uuid)', '''receiptId'',receipt_uuid) || case when p_type in (''creditTopup'',''creditReverse'') then jsonb_build_object(''creditMovement'',p_result) when p_type=''closeShift'' then jsonb_build_object(''stockIssueIds'',p_result->''stockIssueIds'') else ''{}''::jsonb end');
 execute definition;
 -- Preserve the existing substitution implementation, shortages and grants.
 foreach name in array array['pos_post_stock_line','pos_post_stock_line_v1'] loop
  if to_regprocedure('public.'||name||'(uuid,jsonb,jsonb,uuid)') is null then continue;end if;
  helper:=pg_get_functiondef(('public.'||name||'(uuid,jsonb,jsonb,uuid)')::regprocedure);
  if strpos(helper,'where id=p_receipt and kind=''sale''')=0 then raise exception 'Review inventory posting anchor for %',name;end if;
  helper:=replace(helper,'where id=p_receipt and kind=''sale''','where id=p_receipt and kind in (''sale'',''issue'')');
  if name='pos_post_stock_line' then
   helper:=replace(helper,'begin'||E'\n', $issued$
begin
 if p_line->'stockIssue' is not null then
  insert into public.pos_stock_lines(receipt_id,line_id,venue_id,organization_id,pos_product_id,label,quantity,status,recipe,reason)
  select p_receipt,(p_line->>'id')::uuid,doc.venue_id,doc.organization_id,p_line->>'productId',p_line->>'name',(p_line->>'quantity')::numeric,'issued',p_recipe,'Spotřeba už je zapsaná na výdejce '||(p_line#>>'{stockIssue,id}')
  from public.pos_receipts doc where doc.id=p_receipt and doc.kind='sale';
  return;
 end if;
$issued$);
  end if;
  execute helper;
 end loop;
end;$migration$;

revoke all on function public.pos_customer_key(text),public.pos_customer_like(text),public.pos_guard_customer_rename(jsonb,jsonb,jsonb,uuid),public.pos_guard_credit_v2(jsonb,jsonb,text,jsonb,uuid),public.pos_issue_coverage(jsonb),public.pos_issue_recipe(jsonb,jsonb),public.pos_guard_close_issues(jsonb,jsonb,jsonb,uuid),public.pos_issue_stock_slice(uuid,int,int),public.pos_restock_issued(uuid,uuid,uuid) from public,anon,authenticated;
grant execute on function public.pos_customer_key(text),public.pos_customer_like(text),public.pos_guard_customer_rename(jsonb,jsonb,jsonb,uuid),public.pos_guard_credit_v2(jsonb,jsonb,text,jsonb,uuid),public.pos_issue_coverage(jsonb),public.pos_issue_recipe(jsonb,jsonb),public.pos_guard_close_issues(jsonb,jsonb,jsonb,uuid),public.pos_issue_stock_slice(uuid,int,int),public.pos_restock_issued(uuid,uuid,uuid) to service_role;
