-- Integration gate. Every fixture is rolled back; never creates real sales or stock.
begin;
do $$
declare
 actor uuid; org uuid; venue uuid:=gen_random_uuid(); product uuid:=gen_random_uuid();
 receipt uuid:=gen_random_uuid(); line_id uuid:=gen_random_uuid(); request uuid:=gen_random_uuid();
 s jsonb; r jsonb; l jsonb; recipe jsonb; result jsonb; total numeric; old_count integer;
 refund uuid:=gen_random_uuid(); failed boolean:=false;
begin
 select user_id,organization_id into strict actor,org from public.memberships where role='owner' limit 1;
 insert into public.venues(id,organization_id,name,created_by) values(venue,org,'POS TRANSACTION TEST',actor);
 insert into public.products(id,organization_id,name,unit_mode,volume_ml) values(product,org,'POS TEST LIQUID','liquid',1000);
 insert into public.stock_movements(organization_id,venue_id,product_id,movement_type,quantity_ml,reason,created_by)
 values(org,venue,product,'manual_correction',1000,'POS test fixture',actor);
 recipe:=jsonb_build_object('mode','recipe','version',1,'components',jsonb_build_array(jsonb_build_object('productId',product,'quantity',40,'unit','ml')));
 l:=jsonb_build_object('id',line_id,'productId','test','name','Test portion','quantity',2,'stockRecipe',recipe);
 r:=jsonb_build_object('id',receipt,'venueId',venue,'kind','sale','at',now(),'number','TEST-1','lines',jsonb_build_array(l));
 s:=jsonb_build_object('venueId',venue,'orders','[]'::jsonb,'revision',1);
 result:=public.pos_commit(venue,actor,request,'test-hash',0,'checkout',s,r);
 assert result->>'duplicate'='false','first request should commit';
 select sum(quantity_ml) into total from public.stock_movements where venue_id=venue and product_id=product;
 assert total=920,'two 40 ml portions must subtract 80 ml';
 assert exists(select 1 from public.pos_stock_lines where receipt_id=receipt and status='posted'),'stock line posted';
 result:=public.pos_commit(venue,actor,request,'test-hash',0,'checkout',s,r);
 assert result->>'duplicate'='true','retry must be deduplicated even with stale revision';
 select count(*) into old_count from public.stock_movements where venue_id=venue;
 assert old_count=2,'retry must not duplicate ledger movement';
 result:=public.pos_commit(venue,actor,gen_random_uuid(),'different-hash',0,'checkout',s,r);
 assert result->>'conflict'='true','stale writer must conflict';
 begin
  perform public.pos_commit(venue,actor,request,'tampered-hash',1,'checkout',s,r);
 exception when others then failed:=true; end;
 assert failed,'request ID cannot change meaning';
 -- One missing recipe is queued with no fabricated stock decrement.
 receipt:=gen_random_uuid();line_id:=gen_random_uuid();
 l:=jsonb_build_object('id',line_id,'productId','unmapped','name','Missing recipe','quantity',1,'stockRecipe',null);
 r:=jsonb_build_object('id',receipt,'venueId',venue,'kind','sale','at',now(),'number','TEST-2','lines',jsonb_build_array(l));
 s:=jsonb_set(s,'{revision}','2');
 perform public.pos_commit(venue,actor,gen_random_uuid(),'missing',1,'checkout',s,r);
 assert exists(select 1 from public.pos_stock_lines where receipt_id=receipt and status='missing_recipe'),'missing mapping must remain visible';
 assert (select count(*) from public.stock_movements where venue_id=venue)=old_count,'missing recipe cannot invent a decrement';
 -- Resolve later, once only.
 s:=jsonb_set(s,'{revision}','3');
 perform public.pos_commit(venue,actor,gen_random_uuid(),'resolve',2,'resolveStock',s,jsonb_build_object('receiptId',receipt,'lineId',line_id,'recipe',recipe));
 assert (select sum(quantity_ml) from public.stock_movements where venue_id=venue)=880,'late mapping must subtract once';
 failed:=false;
 begin
  perform public.pos_commit(venue,actor,gen_random_uuid(),'resolve-duplicate',3,'resolveStock',jsonb_set(s,'{revision}','4'),jsonb_build_object('receiptId',receipt,'lineId',line_id,'recipe',recipe));
 exception when others then failed:=true; end;
 assert failed,'duplicate stock resolution must fail';
 assert (select revision from public.pos_registers where venue_id=venue)=3,'failed stock operation rolls back register';
 -- Explicit restock returns the exact original decrement.
 r:=jsonb_build_object('id',refund,'venueId',venue,'kind','refund','at',now(),'number','TEST-3','refundOf',receipt,'reason','Returned unopened','restock',true,'lines','[]'::jsonb);
 s:=jsonb_set(s,'{revision}','4');
 perform public.pos_commit(venue,actor,gen_random_uuid(),'refund',3,'refund',s,r);
 assert (select sum(quantity_ml) from public.stock_movements where venue_id=venue)=920,'restock restores original quantity';
 -- Closing integrates into the existing GURU review queue, in CZK.
 r:=jsonb_build_object('id',gen_random_uuid(),'openedAt',now(),'closedAt',now(),'counted',11900,'difference',0,'summary',jsonb_build_object('cash',6900,'card',6500,'total',13400,'count',2));
 s:=jsonb_set(s,'{revision}','5')||jsonb_build_object('receipts','[]'::jsonb);
 perform public.pos_commit(venue,actor,gen_random_uuid(),'closing',4,'closeShift',s,r);
 assert exists(select 1 from public.closings where venue_id=venue and total_amount=134 and cash_amount=69 and card_amount=65 and status='review'),'GURU closing must use crowns and review status';
 -- Counted stock is capped by the existing ledger trigger. A refund returns only
 -- the three deducted units, not the two units that were never in stock.
 product:=gen_random_uuid();receipt:=gen_random_uuid();line_id:=gen_random_uuid();
 insert into public.products(id,organization_id,name,unit_mode,item_kind,item_subtype,count_unit) values(product,org,'POS TEST COUNTED','counted','consumable','test_fixture','ks');
 insert into public.stock_movements(organization_id,venue_id,product_id,movement_type,quantity_ml,quantity_units,reason,created_by)
 values(org,venue,product,'manual_correction',0,3,'POS counted fixture',actor);
 recipe:=jsonb_build_object('mode','recipe','components',jsonb_build_array(jsonb_build_object('productId',product,'quantity',1,'unit','ks')));
 l:=jsonb_build_object('id',line_id,'productId','test-counted','name','Counted portion','quantity',5,'stockRecipe',recipe);
 r:=jsonb_build_object('id',receipt,'venueId',venue,'kind','sale','at',now(),'number','TEST-COUNTED','lines',jsonb_build_array(l));
 s:=jsonb_set(s,'{revision}','6');
 perform public.pos_commit(venue,actor,gen_random_uuid(),'counted',5,'checkout',s,r);
 assert exists(select 1 from public.stock_movements where venue_id=venue and product_id=product and quantity_units=-3 and untracked_units=2),'counted shortage must retain requested versus deducted quantity';
 assert exists(select 1 from public.pos_stock_lines where receipt_id=receipt and status='shortage'),'shortage must be visible';
 r:=jsonb_build_object('id',gen_random_uuid(),'venueId',venue,'kind','refund','at',now(),'number','TEST-COUNTED-REFUND','refundOf',receipt,'reason','Returned stock','restock',true);
 s:=jsonb_set(s,'{revision}','7');
 perform public.pos_commit(venue,actor,gen_random_uuid(),'counted-refund',6,'refund',s,r);
 assert (select sum(quantity_units) from public.stock_movements where venue_id=venue and product_id=product)=3,'refund cannot manufacture missing counted stock';
 perform set_config('request.jwt.claims',jsonb_build_object('sub',actor,'role','authenticated')::text,true);
 execute 'set local role authenticated';
 result:=public.pos_inventory_snapshot(venue);
 assert jsonb_array_length(result->'movements')=(select count(*) from public.stock_movements where venue_id=venue),'inventory snapshot includes the complete POS ledger';
 execute 'reset role';
 -- SQL privileges are the second boundary behind verified Edge authentication.
 assert not has_function_privilege('authenticated','public.pos_commit(uuid,uuid,uuid,text,bigint,text,jsonb,jsonb)','EXECUTE'),'clients cannot call trusted commit';
 assert not has_function_privilege('anon','public.pos_post_stock_line(uuid,jsonb,jsonb,uuid)','EXECUTE'),'anonymous cannot post stock';
 assert not has_table_privilege('authenticated','public.pos_registers','UPDATE'),'no direct client register writes';
 perform set_config('request.jwt.claims',jsonb_build_object('sub',gen_random_uuid(),'role','authenticated')::text,true);
 execute 'set local role authenticated';
 assert (select count(*) from public.pos_registers where venue_id=venue)=0,'unrelated user must not read register';
 assert (select count(*) from public.pos_receipts where venue_id=venue)=0,'unrelated user must not read receipts';
 assert public.pos_inventory_snapshot(venue) is null,'unrelated user must not read stock snapshot';
 execute 'reset role';
end;
$$;
select 'PASS: atomic sale, deduplication, conflict, missing recipe, late posting, restock, closing and tenant isolation' as result;
rollback;
