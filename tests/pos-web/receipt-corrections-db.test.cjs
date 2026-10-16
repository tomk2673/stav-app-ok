'use strict';
const test=require('node:test'), assert=require('node:assert/strict'), fs=require('node:fs'), path=require('node:path');
const {PGlite}=require('@electric-sql/pglite');
const C=require('../../pub_bizz_pos/core.js'), D=require('../../pub_bizz_pos/server-domain.js');
const root=path.resolve(__dirname,'../..');
const read=file=>fs.readFileSync(path.join(root,file),'utf8');
const migration='supabase/migrations/20261013222653_pos_receipt_terminal_guard.sql';
async function fixture(mode='cash',mapped=true,substitutions=false,deployedCommit=false){
 const db=new PGlite(), org=crypto.randomUUID(), venue=crypto.randomUUID(), owner={id:crypto.randomUUID(),role:'owner'},staff={id:crypto.randomUUID(),role:'staff'};
 const liquid=crypto.randomUUID(),counted=crypto.randomUUID();
 await db.exec(`create role anon;create role authenticated;create role service_role bypassrls;
  create schema auth;create table auth.users(id uuid primary key);
  create function auth.uid() returns uuid language sql as $$select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid;$$;`);
 const schema=read('database/schema.sql');await db.exec(schema.slice(0,schema.indexOf('-- RLS:')).replace('create extension if not exists pgcrypto;',''));
 await db.exec(`create function public.has_org_role(p_org uuid,p_roles text[]) returns boolean language sql as $$select exists(select 1 from memberships where organization_id=p_org and user_id=auth.uid() and role=any(p_roles));$$;
  insert into auth.users values('${owner.id}'),('${staff.id}');
  insert into organizations(id,name,created_by) values('${org}','TEST ONLY','${owner.id}');
  insert into venues(id,organization_id,name,created_by) values('${venue}','${org}','TEST ONLY','${owner.id}');
  insert into memberships(organization_id,user_id,role) values('${org}','${owner.id}','owner'),('${org}','${staff.id}','staff');`);
 await db.exec(read('database/002_product_client_key.sql'));
 await db.exec(read('database/005_product_runtime_fields.sql'));
 await db.exec(read('database/20260901_invoice_line_vat_fields.sql'));
 await db.exec(read('database/007_immutable_stock_ledger.sql'));
 await db.exec(read('database/20260904025648_counted_inventory_backend.sql'));
 for(const file of ['20260925174410_pub_bizz_shared_register.sql','20260925174607_pub_bizz_payment_reservations.sql','20260927030252_pub_bizz_merge_orders.sql','20261001080000_pos_fast_split_restore_receipt.sql','20261003211245_fix_pos_merge_command_recovery.sql'])await db.exec(read('supabase/migrations/'+file));
 if(process.env.POS_COMMIT_FIXTURE)await db.exec(fs.readFileSync(process.env.POS_COMMIT_FIXTURE,'utf8'));else if(deployedCommit)await db.exec(read('tests/fixtures/live-pos-commit.sql'));
 if(process.env.POS_STOCK_SUPPORT)await db.exec(fs.readFileSync(process.env.POS_STOCK_SUPPORT,'utf8'));
 if(substitutions)await db.exec(read('tests/fixtures/pub-bizz-stock-available.sql'));
 if(process.env.POS_STOCK_FIXTURE)await db.exec(fs.readFileSync(process.env.POS_STOCK_FIXTURE,'utf8'));
 await db.exec(read(migration));
 await db.exec(read('supabase/migrations/20261014231114_pos_rename_order.sql'));
 await db.exec(read('supabase/migrations/20261015205034_pos_end_customer_visit.sql'));
 await db.exec(read('supabase/migrations/20261015002500_pos_customer_credit.sql'));
 await db.exec(read('supabase/migrations/20261016040732_pos_customer_credit_integrity.sql'));
 let s=C.initial();s.venueId=venue;
 await db.query('insert into pos_registers(venue_id,organization_id,state) values($1,$2,$3)',[venue,org,JSON.stringify(s)]);
 await db.exec(`insert into products(id,organization_id,name,unit_mode,volume_ml) values('${liquid}','${org}','TEST liquid','liquid',1000);
  insert into products(id,organization_id,name,unit_mode,item_kind,item_subtype) values('${counted}','${org}','TEST counted','counted','consumable','test');
  insert into stock_movements(organization_id,venue_id,product_id,movement_type,quantity_ml,quantity_units,reason,created_by)
  values('${org}','${venue}','${liquid}','manual_correction',1000,null,'Test fixture','${owner.id}'),('${org}','${venue}','${counted}','manual_correction',0,3,'Test fixture','${owner.id}');
  grant usage on schema auth to service_role;grant select on auth.users to service_role;
  grant all on all tables in schema public to service_role;
  grant execute on function public.normalize_stock_movement_quantity() to service_role;
  grant execute on function public.validate_stock_movement_source() to service_role;
  set role service_role;`);
 const stock=[{id:liquid,unit_mode:'liquid'},{id:counted,unit_mode:'counted'}];
 const commit=async(type,state,result,actor=owner,request=crypto.randomUUID(),hash=type,expected=s.revision)=>{
  const r=await db.query('select pos_commit($1,$2,$3,$4,$5,$6,$7,$8) as result',[venue,actor.id,request,hash,expected,type,JSON.stringify(state),result==null?null:JSON.stringify(result)]);return r.rows[0].result;
 };
 const run=async(type,p,actor=owner)=>{
  if(type==='creditTopup'&&p.method==='card'&&p.cardConfirmed===true&&!s.orders.find(o=>o.id===p.orderId)?.paymentLock){const o=s.orders.find(o=>o.id===p.orderId),lock=(await run('beginPayment',{orderId:o.id,revision:o.revision,purpose:'creditTopup',amount:p.amount},actor)).result;p={...p,paymentToken:lock.token};}
  const records=type==='restoreReceipt'?(await db.query('select line_id,status,recipe from pos_stock_lines where receipt_id=$1',[p.receiptId])).rows:[];const command=D.run(s,type,p,actor,stock,new Date().toISOString(),records);const r=await commit(type,command.state,command.result,actor);s=command.state;return {result:command.result,requestResult:r};
 };
 await run('openShift',{opening:0});const target=(await run('newOrder',{name:'Stůl 2'},staff)).result;
 if(mapped)await run('recipe',{productId:'agnis-2810',version:0,mode:'recipe',components:[{productId:liquid,unit:'ml',quantity:40},{productId:counted,unit:'ks',quantity:1}]});
 await run('addLine',{orderId:'bar',productId:'agnis-2810',quantity:5},staff);
 const lock=(await run('beginPayment',{orderId:'bar',revision:s.orders[0].revision},staff)).result;
 const sale=(await run('checkout',{orderId:'bar',revision:s.orders[0].revision,paymentToken:lock.token,operationId:crypto.randomUUID(),selected:s.orders[0].lines.map(l=>({id:l.id,quantity:l.quantity})),mode,received:30000,splitCash:1000,cardConfirmed:true},staff)).result;
 const snapshot=async()=>({register:(await db.query('select state,revision from pos_registers')).rows,receipts:(await db.query('select id,payload from pos_receipts order by occurred_at,id')).rows,stock:(await db.query('select product_id,quantity_ml,quantity_units,untracked_units,source_type,source_id from stock_movements order by id')).rows,requests:(await db.query('select request_id from pos_requests order by request_id')).rows,audit:(await db.query('select event_type,after_data from audit_events order by id')).rows});
 return {db,org,venue,owner,staff,sale,target,liquid,counted,stock,run,commit,snapshot,get s(){return s;}};
}
test('SQL 2cl partial payment deducts exactly 20ml per piece and restoration/re-sale never halves stock twice',async()=>{
 const f=await fixture('cash',false,true);try{
  await f.run('recipe',{productId:'agnis-2810',version:0,mode:'recipe',components:[{productId:f.liquid,unit:'ml',quantity:40}]});
  const id=f.target.id;
  await f.run('addLine',{orderId:id,productId:'agnis-2810',quantity:3,servingMl:20},f.staff);
  await f.run('addLine',{orderId:id,productId:'agnis-2810',quantity:2},f.staff);
  const order=()=>f.s.orders.find(o=>o.id===id),small=order().lines.find(l=>l.servingMl===20);
  const lock=(await f.run('beginPayment',{orderId:id,revision:order().revision},f.staff)).result;
  const sale=(await f.run('checkout',{orderId:id,revision:order().revision,paymentToken:lock.token,operationId:crypto.randomUUID(),selected:[{id:small.id,quantity:2}],mode:'card',received:0,cardConfirmed:true},f.staff)).result;
  assert.equal(sale.total,5500);assert.equal(sale.lines[0].quantity,2);assert.equal(sale.lines[0].stockRecipe.components[0].quantity,20);
  const deducted=(await f.db.query("select sum(quantity_ml)::text as ml from stock_movements where source_id=$1 and movement_type='sale'",[sale.id])).rows[0];assert.equal(deducted.ml,'-40');
  assert.equal(order().lines.find(l=>l.id===small.id).quantity,1);assert.equal(order().lines.find(l=>!l.servingMl).quantity,2);
  await f.run('restoreReceipt',{receiptId:sale.id,reason:'TEST 2cl',cardConfirmed:true,terminalReference:'TEST-2CL-REFUND'});
  const restored=order().lines.find(l=>l.stockRecipe);assert.equal(restored.quantity,2);assert.equal(restored.stockRecipe.components[0].quantity,20);assert.equal(restored.servingMl,20);
  const product=f.s.products.find(p=>p.id==='agnis-2810');
  await f.run('product',{...product,price:8000,serving:'0,02 l'});
  await f.run('recipe',{productId:product.id,version:1,mode:'recipe',components:[{productId:f.liquid,unit:'ml',quantity:20}]});
  const again=(await f.run('beginPayment',{orderId:id,revision:order().revision},f.staff)).result;
  const resold=(await f.run('checkout',{orderId:id,revision:order().revision,paymentToken:again.token,operationId:crypto.randomUUID(),selected:[{id:restored.id,quantity:2}],mode:'card',received:0,cardConfirmed:true},f.staff)).result;
  assert.equal(resold.total,5500);assert.equal(resold.lines[0].stockRecipe.components[0].quantity,20);
  assert.equal((await f.db.query("select sum(quantity_ml)::text as ml from stock_movements where source_id=$1 and movement_type='sale'",[resold.id])).rows[0].ml,'-40');
  assert.deepEqual((await f.db.query('select payload from pos_receipts where id=$1',[sale.id])).rows[0].payload,sale);
 }finally{await f.db.close();}
});
test('SQL 2cl missing-recipe sale later resolves exactly its own portion once',async()=>{
 const f=await fixture('cash',false);try{
  const id=f.target.id;await f.run('addLine',{orderId:id,productId:'agnis-2810',quantity:3,servingMl:20},f.staff);
  const o=f.s.orders.find(o=>o.id===id),lock=(await f.run('beginPayment',{orderId:id,revision:o.revision},f.staff)).result;
  const sale=(await f.run('checkout',{orderId:id,revision:o.revision,paymentToken:lock.token,operationId:crypto.randomUUID(),selected:o.lines.map(l=>({id:l.id,quantity:l.quantity})),mode:'card',received:0,cardConfirmed:true},f.staff)).result;
  assert.equal((await f.db.query('select status from pos_stock_lines where receipt_id=$1',[sale.id])).rows[0].status,'missing_recipe');
  await f.run('recipe',{productId:'agnis-2810',version:0,mode:'recipe',components:[{productId:f.liquid,unit:'ml',quantity:40}]});
  await f.run('resolveStock',{receiptId:sale.id,lineId:sale.lines[0].id});
  const before=await f.snapshot();assert.equal((await f.db.query("select sum(quantity_ml)::text as ml from stock_movements where source_id=$1 and movement_type='sale'",[sale.id])).rows[0].ml,'-60');
  await assert.rejects(f.run('resolveStock',{receiptId:sale.id,lineId:sale.lines[0].id}),/already processed/);assert.deepEqual(await f.snapshot(),before);
 }finally{await f.db.close();}
});
test('SQL customer credit appends exact wallet movements only',async()=>{
 const f=await fixture('cash',false,true);try{
  await f.run('renameOrder',{orderId:f.target.id,revision:f.s.orders.find(o=>o.id===f.target.id).revision,name:'Petr'},f.staff);
  const topupCommand=D.run(f.s,'creditTopup',{orderId:f.target.id,amount:50000,method:'cash'},f.staff,[]);
  const before=await f.snapshot();
  for(const mutate of [
   s=>s.creditLedger.at(-1).amount=90000,
   s=>s.creditLedger.push({...s.creditLedger.at(-1),id:crypto.randomUUID()}),
   s=>s.orders.find(o=>o.id===f.target.id).name='Injected',
   s=>s.customers.push({id:crypto.randomUUID(),name:'Injected',aliases:['Injected'],createdAt:new Date().toISOString()})
  ]){
   const state=structuredClone(topupCommand.state);mutate(state);
   await assert.rejects(f.commit('creditTopup',state,topupCommand.result,f.staff),/Credit topup/);assert.deepEqual(await f.snapshot(),before);
  }
  await f.run('creditTopup',{orderId:f.target.id,amount:50000,method:'cash'},f.staff);
  let order=f.s.orders.find(o=>o.id===f.target.id),customerId=order.customerId;
  assert.equal(C.creditBalance(f.s,customerId),50000);
  await f.run('addLine',{orderId:order.id,productId:'agnis-2810',quantity:1,servingMl:20},f.staff);
  order=f.s.orders.find(o=>o.id===f.target.id);
  const lock=(await f.run('beginPayment',{orderId:order.id,revision:order.revision},f.staff)).result;
  order=f.s.orders.find(o=>o.id===f.target.id);
  const sale=(await f.run('checkout',{orderId:order.id,revision:order.revision,paymentToken:lock.token,operationId:crypto.randomUUID(),selected:order.lines.map(l=>({id:l.id,quantity:l.quantity})),mode:'credit',received:0,splitCash:0},f.staff)).result;
  assert.ok(sale.credit>0);assert.equal(sale.cash,0);assert.equal(sale.card,0);assert.equal(sale.lines[0].servingMl,20);
  assert.equal(C.creditBalance(f.s,customerId),50000-sale.credit);
  const refund=(await f.run('refund',{receiptId:sale.id,reason:'TEST credit refund'},f.owner)).result;
  assert.equal(refund.credit,-sale.credit);assert.equal(C.creditBalance(f.s,customerId),50000);
  const ledger=(await f.db.query("select state->'creditLedger' ledger from pos_registers")).rows[0].ledger;
  assert.deepEqual(ledger.map(x=>x.type),['topup','spend','refund']);
  assert.equal(ledger.some(x=>Object.hasOwn(x,'balance')),false,'derived balance must never be stored');
 }finally{await f.db.close();}
});
test('SQL rename preserves a partial sale, rejects altered state, deduplicates requests and keeps RPC private',async()=>{
 const f=await fixture('cash',true);try{
  await f.run('addLine',{orderId:f.target.id,productId:'agnis-2810',quantity:2},f.staff);
  const order=f.s.orders.find(o=>o.id===f.target.id),before=await f.snapshot();
  const command=D.run(f.s,'renameOrder',{orderId:order.id,revision:order.revision,name:'Petr'},f.staff,[]);
  for(const alter of [s=>s.orders.find(o=>o.id===order.id).lines[0].quantity++,s=>s.orders[0].name='Changed',s=>s.receipts[0].total++,s=>s.sequence++,s=>s.receiptAssignments.changed={},s=>(s.creditLedger||=[]).push({id:crypto.randomUUID(),customerId:'x',amount:100,type:'topup',method:'cash',at:new Date().toISOString()}),s=>s.orders.find(o=>o.id===order.id).visitStartedAt='2020-01-01T00:00:00Z',s=>s.audit[0].type='Changed']){
   const state=structuredClone(command.state);alter(state);
   await assert.rejects(f.commit('renameOrder',state,command.result,f.staff),/Rename must preserve/);assert.deepEqual(await f.snapshot(),before);
  }
  const request=crypto.randomUUID(),expected=f.s.revision;
  assert.equal((await f.commit('renameOrder',command.state,command.result,f.staff,request,'rename-test',expected)).duplicate,false);
  assert.equal((await f.commit('renameOrder',command.state,command.result,f.staff,request,'rename-test',expected)).duplicate,true);
  assert.equal((await f.commit('renameOrder',command.state,command.result,f.staff,crypto.randomUUID(),'stale',expected)).conflict,true);
  await assert.rejects(f.commit('renameOrder',command.state,command.result,f.staff,request,'changed',expected),/reused/);
  const after=await f.snapshot();assert.deepEqual(after.receipts,before.receipts);assert.deepEqual(after.stock,before.stock);
  assert.deepEqual(after.register[0].state.orders.find(o=>o.id===order.id),{...order,name:'Petr',revision:order.revision+1});
  assert.deepEqual(after.audit.filter(x=>x.event_type==='pos.renameOrder').map(x=>x.after_data.rename),[command.result]);
  await f.db.exec('reset role');await f.db.exec(read('supabase/migrations/20261014231114_pos_rename_order.sql'));
  const grants=(await f.db.query("select has_function_privilege('authenticated','public.pos_commit(uuid,uuid,uuid,text,bigint,text,jsonb,jsonb)','execute') client,has_function_privilege('service_role','public.pos_commit(uuid,uuid,uuid,text,bigint,text,jsonb,jsonb)','execute') service")).rows[0];
  assert.deepEqual(grants,{client:false,service:true});
 }finally{await f.db.close();}
});
for(const mode of ['cash','card','split']){
 test('SQL '+mode+': manager guard, original-card terminal verification, idempotency and exact liquid/counted restock',async()=>{
  const f=await fixture(mode);try{
   const p={receiptId:f.sale.id,reason:'TEST refund',cardConfirmed:true,terminalReference:'TEST-TERM-123'};
   const command=D.run(f.s,'restoreReceipt',p,f.owner,[]), before=await f.snapshot();
   await assert.rejects(f.commit('restoreReceipt',command.state,command.result,f.staff),/Manager required/);assert.deepEqual(await f.snapshot(),before);
   if(f.sale.card){
    for(const type of ['restoreReceipt','refund'])for(const mutate of [r=>delete r.terminalConfirmation,r=>r.terminalConfirmation.confirmed='true',r=>r.terminalConfirmation.reference='',r=>r.terminalConfirmation.actorId=f.staff.id,r=>r.card=0]){
     const result=structuredClone(command.result);mutate(result);
     await assert.rejects(f.commit(type,command.state,result),/Terminal refund|Invalid receipt/);assert.deepEqual(await f.snapshot(),before);
    }
   }
   const request=crypto.randomUUID(),expected=f.s.revision;
   const result=await f.commit('restoreReceipt',command.state,command.result,f.owner,request,'test-hash',expected);assert.equal(result.duplicate,false);
   assert.equal((await f.commit('restoreReceipt',command.state,command.result,f.owner,request,'test-hash',expected)).duplicate,true);
   await assert.rejects(f.commit('restoreReceipt',command.state,command.result,f.owner,request,'changed',expected),/reused/);
   await assert.rejects(f.commit('restoreReceipt',{...command.state,revision:command.state.revision+1},{...command.result,id:crypto.randomUUID()},f.owner,crypto.randomUUID(),'new',command.state.revision),/already reversed/);
   const counts=(await f.db.query(`select (select count(*)::int from pos_receipts) receipts,(select count(*)::int from stock_movements) movements,(select sum(quantity_ml) from stock_movements where product_id=$1) ml,(select sum(quantity_units) from stock_movements where product_id=$2) units`,[f.liquid,f.counted])).rows[0];
   assert.deepEqual(counts,{receipts:2,movements:2+(before.stock.length-2)*2,ml:'1000',units:'3'});
   const original=(await f.db.query('select payload from pos_receipts where id=$1',[f.sale.id])).rows[0].payload;assert.deepEqual(original,f.sale);
   const audit=(await f.db.query("select after_data from audit_events where event_type='pos.restoreReceipt'")).rows[0].after_data;assert.deepEqual(audit.correction,JSON.parse(JSON.stringify(command.result)));
   assert.equal((await f.db.query('select status from pos_stock_lines where receipt_id=$1',[f.sale.id])).rows[0].status,'restocked');
  }finally{await f.db.close();}
 });
 test('SQL '+mode+': staff assignment is financially neutral and cannot smuggle order/receipt/stock changes',async()=>{
  const f=await fixture(mode);try{
   const command=D.run(f.s,'reassignReceipt',{receiptId:f.sale.id,targetOrderId:f.target.id,previousOrderId:'bar',reason:'TEST correction'},f.staff,[]),before=await f.snapshot();
   for(const mutate of [s=>s.receipts=[],s=>s.orders[0].lines=s.receipts[0].lines,s=>s.sequence++,s=>s.shifts[0].opening++,s=>s.receiptAssignments[crypto.randomUUID()]={orderId:'bar'}]){
    const state=structuredClone(command.state);mutate(state);await assert.rejects(f.commit('reassignReceipt',state,command.result,f.staff),/must preserve/);assert.deepEqual(await f.snapshot(),before);
   }
   const request=crypto.randomUUID();await f.commit('reassignReceipt',command.state,command.result,f.staff,request,'same');
   assert.equal((await f.commit('reassignReceipt',command.state,command.result,f.staff,request,'same')).duplicate,true);
   const after=await f.snapshot();assert.deepEqual(after.receipts,before.receipts);assert.deepEqual(after.stock,before.stock);
   assert.deepEqual(after.register[0].state.orders,before.register[0].state.orders);assert.equal(after.register[0].state.sequence,before.register[0].state.sequence);
   assert.equal(after.audit.length,before.audit.length+1);assert.deepEqual(after.audit.find(x=>x.event_type==='pos.reassignReceipt').after_data.correction,command.result);
  }finally{await f.db.close();}
 });
}
test('SQL failure after creating refund/stock rolls back receipt, ledger, request and register together',async()=>{
 const f=await fixture('card');try{
  const command=D.run(f.s,'restoreReceipt',{receiptId:f.sale.id,reason:'TEST',cardConfirmed:true,terminalReference:'TEST-TERM'},f.owner,[]),before=await f.snapshot();
  await f.db.exec(`reset role;create function public.test_fail_correction_audit() returns trigger language plpgsql as $$begin if new.event_type='pos.restoreReceipt' then raise exception 'TEST audit unavailable';end if;return new;end;$$;create trigger test_fail before insert on audit_events for each row execute function public.test_fail_correction_audit();set role service_role;`);
  await assert.rejects(f.commit('restoreReceipt',command.state,command.result),/TEST audit unavailable/);assert.deepEqual(await f.snapshot(),before);
 }finally{await f.db.close();}
});
test('SQL missing recipe restores no invented stock; migration preserves merge commands, duplicate recovery and RPC grants',async()=>{
 const f=await fixture('cash',false);try{
  const before=await f.snapshot();await f.run('restoreReceipt',{receiptId:f.sale.id,reason:'TEST'});const after=await f.snapshot();assert.deepEqual(after.stock,before.stock);
  assert.equal((await f.db.query('select status from pos_stock_lines where receipt_id=$1',[f.sale.id])).rows[0].status,'cancelled');
  const o=f.s.orders[0];await f.run('mergeOrders',{orderId:'bar',revision:o.revision,targetOrderId:f.target.id,targetRevision:f.s.orders.find(x=>x.id===f.target.id).revision},f.staff);
  assert.ok((await f.db.query("select after_data->'merge' as m from audit_events where event_type='pos.mergeOrders'")).rows[0].m);
  await f.db.exec('reset role');await f.db.exec(read(migration));
  const permissions=(await f.db.query("select has_function_privilege('authenticated','public.pos_commit(uuid,uuid,uuid,text,bigint,text,jsonb,jsonb)','execute') client,has_function_privilege('anon','public.pos_commit(uuid,uuid,uuid,text,bigint,text,jsonb,jsonb)','execute') anon,has_function_privilege('service_role','public.pos_commit(uuid,uuid,uuid,text,bigint,text,jsonb,jsonb)','execute') service,has_table_privilege('authenticated','pos_registers','update') writes")).rows[0];
  assert.deepEqual(permissions,{client:false,anon:false,service:true,writes:false});
 }finally{await f.db.close();}
});
test('deployed substitution SQL: restoration, merge and partial re-sale preserve the actual deducted ingredients after recipe changes',async()=>{
 const f=await fixture('cash',false,true), alternative=crypto.randomUUID();try{
  await f.db.query("insert into products(id,organization_id,name,unit_mode,volume_ml) values($1,$2,'TEST alternative','liquid',1000)",[alternative,f.org]);
  await f.db.query("insert into stock_movements(organization_id,venue_id,product_id,movement_type,quantity_ml,reason,created_by) values($1,$2,$3,'manual_correction',-920,'TEST stock balance',$4),($1,$2,$5,'manual_correction',1000,'TEST alternative balance',$4)",[f.org,f.venue,f.liquid,f.owner.id,alternative]);
  f.stock.push({id:alternative,unit_mode:'liquid'});
  await f.run('recipe',{productId:'agnis-2810',version:0,mode:'recipe',components:[{productId:f.liquid,quantity:40,unit:'ml',alternatives:[alternative]}]});
  await f.run('addLine',{orderId:'bar',productId:'agnis-2810',quantity:5},f.staff);
  const lock=(await f.run('beginPayment',{orderId:'bar',revision:f.s.orders[0].revision},f.staff)).result;
  const sale=(await f.run('checkout',{orderId:'bar',revision:f.s.orders[0].revision,paymentToken:lock.token,operationId:crypto.randomUUID(),selected:f.s.orders[0].lines.map(l=>({id:l.id,quantity:l.quantity})),mode:'cash',received:30000,splitCash:0},f.staff)).result;
  const balances=async()=>(await f.db.query('select product_id,sum(quantity_ml)::text as ml from stock_movements group by product_id order by product_id')).rows;
  const sold=await balances();assert.equal(sold.find(x=>x.product_id===f.liquid).ml,'0');assert.equal(sold.find(x=>x.product_id===alternative).ml,'880');
  await f.run('recipe',{productId:'agnis-2810',version:1,mode:'recipe',components:[{productId:f.liquid,quantity:20,unit:'ml',alternatives:[alternative]}]});
  await f.run('restoreReceipt',{receiptId:sale.id,reason:'TEST same served portions'});
  assert.deepEqual(f.s.orders[0].lines.map(l=>l.quantity),[2,3]);
  const source=f.s.orders[0];await f.run('mergeOrders',{orderId:'bar',revision:source.revision,targetOrderId:f.target.id,targetRevision:f.s.orders.find(o=>o.id===f.target.id).revision},f.staff);
  let order=f.s.orders.find(o=>o.id===f.target.id);let next=(await f.run('beginPayment',{orderId:order.id,revision:order.revision},f.staff)).result;
  await f.run('checkout',{orderId:order.id,revision:order.revision,paymentToken:next.token,operationId:crypto.randomUUID(),selected:[{id:order.lines[0].id,quantity:1}],mode:'cash',received:10000,splitCash:0},f.staff);
  order=f.s.orders.find(o=>o.id===f.target.id);next=(await f.run('beginPayment',{orderId:order.id,revision:order.revision},f.staff)).result;
  await f.run('checkout',{orderId:order.id,revision:order.revision,paymentToken:next.token,operationId:crypto.randomUUID(),selected:order.lines.map(l=>({id:l.id,quantity:l.quantity})),mode:'cash',received:30000,splitCash:0},f.staff);
  assert.deepEqual(await balances(),sold,'same physical quantities remain consumed exactly once');
 }finally{await f.db.close();}
});
for(const mode of ['recipe','no_stock'])test('SQL late '+mode+' mapping remains authoritative on restoration and re-sale after another recipe change',async()=>{
 const f=await fixture('cash',false);try{
  const first=mode==='recipe'?{mode,components:[{productId:f.liquid,quantity:40,unit:'ml'}]}:{mode,reason:'TEST without stock'};
  await f.run('recipe',{productId:'agnis-2810',version:0,...first});
  await f.run('resolveStock',{receiptId:f.sale.id,lineId:f.sale.lines[0].id});
  const balance=async()=>(await f.db.query('select sum(quantity_ml)::text as ml from stock_movements where product_id=$1',[f.liquid])).rows[0].ml;
  const before=await balance();assert.equal(before,mode==='recipe'?'800':'1000');assert.equal(f.sale.lines[0].stockRecipe,null);
  await f.run('recipe',{productId:'agnis-2810',version:1,mode:'recipe',components:[{productId:f.liquid,quantity:20,unit:'ml'}]});
  await f.run('restoreReceipt',{receiptId:f.sale.id,reason:'TEST late mapping'});
  assert.equal(f.s.orders[0].lines[0].stockRecipe.mode,mode);
  if(mode==='recipe')assert.equal(f.s.orders[0].lines[0].stockRecipe.components[0].quantity,40);
  const order=f.s.orders[0],lock=(await f.run('beginPayment',{orderId:'bar',revision:order.revision},f.staff)).result;
  await f.run('checkout',{orderId:'bar',revision:order.revision,paymentToken:lock.token,operationId:crypto.randomUUID(),selected:order.lines.map(l=>({id:l.id,quantity:l.quantity})),mode:'cash',received:30000,splitCash:0},f.staff);
  assert.equal(await balance(),before,'original served quantities remain consumed once');
 }finally{await f.db.close();}
});

test('SQL departure keeps unpaid money and stock, and rejects forged financial changes',async()=>{
 const f=await fixture('cash',true,false,true);try{
  await f.run('addLine',{orderId:f.target.id,productId:'agnis-2810',quantity:2},f.staff);
  const order=f.s.orders.find(o=>o.id===f.target.id),before=await f.snapshot(),financial=structuredClone({receipts:f.s.receipts,sequence:f.s.sequence,shifts:f.s.shifts});
  const request={orderId:order.id,revision:order.revision,endedAt:new Date().toISOString()};
  const command=D.run(f.s,'endVisit',request,f.staff,[]);
  const changed=structuredClone(command.state);changed.orders.find(o=>o.id===order.id).lines[0].quantity=1;
  await assert.rejects(()=>f.commit('endVisit',changed,command.result,f.staff),/preserve/);assert.deepEqual(await f.snapshot(),before);
  await f.run('endVisit',request,f.staff);const after=await f.snapshot();
  assert.deepEqual(after.receipts,before.receipts);assert.deepEqual(after.stock,before.stock);
  assert.deepEqual(f.s.orders.find(o=>o.id===order.id).lines,order.lines);
  assert.deepEqual({receipts:f.s.receipts,sequence:f.s.sequence,shifts:f.s.shifts},financial);
  const audit=after.audit.find(a=>a.event_type==='pos.endVisit');assert.ok(audit);assert.equal(audit.after_data.visit.orderId,order.id);
 }finally{await f.db.close();}
});

test('SQL credit identity, assignment precedence, exact reversal and duplicate/conflict guards use synthetic money only',async()=>{
 const I=require('../../pub_bizz_pos/customer.js'),f=await fixture('cash',false,true,true);try{
  let id=f.target.id;await f.run('renameOrder',{orderId:id,revision:f.s.orders.find(o=>o.id===id).revision,name:'TEST Credit Customer'},f.staff);
  const topup=(await f.run('creditTopup',{orderId:id,amount:50000,method:'card',cardConfirmed:true},f.staff)).result;
  const originalCustomer=topup.customerId,order=()=>f.s.orders.find(o=>o.id===id);
  const renamed=D.run(f.s,'renameOrder',{orderId:id,revision:order().revision,name:'TEST Renamed Customer'},f.staff,[]),before=await f.snapshot();
  for(const alter of [s=>s.customers[0].id=crypto.randomUUID(),s=>s.customers[0].aliases=[],s=>s.creditLedger[0].amount++,s=>s.orders.find(o=>o.id===id).customerId=crypto.randomUUID()]){
   const state=structuredClone(renamed.state);alter(state);await assert.rejects(f.commit('renameOrder',state,renamed.result,f.staff));assert.deepEqual(await f.snapshot(),before);
  }
  await f.run('renameOrder',{orderId:id,revision:order().revision,name:'TEST Renamed Customer'},f.staff);
  await f.run('deleteOrder',{orderId:id},f.staff);id=(await f.run('newOrder',{name:'TEST Renamed Customer'},f.staff)).result.id;
  assert.equal(order().customerId,originalCustomer);assert.equal(C.creditBalance(f.s,originalCustomer),50000);
  await f.run('addLine',{orderId:id,productId:'agnis-2810',quantity:1},f.staff);
  const lock=(await f.run('beginPayment',{orderId:id,revision:order().revision},f.staff)).result;
  const sale=(await f.run('checkout',{orderId:id,revision:order().revision,paymentToken:lock.token,operationId:crypto.randomUUID(),selected:order().lines.map(l=>({id:l.id,quantity:l.quantity})),mode:'credit',received:0,splitCash:0},f.staff)).result;
  const other=(await f.run('newOrder',{name:'TEST Other Customer'},f.staff)).result;
  await f.run('reassignReceipt',{receiptId:sale.id,previousOrderId:id,targetOrderId:other.id,reason:'TEST correct owner'},f.staff);
  assert.equal(I.profile(f.s,order().name,order()).spend,0);assert.equal(I.profile(f.s,other.name,other).spend,sale.total);assert.equal(I.leaderboard(f.s).reduce((n,x)=>n+x.spend,0),sale.total);
  await assert.rejects(f.run('creditReverse',{entryId:topup.id,reason:'TEST spent',cardConfirmed:true,terminalReference:'TEST'}),/čerpán/);
  await f.run('refund',{receiptId:sale.id,reason:'TEST restore original wallet'});assert.equal(C.creditBalance(f.s,originalCustomer),50000);
  const reverse=D.run(f.s,'creditReverse',{entryId:topup.id,reason:'TEST wrong customer',cardConfirmed:true,terminalReference:'TEST-REFUND'},f.owner,[]),stable=await f.snapshot();
  await assert.rejects(f.commit('creditReverse',reverse.state,reverse.result,f.staff),/Manager required/);
  for(const alter of [r=>r.amount++,r=>r.customerId=other.customerId,r=>r.terminalConfirmation.confirmed='true',r=>r.terminalConfirmation.reference='',r=>r.shiftId=crypto.randomUUID()]){
   const result=structuredClone(reverse.result);alter(result);await assert.rejects(f.commit('creditReverse',reverse.state,result));assert.deepEqual(await f.snapshot(),stable);
  }
  const request=crypto.randomUUID(),expected=f.s.revision;
  assert.equal((await f.commit('creditReverse',reverse.state,reverse.result,f.owner,request,'TEST-SAME',expected)).duplicate,false);
  assert.equal((await f.commit('creditReverse',reverse.state,reverse.result,f.owner,request,'TEST-SAME',expected)).duplicate,true);
  assert.equal((await f.commit('creditReverse',reverse.state,reverse.result,f.owner,crypto.randomUUID(),'TEST-STALE',expected)).conflict,true);
  await assert.rejects(f.commit('creditReverse',reverse.state,reverse.result,f.owner,request,'TEST-CHANGED',expected),/reused/);
  assert.equal((await f.db.query("select sum((x->>'amount')::bigint)::text balance from pos_registers p cross join lateral jsonb_array_elements(p.state->'creditLedger') x where x->>'customerId'=$1",[originalCustomer])).rows[0].balance,'0');
  const audit=(await f.db.query("select after_data->'creditMovement' movement from audit_events where event_type='pos.creditReverse'")).rows;assert.equal(audit.length,1);assert.equal(audit[0].movement.reversalOf,topup.id);
  assert.deepEqual((await f.snapshot()).stock,stable.stock);
 }finally{await f.db.close();}
});

for(const substitutions of [false,true])test('SQL carried stock '+(substitutions?'with substitutions':'legacy')+': issue once, split and restore without double stock or revenue',async()=>{
 const f=await fixture('cash',false,substitutions,true);try{
  const id=f.target.id,order=()=>f.s.orders.find(o=>o.id===id);
  await f.run('renameOrder',{orderId:id,revision:order().revision,name:'TEST Unpaid Customer'},f.staff);
  await f.run('recipe',{productId:'agnis-2810',version:0,mode:'recipe',components:[{productId:f.liquid,unit:'ml',quantity:40}]});
  await f.run('addLine',{orderId:id,productId:'agnis-2810',quantity:3,servingMl:20},f.staff);
  const candidate=D.run(f.s,'closeShift',{counted:C.totals(f.s,C.activeShift(f.s).id).expected},f.owner,[]);
  const locked=(await f.run('beginPayment',{orderId:id,revision:order().revision},f.staff)).result,beforeLocked=await f.snapshot();
  candidate.state.revision=f.s.revision+1;
  await assert.rejects(f.commit('closeShift',candidate.state,candidate.result,f.owner,crypto.randomUUID(),'TEST close race',f.s.revision),/Close blocked/);assert.deepEqual(await f.snapshot(),beforeLocked);
  await f.run('cancelPayment',{orderId:id,paymentToken:locked.token,terminalChecked:true,reason:'TEST no terminal payment'},f.staff);
  const before=await f.snapshot(),close=D.run(f.s,'closeShift',{counted:C.totals(f.s,C.activeShift(f.s).id).expected},f.owner,[]);
  for(const alter of [s=>s.orders.find(o=>o.id===id).lines[0].quantity++,s=>s.stockIssues[0].lines[0].stockRecipe.components[0].quantity++,s=>s.stockIssues=[],s=>s.stockIssues.push(s.stockIssues[0])]){
   const state=structuredClone(close.state);alter(state);await assert.rejects(f.commit('closeShift',state,close.result));assert.deepEqual(await f.snapshot(),before);
  }
  const closed=(await f.run('closeShift',{counted:C.totals(f.s,C.activeShift(f.s).id).expected})).result;
  const issue=f.s.stockIssues[0],balance=async()=>(await f.db.query('select sum(quantity_ml)::text ml from stock_movements where product_id=$1',[f.liquid])).rows[0].ml;
  assert.equal(await balance(),'940');assert.equal(closed.summary.unpaidTotal,8250);
  assert.equal((await f.db.query("select count(*)::int n from pos_receipts where kind='sale'")).rows[0].n,1);
  assert.equal((await f.db.query("select count(*)::int n from pos_receipts where kind='issue'")).rows[0].n,1);
  await f.run('openShift',{opening:0});await f.run('creditTopup',{orderId:id,amount:50000,method:'cash'},f.staff);
  const pay=async quantity=>{const lock=(await f.run('beginPayment',{orderId:id,revision:order().revision},f.staff)).result;return(await f.run('checkout',{orderId:id,revision:order().revision,paymentToken:lock.token,operationId:crypto.randomUUID(),selected:[{id:order().lines[0].id,quantity}],mode:'credit',received:0,splitCash:0},f.staff)).result;};
  const sale=await pay(1);assert.equal(await balance(),'940');assert.deepEqual(sale.lines[0].stockIssue,{id:issue.id,offset:0});
  assert.equal((await f.db.query('select status from pos_stock_lines where receipt_id=$1',[sale.id])).rows[0].status,'issued');
  await f.run('restoreReceipt',{receiptId:sale.id,reason:'TEST accidental full payment'});assert.equal(await balance(),'940');
  await f.run('closeShift',{counted:50000});assert.equal(f.s.stockIssues.length,1);assert.equal(await balance(),'940');
  await f.run('openShift',{opening:0});let next=await pay(2);assert.equal(await balance(),'940');
  await f.run('refund',{receiptId:next.id,reason:'TEST actual physical return',restock:true});assert.equal(Number(await balance()),980,'only these two issued 2cl portions return');
  next=await pay(1);assert.equal(Number(await balance()),980);assert.equal(f.s.stockIssues.length,1);
  const clean=await f.snapshot(),forged=structuredClone(f.s);forged.orders[0].lines=[{...next.lines[0],id:crypto.randomUUID()}];forged.revision++;
  await assert.rejects(f.commit('addLine',forged,null,f.staff),/overlap|accounted/);assert.deepEqual(await f.snapshot(),clean);
  if(substitutions){
   const alt=crypto.randomUUID();await f.db.query("insert into products(id,organization_id,name,unit_mode,volume_ml) values($1,$2,'TEST issue alternative','liquid',1000)",[alt,f.org]);
   await f.db.query("insert into stock_movements(organization_id,venue_id,product_id,movement_type,quantity_ml,reason,created_by) values($1,$2,$3,'manual_correction',-960,'TEST source balance',$5),($1,$2,$4,'manual_correction',1000,'TEST alternative balance',$5)",[f.org,f.venue,f.liquid,alt,f.owner.id]);f.stock.push({id:alt,unit_mode:'liquid'});
   await f.run('recipe',{productId:'agnis-2810',version:1,mode:'recipe',components:[{productId:f.liquid,unit:'ml',quantity:40,alternatives:[alt]}]});
   await f.run('addLine',{orderId:id,productId:'agnis-2810',quantity:3,servingMl:20},f.staff);await f.run('closeShift',{counted:0});
   const issued=f.s.stockIssues.at(-1),slice=await f.db.query('select product_id,quantity_ml from pos_issue_stock_slice($1,1,1)',[issued.id]);assert.equal(slice.rows[0].product_id,alt);assert.equal(Number(slice.rows[0].quantity_ml),20);
   await f.run('openShift',{opening:0});const first=await pay(1);await f.run('refund',{receiptId:first.id,reason:'TEST return primary',restock:true});const second=await pay(1);await f.run('refund',{receiptId:second.id,reason:'TEST return alternative',restock:true});
   assert.equal(Number(await balance()),20);assert.equal(Number((await f.db.query('select sum(quantity_ml) ml from stock_movements where product_id=$1',[alt])).rows[0].ml),980);
  }else{
   await f.run('recipe',{productId:'agnis-2810',version:1,mode:'recipe',components:[{productId:f.liquid,unit:'ml',quantity:40},{productId:f.counted,unit:'ks',quantity:1}]});
   await f.run('addLine',{orderId:id,productId:'agnis-2810',quantity:5},f.staff);await f.run('closeShift',{counted:0});await f.run('openShift',{opening:0});
   const first=await pay(2);await f.run('refund',{receiptId:first.id,reason:'TEST first counted return',restock:true});const second=await pay(3);await f.run('refund',{receiptId:second.id,reason:'TEST remaining actual counted return',restock:true});
   assert.equal(Number(await balance()),980);assert.equal(Number((await f.db.query('select sum(quantity_units) units from stock_movements where product_id=$1',[f.counted])).rows[0].units),3,'counted shortages cannot invent returned units');
  }
 }finally{await f.db.close();}
});

test('SQL unpaid missing recipe stays visible, resolves once after payment, and an audit failure rolls all issue/closing writes back',async()=>{
 const f=await fixture('cash',false,true,true);try{
  const id=f.target.id,order=()=>f.s.orders.find(o=>o.id===id);
  await f.run('renameOrder',{orderId:id,revision:order().revision,name:'TEST Missing Recipe'},f.staff);await f.run('addLine',{orderId:id,productId:'agnis-2810',quantity:2,servingMl:20},f.staff);
  const command=D.run(f.s,'closeShift',{counted:27500},f.owner,[]),before=await f.snapshot();
  await f.db.exec(`reset role;create function public.test_fail_credit_close() returns trigger language plpgsql as $$begin if new.event_type='pos.closeShift' then raise exception 'TEST close audit failure';end if;return new;end;$$;create trigger test_fail_credit_close before insert on audit_events for each row execute function public.test_fail_credit_close();set role service_role;`);
  await assert.rejects(f.commit('closeShift',command.state,command.result),/TEST close audit/);assert.deepEqual(await f.snapshot(),before);assert.equal((await f.db.query('select count(*)::int n from closings')).rows[0].n,0);
  await f.db.exec('reset role;drop trigger test_fail_credit_close on audit_events;set role service_role;');
  await f.run('closeShift',{counted:27500});const issue=f.s.stockIssues[0];assert.equal((await f.db.query('select status from pos_stock_lines where receipt_id=$1',[issue.id])).rows[0].status,'missing_recipe');
  await f.run('openShift',{opening:0});const lock=(await f.run('beginPayment',{orderId:id,revision:order().revision},f.staff)).result;
  const sale=(await f.run('checkout',{orderId:id,revision:order().revision,paymentToken:lock.token,operationId:crypto.randomUUID(),selected:order().lines.map(l=>({id:l.id,quantity:l.quantity})),mode:'cash',received:5500,splitCash:0},f.staff)).result;
  await assert.rejects(f.run('refund',{receiptId:sale.id,reason:'TEST physical return before resolving',restock:true}),/Nejdřív ověř/);
  await f.run('recipe',{productId:'agnis-2810',version:0,mode:'recipe',components:[{productId:f.liquid,unit:'ml',quantity:40}]});
  await f.run('resolveStock',{receiptId:issue.id,lineId:issue.lines[0].id});
  assert.equal((await f.db.query("select sum(quantity_ml)::text ml from stock_movements where source_id=$1 and movement_type='sale'",[issue.id])).rows[0].ml,'-40');
  const stable=await f.snapshot();await assert.rejects(f.run('resolveStock',{receiptId:issue.id,lineId:issue.lines[0].id}),/already processed/);assert.deepEqual(await f.snapshot(),stable);
  await f.db.exec('reset role');await f.db.exec(read('supabase/migrations/20261016040732_pos_customer_credit_integrity.sql'));
  assert.deepEqual((await f.db.query("select has_function_privilege('authenticated','public.pos_issue_stock_slice(uuid,int,int)','execute') client,has_function_privilege('service_role','public.pos_issue_stock_slice(uuid,int,int)','execute') service")).rows[0],{client:false,service:true});
 }finally{await f.db.close();}
});
