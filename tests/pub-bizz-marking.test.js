'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const C=require('../pub_bizz_pos/core.js'),D=require('../pub_bizz_pos/server-domain.js'),M=require('../pub_bizz_pos/marking.js');
const actor={id:crypto.randomUUID(),role:'staff'};
function fixture(){let s=C.initial();C.execute(s,'openShift',{opening:0});const a=C.execute(s,'newOrder',{name:'Test A'}),b=C.execute(s,'newOrder',{name:'Test B'});return {s,a:a.id,b:b.id};}
const prepare=(s,type,p)=>M.prepare(s,type,p,crypto.randomUUID());
const add=(s,id,quantity=1)=>prepare(s,'addLine',{orderId:id,productId:'agnis-2810',quantity});
const run=(s,type,p)=>D.run(s,type,p,actor,[]).state;
test('two devices add concurrently to the same account without losing either quantity',()=>{
 const {s,a}=fixture(),phone=add(s,a,3),pc=add(s,a,2);
 const next=run(run(s,'addLine',phone),'addLine',pc),o=next.orders.find(o=>o.id===a);
 assert.equal(o.lines.length,1);assert.equal(o.lines[0].quantity,5);assert.equal(next.receipts.length,0);assert.equal(next.stockIssues.length,0);
 assert.equal(next.audit.find(e=>e.detail.marking?.operationId===pc.marking.operationId).markingResult.lineId,o.lines[0].id);
});
test('local add, set and minus intents replay in order with stable IDs and versions',()=>{
 const {s,a}=fixture(),p=add(s,a,4),local=structuredClone(s);M.apply(local,'addLine',p,new Date().toISOString(),actor.id);
 const line=local.orders.find(o=>o.id===a).lines[0],edit=prepare(local,'setLineQuantity',{orderId:a,lineId:line.id,quantity:7});
 M.apply(local,'setLineQuantity',edit,new Date().toISOString(),actor.id);
 const minus=prepare(local,'removeLine',{orderId:a,lineId:line.id,reason:'Test correction'});
 const server=run(run(run(s,'addLine',p),'setLineQuantity',edit),'removeLine',minus);
 assert.equal(server.orders.find(o=>o.id===a).lines[0].quantity,6);assert.equal(server.orders.find(o=>o.id===a).lines[0].id,p.marking.operationId);
});
test('unrelated accounts do not create quantity conflicts for the same drink',()=>{
 const {s,a,b}=fixture();let next=run(s,'addLine',add(s,a,3));const o=next.orders.find(o=>o.id===a),edit=prepare(next,'setLineQuantity',{orderId:a,lineId:o.lines[0].id,quantity:4});
 next=run(next,'addLine',add(next,b));next=run(next,'setLineQuantity',edit);
 assert.equal(next.orders.find(o=>o.id===a).lines[0].quantity,4);
});
test('absolute corrections detect other-device changes even when quantity returns to its original value',()=>{
 const f=fixture();let s=run(f.s,'addLine',add(f.s,f.a,3)),o=s.orders.find(o=>o.id===f.a);
 const edit=prepare(s,'setLineQuantity',{orderId:o.id,lineId:o.lines[0].id,quantity:8});
 s=run(s,'addLine',add(s,o.id));s=run(s,'removeLine',{orderId:o.id,lineId:o.lines[0].id,reason:'External correction'});
 assert.equal(s.orders.find(x=>x.id===o.id).lines[0].quantity,3);
 assert.throws(()=>run(s,'setLineQuantity',edit),/jiné zařízení/);
});
test('a provisional row aliases only its recorded canonical row and stale counts conflict',()=>{
 const {s,a}=fixture(),first=add(s,a),second=add(s,a),local=structuredClone(s);M.apply(local,'addLine',second);
 const line=local.orders.find(o=>o.id===a).lines[0],edit=prepare(local,'setLineQuantity',{orderId:a,lineId:line.id,quantity:5});
 const server=run(run(s,'addLine',first),'addLine',second);
 assert.throws(()=>run(server,'setLineQuantity',edit),/jiné zařízení/);
 assert.equal(server.orders.find(o=>o.id===a).lines.length,1);
});
test('offline intents cannot follow a rename, merge, payment, changed price, deleted account or different shift',()=>{
 const f=fixture(),intent=add(f.s,f.a);
 let renamed=run(f.s,'renameOrder',{orderId:f.a,revision:0,name:'Another test guest'});
 assert.throws(()=>run(renamed,'addLine',intent),/host se změnil/);
 let filled=run(f.s,'addLine',add(f.s,f.a)),o=filled.orders.find(x=>x.id===f.a),pending=add(filled,f.a);
 const merged=run(filled,'mergeOrders',{orderId:f.a,targetOrderId:f.b,revision:o.revision,targetRevision:0});
 assert.throws(()=>run(merged,'addLine',pending),/převedený/);
 const locked=D.run(filled,'beginPayment',{orderId:f.a,revision:o.revision},actor,[]);
 const live=locked.state.orders.find(x=>x.id===f.a);
 const paid=run(locked.state,'checkout',{orderId:f.a,revision:live.revision,paymentToken:locked.result.token,operationId:crypto.randomUUID(),selected:live.lines.map(l=>({id:l.id,quantity:l.quantity})),mode:'cash',received:10000,splitCash:0});
 assert.throws(()=>run(paid,'addLine',pending),/placený/);
 const changed=structuredClone(f.s);changed.products.find(p=>p.id==='agnis-2810').price++;
 assert.throws(()=>run(changed,'addLine',intent),/cena/);
 const deleted=run(f.s,'deleteOrder',{orderId:f.a});assert.throws(()=>run(deleted,'addLine',intent),/host se změnil/);
 const shift=structuredClone(f.s);shift.shifts[0].id=crypto.randomUUID();assert.throws(()=>run(shift,'addLine',intent),/Směna/);
});
test('rejection is an audited no-op with its UUID and cannot be mistaken for an applied line',()=>{
 const {s,a}=fixture(),p=add(s,a),rejected=M.reject(s,'addLine',p,'Conflict',actor.id);
 assert.deepEqual(rejected.state.orders,s.orders);assert.deepEqual(rejected.state.receipts,s.receipts);assert.deepEqual(rejected.state.stockIssues,s.stockIssues);
 assert.equal(rejected.state.revision,s.revision+1);assert.equal(rejected.result.requestId,p.marking.operationId);
 assert.equal(M.applied(rejected.state,p.marking.operationId),false);assert.equal(M.outcome(rejected.state,p.marking.operationId).type,'markingRejected');
});
test('2cl intent retains count, portion and price; no financial operation is an optimistic marking command',()=>{
 const {s,a}=fixture(),p=prepare(s,'addLine',{orderId:a,productId:'agnis-2810',quantity:5,servingMl:20}),next=run(s,'addLine',p),l=next.orders.find(o=>o.id===a).lines[0];
 assert.equal(l.quantity,5);assert.equal(l.servingMl,20);assert.equal(l.price,2750);
 for(const type of ['checkout','refund','closeShift','creditTopup','restoreReceipt','beginPayment'])assert.throws(()=>prepare(s,type,{}),/Neplatná/);
 assert.throws(()=>D.run(s,'addLine',p,{...actor,role:'accountant'},[]),/oprávnění/);
});
