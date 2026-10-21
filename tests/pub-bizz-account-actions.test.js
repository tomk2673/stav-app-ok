'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict');
for(const directory of ['../pub_bizz_pos/','../supabase/functions/pub-bizz-pos/']) {
 const C=require(directory+'core.js'),D=require(directory+'server-domain.js'),M=require(directory+'marking.js');
 const actor={id:crypto.randomUUID(),role:'staff'};
 function fixture(){
  let state=C.initial();C.execute(state,'openShift',{opening:0});
  const a=C.execute(state,'newOrder',{name:'TEST A'}).id,b=C.execute(state,'newOrder',{name:'TEST B'}).id;
  const run=(type,p)=>{const next=D.run(state,type,p,type==='closeShift'?{...actor,role:'manager'}:actor,[]);state=next.state;return next.result;};
  const order=id=>state.orders.find(o=>o.id===id);
  return {get state(){return state;},run,order,a,b,transfer:selected=>run('mergeOrders',{orderId:a,revision:order(a).revision,targetOrderId:b,targetRevision:order(b).revision,selected})};
 }
 test(directory+'partial transfer preserves remaining quantities, prices, VAT, visits, credit and monetary history',()=>{
  const f=fixture();f.run('addLine',{orderId:f.a,productId:'agnis-2810',quantity:5,servingMl:20});f.run('addLine',{orderId:f.a,productId:'agnis-50',quantity:2});f.run('addLine',{orderId:f.b,productId:'agnis-2810',quantity:1,servingMl:20});
  const before=structuredClone(f.state),line=f.order(f.a).lines[0],result=f.transfer([{id:line.id,quantity:2}]);
  assert.equal(f.order(f.a).lines[0].quantity,3);assert.equal(f.order(f.a).lines[1].quantity,2);
  assert.equal(f.order(f.b).lines[0].quantity,3);assert.equal(f.order(f.b).lines[0].servingMl,20);assert.equal(result.sourceTotal,line.price*2);
  assert.deepEqual(result.selected,[{id:line.id,quantity:2}]);assert.equal(result.movedQuantity,2);
  assert.equal(C.sum(f.state.orders.flatMap(o=>o.lines)),C.sum(before.orders.flatMap(o=>o.lines)));
  for(const key of ['receipts','shifts','creditLedger','stockIssues','customers'])assert.deepEqual(f.state[key],before[key]);
  assert.equal(f.order(f.a).visitId,before.orders.find(o=>o.id===f.a).visitId);assert.equal(f.order(f.b).visitId,before.orders.find(o=>o.id===f.b).visitId);
  C.validate(f.state);
 });
 test(directory+'invalid, duplicated and excessive selected quantities leave both accounts unchanged',()=>{
  const f=fixture();f.run('addLine',{orderId:f.a,productId:'agnis-2810',quantity:3});const id=f.order(f.a).lines[0].id;
  for(const selected of [[],null,[{id,quantity:0}],[{id,quantity:4}],[{id,quantity:1.5}],[{id:'missing',quantity:1}],[{id,quantity:1},{id,quantity:1}]]){
   const before=structuredClone(f.state);assert.throws(()=>f.transfer(selected));assert.deepEqual(f.state,before);
  }
 });
 test(directory+'partial transfer rejects stale source or destination revisions and payment reservations',()=>{
  for(const target of ['a','b']){
   const f=fixture();f.run('addLine',{orderId:f.a,productId:'agnis-2810',quantity:3});
   const p={orderId:f.a,revision:f.order(f.a).revision,targetOrderId:f.b,targetRevision:f.order(f.b).revision,selected:[{id:f.order(f.a).lines[0].id,quantity:1}]};
   f.run('addLine',{orderId:f[target],productId:'agnis-50'});let before=structuredClone(f.state);assert.throws(()=>f.run('mergeOrders',p),/změnil/);assert.deepEqual(f.state,before);
   f.run('beginPayment',{orderId:f[target],revision:f.order(f[target]).revision});before=structuredClone(f.state);assert.throws(()=>f.transfer(p.selected),/platba/);assert.deepEqual(f.state,before);
  }
 });
 test(directory+'partial transfer of previously issued portions keeps disjoint stock ranges',()=>{
  const f=fixture();f.run('addLine',{orderId:f.a,productId:'agnis-2810',quantity:5});f.run('closeShift',{counted:0});f.run('openShift',{opening:0});
  const line=f.order(f.a).lines[0],issue=line.stockIssue.id,history=structuredClone(f.state.stockIssues);
  f.transfer([{id:line.id,quantity:2}]);
  assert.deepEqual(f.order(f.a).lines[0].stockIssue,{id:issue,offset:2});assert.equal(f.order(f.a).lines[0].quantity,3);
  assert.deepEqual(f.order(f.b).lines[0].stockIssue,{id:issue,offset:0});assert.equal(f.order(f.b).lines[0].quantity,2);
  assert.deepEqual(f.state.stockIssues,history);assert.equal(f.state.receipts.length,0);C.validate(f.state);
 });
 test(directory+'undo removes exactly the last batch and audits its original addition',()=>{
  const f=fixture();f.run('addLine',{orderId:f.a,productId:'agnis-2810',quantity:2});f.run('addLine',{orderId:f.a,productId:'agnis-2810',quantity:5});
  const addition=f.state.audit.at(-1),p={orderId:f.a,lineId:f.order(f.a).lines[0].id,quantity:5,undoOf:addition.id,reason:'Test undo'};
  const before=structuredClone(f.state);f.run('removeLine',p);assert.equal(f.order(f.a).lines[0].quantity,2);assert.equal(f.state.audit.at(-1).detail.undoOf,addition.id);
  for(const key of ['receipts','stockIssues','creditLedger','shifts'])assert.deepEqual(f.state[key],before[key]);
  const after=structuredClone(f.state);assert.throws(()=>f.run('removeLine',p));assert.deepEqual(f.state,after);
 });
 test(directory+'undo of a new five-piece row removes it atomically',()=>{
  const f=fixture();f.run('addLine',{orderId:f.a,productId:'agnis-2810',quantity:5});const addition=f.state.audit.at(-1);
  f.run('removeLine',{orderId:f.a,lineId:f.order(f.a).lines[0].id,quantity:5,undoOf:addition.id,reason:'Test undo'});
  assert.equal(f.order(f.a).lines.length,0);assert.equal(f.state.audit.filter(a=>a.type==='removeLine').length,1);
 });
 test(directory+'undo cannot reference another account, a different batch, another actor or an already issued row',()=>{
  const f=fixture();f.run('addLine',{orderId:f.a,productId:'agnis-2810',quantity:3});f.run('addLine',{orderId:f.b,productId:'agnis-2810',quantity:3});
  const addition=f.state.audit.at(-2),p={orderId:f.a,lineId:f.order(f.a).lines[0].id,quantity:3,undoOf:addition.id,reason:'Test undo'};
  for(const patch of [{quantity:2},{undoOf:'missing'},{orderId:f.b,lineId:f.order(f.b).lines[0].id}]){
   const before=structuredClone(f.state);assert.throws(()=>f.run('removeLine',{...p,...patch}));assert.deepEqual(f.state,before);
  }
  assert.throws(()=>D.run(f.state,'removeLine',p,{id:crypto.randomUUID(),role:'staff'},[]),/jiné obsluze/);
  f.run('closeShift',{counted:0});f.run('openShift',{opening:0});assert.throws(()=>f.run('removeLine',p),/skladu/);
 });
 test(directory+'offline add and undo replay exactly once with their immutable marking references',()=>{
  const f=fixture(),add=M.prepare(f.state,'addLine',{orderId:f.a,productId:'agnis-2810',quantity:5},crypto.randomUUID()),local=structuredClone(f.state);
  M.apply(local,'addLine',add,new Date().toISOString(),actor.id);
  const undo=M.prepare(local,'removeLine',{orderId:f.a,lineId:local.orders.find(o=>o.id===f.a).lines[0].id,quantity:5,undoOf:add.marking.operationId,reason:'Test undo'},crypto.randomUUID());
  M.apply(local,'removeLine',undo,new Date().toISOString(),actor.id);f.run('addLine',add);f.run('removeLine',undo);
  assert.equal(f.order(f.a).lines.length,0);assert.equal(M.applied(f.state,add.marking.operationId),true);assert.equal(M.applied(f.state,undo.marking.operationId),true);
 });
}
