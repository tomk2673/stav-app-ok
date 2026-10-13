'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const owner={id:crypto.randomUUID(),role:'owner'}, staff={id:crypto.randomUUID(),role:'staff'};
const now='2026-10-13T22:00:00.000Z';
const directories=['../pub_bizz_pos','../supabase/functions/pub-bizz-pos'];
if(process.env.POS_EDGE_FIXTURE)directories.push(process.env.POS_EDGE_FIXTURE);
for(const directory of directories){
 const root=path.resolve(__dirname,directory), C=require(path.join(root,'core.js')), D=require(path.join(root,'server-domain.js'));
 const label=path.basename(root)+' '+directory;
 function fixture(mode='cash',splitCash=1000){
  let s=C.initial();
  const run=(type,p,actor=owner)=>{const next=D.run(s,type,p,actor,[],now);s=next.state;return next.result;};
  run('openShift',{opening:10000});
  const target=run('newOrder',{name:'Stůl 2'});
  run('addLine',{orderId:'bar',productId:'agnis-2810',quantity:2});
  const o=s.orders[0], lock=run('beginPayment',{orderId:o.id,revision:o.revision},staff);
  const sale=run('checkout',{orderId:o.id,revision:o.revision,paymentToken:lock.token,operationId:crypto.randomUUID(),selected:o.lines.map(l=>({id:l.id,quantity:l.quantity})),mode,received:20000,splitCash,cardConfirmed:true},staff);
  return {get s(){return s;},run,sale,target};
 }
 for(const mode of ['cash','card','split']){
  test(label+': '+mode+' restore requires manager, preserves original and can reverse only once',()=>{
   const f=fixture(mode), original=structuredClone(f.sale),before=structuredClone(f.s);
   const p={receiptId:f.sale.id,reason:'Vrácená platba',cardConfirmed:true,terminalReference:'TERM-TEST-123'};
   for(const role of ['staff','accountant'])assert.throws(()=>f.run('restoreReceipt',p,{...staff,role}),/vedoucí|oprávnění/);
   assert.deepEqual(f.s,before);
   const r=f.run('restoreReceipt',p,{...owner,role:'manager'});
   assert.equal(r.cash,-original.cash);assert.equal(r.card,-original.card);assert.equal(r.total,-original.total);assert.equal(r.restock,true);
   assert.equal(r.restoredToOrderId,'bar');assert.deepEqual(f.s.receipts[0],original);assert.equal(f.s.orders[0].lines[0].quantity,2);
   assert.equal(C.totals(f.s,original.shiftId).total,0);assert.equal(f.s.audit.at(-1).actorId,owner.id);
   assert.equal(f.s.audit.at(-1).detail.reason,p.reason);
   if(original.card){assert.deepEqual(r.terminalConfirmation,{method:'manual',confirmed:true,reference:p.terminalReference,at:now,actorId:owner.id});}
   else assert.equal(r.terminalConfirmation,null);
   const restored=structuredClone(f.s);
   for(const type of ['restoreReceipt','refund'])assert.throws(()=>f.run(type,p),/už/);
   assert.deepEqual(f.s,restored);C.validate(f.s);
  });
  test(label+': '+mode+' assignment changes only metadata/audit, leaving paid items and money intact',()=>{
   const f=fixture(mode), before=structuredClone(f.s);
   f.s.loyalty={enabled:true,threshold:10000,rewards:[{id:'test',receiptId:f.sale.id,status:'available'}]};
   const loyalty=structuredClone(f.s.loyalty);
   const p={receiptId:f.sale.id,targetOrderId:f.target.id,previousOrderId:'bar',reason:'Oprava přiřazení účtu'};
   const result=f.run('reassignReceipt',p,staff);
   assert.equal(result.type,'reassignReceipt');assert.equal(result.orderId,f.target.id);
   for(const key of ['orders','receipts','shifts','recipes','sequence'])assert.deepEqual(f.s[key],before[key],key);
   assert.deepEqual(f.s.loyalty,loyalty);assert.deepEqual(C.totals(f.s,f.sale.shiftId),C.totals(before,f.sale.shiftId));
   assert.equal(f.s.audit.at(-1).actorId,staff.id);assert.deepEqual(f.s.audit.at(-1).assignment,result);
   assert.equal(C.receiptAccount(f.s,f.sale).orderName,'Stůl 2');assert.equal(f.sale.orderName,'Rychlý prodej');
   const assigned=structuredClone(f.s);assert.throws(()=>f.run('reassignReceipt',p,staff),/změnilo/);assert.deepEqual(f.s,assigned);
   assert.throws(()=>f.run('reassignReceipt',{...p,targetOrderId:'bar'},staff),/změnilo/);
   f.run('reassignReceipt',{...p,targetOrderId:'bar',previousOrderId:f.target.id},staff);
   assert.equal(C.receiptAccount(f.s,f.sale).orderId,'bar');C.validate(f.s);
  });
 }
 for(const mode of ['card','split'])for(const type of ['restoreReceipt','refund']){
  test(label+': '+mode+' '+type+' rejects every non-boolean confirmation and malformed terminal reference before mutation',()=>{
   const f=fixture(mode), before=structuredClone(f.s), p={receiptId:f.sale.id,reason:'Test',terminalReference:'TERM-1'};
   for(const value of [undefined,false,null,0,1,'false','true',{},[]]){
    assert.throws(()=>C.execute(f.s,type,{...p,cardConfirmed:value},now),/terminálu/);assert.deepEqual(f.s,before);
   }
   for(const reference of [undefined,null,'','   ',123,{},'X'.repeat(121)]){
    assert.throws(()=>C.execute(f.s,type,{...p,cardConfirmed:true,terminalReference:reference},now),/číslo/);assert.deepEqual(f.s,before);
   }
   assert.throws(()=>C.execute(f.s,type,{...p,cardConfirmed:true,reason:''},now),/důvod/);assert.deepEqual(f.s,before);
  });
 }
 test(label+': an entirely cash split needs no terminal assertion; ordinary cash refund retains optional restock',()=>{
  const f=fixture('split',11000);assert.equal(f.sale.card,0);
  assert.equal(f.run('restoreReceipt',{receiptId:f.sale.id,reason:'Hotově'}).terminalConfirmation,null);
  for(const restock of [false,true]){const g=fixture();const r=g.run('refund',{receiptId:g.sale.id,reason:'Vráceno',restock});assert.equal(r.restock,restock);assert.equal(g.s.orders[0].lines.length,0);}
 });
 test(label+': restoring checks locks, missing accounts, shift and limits atomically; old schema-1 backups remain readable',()=>{
  const f=fixture();delete f.s.receiptAssignments;C.validate(f.s);
  for(const patch of [s=>s.orders[0].paymentLock={token:'reserved'},s=>s.orders=s.orders.filter(o=>o.id!=='bar'),s=>s.shifts[0].closedAt=now,s=>s.orders[0].lines=[{...s.receipts[0].lines[0],id:crypto.randomUUID(),price:100000000,quantity:1}]]){
   const s=structuredClone(f.s);patch(s);const before=structuredClone(s);
   assert.throws(()=>C.execute(s,'restoreReceipt',{receiptId:f.sale.id,reason:'Test'},now));assert.deepEqual(s,before);
  }
  const before=structuredClone(f.s);
  for(const p of [{targetOrderId:'missing'},{reason:''},{previousOrderId:'stale'}]){
   assert.throws(()=>f.run('reassignReceipt',{receiptId:f.sale.id,targetOrderId:f.target.id,previousOrderId:'bar',reason:'Test',...p},staff));assert.deepEqual(f.s,before);
  }
 });
 test(label+': restore, new marking, merge and partial re-sale preserve the consumed recipe snapshot',()=>{
  const f=fixture(), original={version:1,mode:'recipe',components:[{productId:crypto.randomUUID(),quantity:40,unit:'ml'}]};
  f.s.receipts[0].lines[0].stockRecipe=structuredClone(original);
  f.s.recipes['agnis-2810']={...original,version:2,components:[{...original.components[0],quantity:20}]};
  f.run('restoreReceipt',{receiptId:f.sale.id,reason:'Test'});
  f.run('addLine',{orderId:'bar',productId:'agnis-2810'});assert.equal(f.s.orders[0].lines.length,2);
  f.run('addLine',{orderId:f.target.id,productId:'agnis-2810'});
  f.run('mergeOrders',{orderId:'bar',revision:f.s.orders[0].revision,targetOrderId:f.target.id,targetRevision:f.s.orders.find(o=>o.id===f.target.id).revision},staff);
  const target=f.s.orders.find(o=>o.id===f.target.id);assert.equal(target.lines.length,2);
  const restored=target.lines.find(l=>l.stockRecipe), lock=f.run('beginPayment',{orderId:target.id,revision:target.revision},staff);
  const partial=f.run('checkout',{orderId:target.id,revision:target.revision,paymentToken:lock.token,operationId:crypto.randomUUID(),selected:[{id:restored.id,quantity:1}],mode:'cash',received:10000,splitCash:0},staff);
  assert.deepEqual(partial.lines[0].stockRecipe,original);
  const remaining=f.s.orders.find(o=>o.id===target.id), nextLock=f.run('beginPayment',{orderId:target.id,revision:remaining.revision},staff);
  const final=f.run('checkout',{orderId:target.id,revision:remaining.revision,paymentToken:nextLock.token,operationId:crypto.randomUUID(),selected:remaining.lines.map(l=>({id:l.id,quantity:l.quantity})),mode:'cash',received:40000,splitCash:0},staff);
  assert.equal(final.lines.find(l=>l.id===restored.id).stockRecipe.components[0].quantity,40);
  assert.equal(final.lines.find(l=>l.id!==restored.id).stockRecipe.components[0].quantity,20);C.validate(f.s);
 });
 test(label+': financial restore uses corrected attribution and cancels existing receipt rewards, neutral assignment does not',()=>{
  const f=fixture('card');f.s.loyalty={enabled:true,threshold:10000,rewards:[{id:'test',receiptId:f.sale.id,status:'available'}]};
  f.run('reassignReceipt',{receiptId:f.sale.id,targetOrderId:f.target.id,previousOrderId:'bar',reason:'Test'},staff);
  const r=f.run('restoreReceipt',{receiptId:f.sale.id,reason:'Test',cardConfirmed:true,terminalReference:'TERM-1'});
  assert.equal(r.restoredToOrderId,f.target.id);assert.equal(f.s.orders[0].lines.length,0);assert.equal(f.s.orders.find(o=>o.id===f.target.id).lines[0].quantity,2);
  assert.equal(f.s.loyalty.rewards[0].refunded,true);assert.equal(f.s.loyalty.rewards[0].status,'cancelled');
 });
 test(label+': trusted resolved substitutions restore actual whole portions; command payload cannot forge those snapshots',()=>{
  const f=fixture(),line=f.sale.lines[0],a=crypto.randomUUID(),b=crypto.randomUUID(),mixer=crypto.randomUUID();
  const record={line_id:line.id,status:'posted',recipe:{version:1,mode:'recipe',selection:'available',components:[{productId:a,unit:'ml',quantity:40},{productId:mixer,unit:'ml',quantity:200}],resolvedComponents:[
   {requestedProductId:a,productId:a,unit:'ml',quantity:40,portions:1},{requestedProductId:a,productId:b,unit:'ml',quantity:40,portions:1},{requestedProductId:mixer,productId:mixer,unit:'ml',quantity:400,portions:2}
  ]}};
  const p={receiptId:f.sale.id,reason:'TEST',restoredLines:{[line.id]:[{quantity:2,stockRecipe:{mode:'no_stock',reason:'forged'}}]}};
  const restored=D.run(f.s,'restoreReceipt',p,owner,[],now,[record]);
  const parts=restored.state.orders[0].lines;assert.equal(parts.length,2);assert.deepEqual(parts.map(l=>l.quantity),[1,1]);
  assert.deepEqual(parts.map(l=>l.stockRecipe.components[0].productId),[a,b]);assert.ok(parts.every(l=>l.stockRecipe.components[1].quantity===200));
  assert.ok(parts.every(l=>!l.stockRecipe.selection));assert.equal(C.sum(parts),f.sale.total);
  const forged=D.run(f.s,'restoreReceipt',p,owner,[],now);assert.equal(forged.state.orders[0].lines[0].stockRecipe,null);
  for(const patch of [{portions:0},{portions:3},{unit:'ks'}]){
   const changed=structuredClone(record);Object.assign(changed.recipe.resolvedComponents[0],patch);
   assert.throws(()=>D.run(f.s,'restoreReceipt',p,owner,[],now,[changed]),/původní/);
  }
 });
}
test('Edge files are byte-for-byte copies of the canonical core, domain, catalog and preserved loyalty module',()=>{
 for(const file of ['core.js','server-domain.js','catalog.js','loyalty.js'])assert.equal(fs.readFileSync(path.resolve(__dirname,'../pub_bizz_pos',file),'utf8'),fs.readFileSync(path.resolve(__dirname,'../supabase/functions/pub-bizz-pos',file),'utf8'),file);
});
