'use strict';
const test=require('node:test'), assert=require('node:assert/strict'), fs=require('node:fs'), path=require('node:path');
const {PGlite}=require('@electric-sql/pglite');
const C=require('../../pub_bizz_pos/core.js'), D=require('../../pub_bizz_pos/server-domain.js');
const root=path.resolve(__dirname,'../..');
const read=file=>fs.readFileSync(path.join(root,file),'utf8');
const migration='supabase/migrations/20261013222653_pos_receipt_terminal_guard.sql';
async function fixture(mode='cash',mapped=true,substitutions=false){
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
 if(process.env.POS_COMMIT_FIXTURE)await db.exec(fs.readFileSync(process.env.POS_COMMIT_FIXTURE,'utf8'));
 if(process.env.POS_STOCK_SUPPORT)await db.exec(fs.readFileSync(process.env.POS_STOCK_SUPPORT,'utf8'));
 if(process.env.POS_STOCK_FIXTURE)await db.exec(fs.readFileSync(process.env.POS_STOCK_FIXTURE,'utf8'));
 if(substitutions)await db.exec(read('tests/fixtures/pub-bizz-stock-available.sql'));
 await db.exec(read(migration));
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
 const run=async(type,p,actor=owner)=>{const records=type==='restoreReceipt'?(await db.query('select line_id,status,recipe from pos_stock_lines where receipt_id=$1',[p.receiptId])).rows:[];const command=D.run(s,type,p,actor,stock,new Date().toISOString(),records);const r=await commit(type,command.state,command.result,actor);s=command.state;return {result:command.result,requestResult:r};};
 await run('openShift',{opening:0});const target=(await run('newOrder',{name:'Stůl 2'},staff)).result;
 if(mapped)await run('recipe',{productId:'agnis-2810',version:0,mode:'recipe',components:[{productId:liquid,unit:'ml',quantity:40},{productId:counted,unit:'ks',quantity:1}]});
 await run('addLine',{orderId:'bar',productId:'agnis-2810',quantity:5},staff);
 const lock=(await run('beginPayment',{orderId:'bar',revision:s.orders[0].revision},staff)).result;
 const sale=(await run('checkout',{orderId:'bar',revision:s.orders[0].revision,paymentToken:lock.token,operationId:crypto.randomUUID(),selected:s.orders[0].lines.map(l=>({id:l.id,quantity:l.quantity})),mode,received:30000,splitCash:1000,cardConfirmed:true},staff)).result;
 const snapshot=async()=>({register:(await db.query('select state,revision from pos_registers')).rows,receipts:(await db.query('select id,payload from pos_receipts order by occurred_at,id')).rows,stock:(await db.query('select product_id,quantity_ml,quantity_units,untracked_units,source_type,source_id from stock_movements order by id')).rows,requests:(await db.query('select request_id from pos_requests order by request_id')).rows,audit:(await db.query('select event_type,after_data from audit_events order by id')).rows});
 return {db,org,venue,owner,staff,sale,target,liquid,counted,stock,run,commit,snapshot,get s(){return s;}};
}
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
