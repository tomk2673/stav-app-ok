const {test}=require('node:test');
const assert=require('node:assert/strict');
const I=require('../pub_bizz_pos/customer.js');
for(const prefix of ['../pub_bizz_pos/','../supabase/functions/pub-bizz-pos/']){
 const C=require(prefix+'core.js'),D=require(prefix+'server-domain.js'),actor={id:crypto.randomUUID(),role:'staff'};
 function setup(){let s=C.initial();const run=(type,p,at)=>{const out=D.run(s,type,p,actor,[],at);s=out.state;return out.result;};run('openShift',{opening:0},'2026-10-14T20:00:00Z');const id=run('newOrder',{name:'TEST Host A'},'2026-10-14T20:01:00Z').id;return {get s(){return s;},run,id,order:()=>s.orders.find(o=>o.id===id)};}
 const frozen=s=>structuredClone({receipts:s.receipts,sequence:s.sequence,shifts:s.shifts,products:s.products,loyalty:s.loyalty});
 test(prefix+'legacy unpaid account separates next-day activity without mutating any financial data',()=>{
  const f=setup();f.run('addLine',{orderId:f.id,productId:'agnis-2810'},'2026-10-14T23:03:54.805Z');
  f.run('addLine',{orderId:f.id,productId:'agnis-2810'},'2026-10-14T23:08:02.490Z');
  // Replay the pre-fix state: one old start, fresh next-day audit, no last-activity field.
  const legacy=structuredClone(f.s),o=legacy.orders.find(o=>o.id===f.id);delete o.visitLastActivityAt;
  legacy.audit.push({type:'addLine',at:'2026-10-15T03:29:31.969Z',detail:{orderId:f.id}},{type:'addLine',at:'2026-10-15T20:42:06.715Z',detail:{orderId:f.id}});
  const before=structuredClone(legacy),p=I.profile(legacy,o.name,o,'2026-10-15T20:46:06.715Z');
  assert.equal(p.currentMinutes,4);assert.equal(p.estimatedVisitCount,2);assert.equal(p.lastVisit.startedAt,'2026-10-15T20:42:06.715Z');assert.deepEqual(legacy,before);
 });
 test(prefix+'idle time stops after 120 minutes and next marking starts a new visit on the same debt',()=>{
  const f=setup();f.run('addLine',{orderId:f.id,productId:'agnis-2810',quantity:2},'2026-10-14T21:00:00Z');const id=f.order().visitId,old=structuredClone(f.order().lines),financial=frozen(f.s);
  const p=I.profile(f.s,f.order().name,f.order(),'2026-10-15T18:00:00Z');assert.equal(p.currentMinutes,0);assert.equal(p.totalMinutes,120);assert.equal(p.estimatedVisitCount,1);
  f.run('addLine',{orderId:f.id,productId:'agnis-2810'},'2026-10-15T19:00:00Z');assert.notEqual(f.order().visitId,id);assert.equal(f.order().visitStartedAt,'2026-10-15T19:00:00Z');assert.equal(f.order().lines[0].quantity,old[0].quantity+1);assert.deepEqual(frozen(f.s),financial);
  assert.equal(I.profile(f.s,f.order().name,f.order(),'2026-10-15T19:05:00Z').totalMinutes,120);C.validate(f.s);
 });
 test(prefix+'manual departure keeps full unpaid order and paid statistics; later payment keeps departure time',()=>{
  const f=setup();f.run('addLine',{orderId:f.id,productId:'agnis-2810',quantity:3},'2026-10-14T21:00:00Z');const old=structuredClone(f.order()),financial=frozen(f.s);
  const end=f.run('endVisit',{orderId:f.id,revision:old.revision,endedAt:'2026-10-14T21:45:00Z'},'2026-10-14T22:00:00Z');assert.equal(end.durationMinutes,45);assert.equal(end.estimated,false);assert.deepEqual(f.order().lines,old.lines);assert.deepEqual(frozen(f.s),financial);
  let p=I.profile(f.s,f.order().name,f.order(),'2026-10-15T19:00:00Z');assert.equal(p.currentMinutes,0);assert.equal(p.totalMinutes,45);assert.equal(p.points,0);
  const lock=f.run('beginPayment',{orderId:f.id,revision:f.order().revision},'2026-10-15T19:00:00Z');
  const receipt=f.run('checkout',{orderId:f.id,revision:f.order().revision,paymentToken:lock.token,operationId:crypto.randomUUID(),selected:f.order().lines.map(l=>({id:l.id,quantity:l.quantity})),mode:'cash',received:20000},'2026-10-15T19:01:00Z');
  assert.equal(receipt.visitEndedAt,'2026-10-14T21:45:00.000Z');assert.equal(receipt.visitDurationMinutes,45);assert.equal(receipt.total,C.sum(old.lines));assert.equal(f.order().visitStartedAt,undefined);
  p=I.profile(f.s,f.order().name,f.order());assert.equal(p.totalMinutes,45);C.validate(f.s);
 });
 test(prefix+'paying old debt in several parts never reopens the ended visit',()=>{
  const f=setup();f.run('addLine',{orderId:f.id,productId:'agnis-2810',quantity:3},'2026-10-14T21:00:00Z');
  function pay(quantity,at){const lock=f.run('beginPayment',{orderId:f.id,revision:f.order().revision},at);return f.run('checkout',{orderId:f.id,revision:f.order().revision,paymentToken:lock.token,operationId:crypto.randomUUID(),selected:[{id:f.order().lines[0].id,quantity}],mode:'cash',received:20000},at);}
  const first=pay(1,'2026-10-15T19:00:00Z');assert.equal(first.visitDurationMinutes,120);assert.equal(f.order().visitEndedAt,'2026-10-14T23:00:00.000Z');
  const final=pay(2,'2026-10-15T19:01:00Z');assert.equal(final.visitEndedAt,first.visitEndedAt);assert.equal(final.visitDurationMinutes,120);assert.equal(final.visitEstimated,true);C.validate(f.s);
 });
 test(prefix+'invalid, locked, stale and unauthorized departure requests are atomic',()=>{
  const f=setup();f.run('addLine',{orderId:f.id,productId:'agnis-2810'},'2026-10-14T21:00:00Z');
  for(const change of [{revision:-1},{endedAt:'2026-10-14T20:00:00Z'},{endedAt:'2026-10-16T00:00:00Z'},{endedAt:'invalid'},{orderId:'bar'}]){const before=structuredClone(f.s);assert.throws(()=>f.run('endVisit',{orderId:f.id,revision:f.order().revision,...change},'2026-10-14T22:00:00Z'));assert.deepEqual(f.s,before);}
  f.run('beginPayment',{orderId:f.id,revision:f.order().revision},'2026-10-14T22:00:00Z');const before=structuredClone(f.s);assert.throws(()=>f.run('endVisit',{orderId:f.id,revision:f.order().revision},'2026-10-14T22:00:00Z'),/platbu/);assert.deepEqual(f.s,before);
  assert.throws(()=>D.run(f.s,'endVisit',{orderId:f.id,revision:f.order().revision},{id:actor.id,role:'accountant'},[]),/oprávnění/);
 });
 test(prefix+'merging two customers preserves independent visit clocks, histories, identities and wallets',()=>{
  const f=setup(),target=f.run('newOrder',{name:'TEST Host B'},'2026-10-14T20:02:00Z').id;
  const order=id=>f.s.orders.find(o=>o.id===id);
  f.run('addLine',{orderId:target,productId:'agnis-2810'},'2026-10-14T20:05:00Z');
  f.run('addLine',{orderId:f.id,productId:'agnis-2810'},'2026-10-14T23:00:00Z');
  const sourceBefore=structuredClone(f.order()),targetBefore=structuredClone(order(target)),financial=frozen(f.s),customers=structuredClone(f.s.customers);
  f.run('mergeOrders',{orderId:f.id,revision:f.order().revision,targetOrderId:target,targetRevision:order(target).revision},'2026-10-14T23:01:00Z');
  for(const key of ['visitId','visitStartedAt','visitLastActivityAt','visitEndedAt','visitEndEstimated','customerId']){
   assert.equal(f.order()[key],sourceBefore[key]);assert.equal(order(target)[key],targetBefore[key]);
  }
  assert.deepEqual(frozen(f.s),financial);assert.deepEqual(f.s.customers,customers);
  assert.equal(f.order().lines.length,0);assert.equal(C.sum(order(target).lines),C.sum(sourceBefore.lines)+C.sum(targetBefore.lines));
  const sourceProfile=I.profile(f.s,f.order().name,f.order(),'2026-10-14T23:02:00Z'),targetProfile=I.profile(f.s,order(target).name,order(target),'2026-10-14T23:02:00Z');
  assert.equal(sourceProfile.currentMinutes,2);assert.equal(sourceProfile.lastVisit.lastActivityAt,'2026-10-14T23:00:00.000Z');
  assert.equal(targetProfile.currentMinutes,0);assert.equal(targetProfile.totalMinutes,120);assert.equal(targetProfile.visits.length,1);
  const audit=f.s.audit.at(-1);assert.equal(audit.merge.visitSnapshots.source[0].customerId,sourceBefore.customerId);assert.equal(audit.merge.visitSnapshots.target[0].customerId,targetBefore.customerId);
  f.run('addLine',{orderId:f.id,productId:'agnis-2810'},'2026-10-14T23:03:00Z');assert.equal(f.order().visitId,sourceBefore.visitId,'empty source still represents its original host');
  f.run('addLine',{orderId:target,productId:'agnis-2810'},'2026-10-14T23:04:00Z');assert.notEqual(order(target).visitId,targetBefore.visitId);assert.notEqual(order(target).visitId,sourceBefore.visitId);
  assert.equal(I.profile(f.s,f.order().name,f.order(),'2026-10-14T23:05:00Z').currentMinutes,5);C.validate(f.s);
 });
 test(prefix+'merging into an empty account or quick sale never invents a visit for its payer',()=>{
  for(const quick of [false,true]){
   const f=setup(),id=quick?'bar':f.run('newOrder',{name:'TEST Payer'},'2026-10-14T20:02:00Z').id;
   f.run('addLine',{orderId:f.id,productId:'agnis-2810'},'2026-10-14T21:00:00Z');const source=structuredClone(f.order()),target=()=>f.s.orders.find(o=>o.id===id);
   f.run('mergeOrders',{orderId:f.id,revision:f.order().revision,targetOrderId:id,targetRevision:target().revision},'2026-10-14T21:10:00Z');
   assert.equal(target().visitId,undefined);assert.equal(f.order().visitId,source.visitId);
   const lock=f.run('beginPayment',{orderId:id,revision:target().revision},'2026-10-14T21:11:00Z');
   const sale=f.run('checkout',{orderId:id,revision:target().revision,paymentToken:lock.token,operationId:crypto.randomUUID(),selected:target().lines.map(l=>({id:l.id,quantity:l.quantity})),mode:'cash',received:20000},'2026-10-14T21:12:00Z');
   assert.equal(sale.visitId,undefined);assert.equal(sale.total,C.sum(source.lines));
   assert.equal(I.profile(f.s,f.order().name,f.order(),'2026-10-14T21:13:00Z').currentMinutes,13);C.validate(f.s);
  }
 });
 test(prefix+'manual departure cannot precede an audited order or partial payment even with missing cached activity',()=>{
  const f=setup();f.run('addLine',{orderId:f.id,productId:'agnis-2810',quantity:4},'2026-10-14T21:00:00Z');
  f.run('addLine',{orderId:f.id,productId:'agnis-2810'},'2026-10-14T21:30:00Z');
  for(const dropCached of [false,true]){
   const state=structuredClone(f.s);if(dropCached)delete state.orders.find(o=>o.id===f.id).visitLastActivityAt;
   const before=structuredClone(state);assert.throws(()=>D.run(state,'endVisit',{orderId:f.id,revision:f.order().revision,endedAt:'2026-10-14T21:29:59Z'},actor,[],'2026-10-14T22:00:00Z'),/aktivit/);assert.deepEqual(state,before);
  }
  const lock=f.run('beginPayment',{orderId:f.id,revision:f.order().revision},'2026-10-14T21:40:00Z');
  f.run('checkout',{orderId:f.id,revision:f.order().revision,paymentToken:lock.token,operationId:crypto.randomUUID(),selected:[{id:f.order().lines[0].id,quantity:1}],mode:'cash',received:20000},'2026-10-14T21:40:00Z');
  const before=structuredClone(f.s);assert.throws(()=>f.run('endVisit',{orderId:f.id,revision:f.order().revision,endedAt:'2026-10-14T21:39:59Z'},'2026-10-14T22:00:00Z'),/aktivit/);assert.deepEqual(f.s,before);
  const end=f.run('endVisit',{orderId:f.id,revision:f.order().revision,endedAt:'2026-10-14T21:40:00Z'},'2026-10-14T22:00:00Z');assert.equal(end.durationMinutes,40);C.validate(f.s);
 });
 test(prefix+'manual departure uses the latest repeated visit rather than the original debt start',()=>{
  const f=setup();f.run('addLine',{orderId:f.id,productId:'agnis-2810'},'2026-10-14T21:00:00Z');
  const state=structuredClone(f.s);delete state.orders.find(o=>o.id===f.id).visitLastActivityAt;
  state.audit.push({type:'addLine',at:'2026-10-15T20:00:00Z',detail:{orderId:f.id}});
  assert.throws(()=>D.run(state,'endVisit',{orderId:f.id,revision:f.order().revision,endedAt:'2026-10-15T19:00:00Z'},actor,[],'2026-10-15T21:00:00Z'),/aktivit/);
  const out=D.run(state,'endVisit',{orderId:f.id,revision:f.order().revision,endedAt:'2026-10-15T20:15:00Z'},actor,[],'2026-10-15T21:00:00Z');
  assert.equal(out.result.durationMinutes,15);assert.equal(out.state.audit.at(-1).visits.length,2);C.validate(out.state);
 });
 test(prefix+'increasing quantity is activity; a correction downwards and a payment reservation are not',()=>{
  const f=setup();f.run('addLine',{orderId:f.id,productId:'agnis-2810'},'2026-10-14T21:00:00Z');
  f.run('setLineQuantity',{orderId:f.id,lineId:f.order().lines[0].id,quantity:3},'2026-10-14T21:30:00Z');
  assert.throws(()=>f.run('endVisit',{orderId:f.id,revision:f.order().revision,endedAt:'2026-10-14T21:29:59Z'},'2026-10-14T22:00:00Z'),/aktivit/);
  f.run('setLineQuantity',{orderId:f.id,lineId:f.order().lines[0].id,quantity:2},'2026-10-14T21:40:00Z');
  const lock=f.run('beginPayment',{orderId:f.id,revision:f.order().revision},'2026-10-14T21:50:00Z');
  f.run('cancelPayment',{orderId:f.id,paymentToken:lock.token,terminalChecked:true,reason:'TEST cancellation'},'2026-10-14T21:55:00Z');
  const state=structuredClone(f.s);delete state.orders.find(o=>o.id===f.id).visitLastActivityAt;
  const out=D.run(state,'endVisit',{orderId:f.id,revision:f.order().revision,endedAt:'2026-10-14T21:30:00Z'},actor,[],'2026-10-14T22:00:00Z');assert.equal(out.result.durationMinutes,30);C.validate(out.state);
 });
 test(prefix+'merged source history survives deletion, renamed identity and a fresh visit without duplicate sessions',()=>{
  const f=setup(),target=f.run('newOrder',{name:'TEST Payer'},'2026-10-14T20:02:00Z').id;
  f.run('addLine',{orderId:f.id,productId:'agnis-2810',quantity:2},'2026-10-14T21:00:00Z');
  const sourceVisit=f.order().visitId,customerId=f.order().customerId;
  f.run('mergeOrders',{orderId:f.id,revision:f.order().revision,targetOrderId:target,targetRevision:0},'2026-10-14T21:15:00Z');
  f.run('renameOrder',{orderId:f.id,revision:f.order().revision,name:'TEST Host Renamed'},'2026-10-14T21:20:00Z');
  f.run('deleteOrder',{orderId:f.id},'2026-10-14T21:30:00Z');
  let p=I.profile(f.s,'TEST Host Renamed',null,'2026-10-15T20:00:00Z');assert.equal(p.visitCount,1);assert.equal(p.visits[0].id,sourceVisit);assert.equal(p.totalMinutes,30);assert.equal(p.estimatedVisitCount,1);
  const id=f.run('newOrder',{name:'TEST Host Renamed'},'2026-10-15T20:00:00Z').id,order=()=>f.s.orders.find(o=>o.id===id);
  f.run('addLine',{orderId:id,productId:'agnis-2810'},'2026-10-15T20:01:00Z');assert.equal(order().customerId,customerId);assert.notEqual(order().visitId,sourceVisit);
  f.run('endVisit',{orderId:id,revision:order().revision,endedAt:'2026-10-15T20:31:00Z'},'2026-10-15T21:00:00Z');
  p=I.profile(f.s,order().name,order(),'2026-10-15T21:00:00Z');assert.equal(p.visitCount,2);assert.equal(p.totalMinutes,60);
  assert.equal(I.profile(f.s,'TEST Payer',f.s.orders.find(o=>o.id===target),'2026-10-15T21:00:00Z').visitCount,0);C.validate(f.s);
 });
 test(prefix+'old debt payments stay non-physical when departure is corrected later',()=>{
  const f=setup();f.run('addLine',{orderId:f.id,productId:'agnis-2810',quantity:3},'2026-10-14T21:00:00Z');
  f.run('endVisit',{orderId:f.id,revision:f.order().revision,endedAt:'2026-10-14T21:30:00Z'},'2026-10-14T22:00:00Z');
  const lock=f.run('beginPayment',{orderId:f.id,revision:f.order().revision},'2026-10-15T20:00:00Z');
  f.run('checkout',{orderId:f.id,revision:f.order().revision,paymentToken:lock.token,operationId:crypto.randomUUID(),selected:[{id:f.order().lines[0].id,quantity:1}],mode:'cash',received:20000},'2026-10-15T20:00:00Z');
  assert.equal(f.s.audit.at(-1).visitActivity,null);
  const end=f.run('endVisit',{orderId:f.id,revision:f.order().revision,endedAt:'2026-10-14T21:45:00Z'},'2026-10-15T21:00:00Z');
  assert.equal(end.lastActivityAt,'2026-10-14T21:00:00.000Z');assert.equal(end.durationMinutes,45);C.validate(f.s);
 });
 test(prefix+'merged mixed spend and split credit payments never become exact visitor spend per hour',()=>{
  const f=setup(),target=f.run('newOrder',{name:'TEST Credit Payer'},'2026-10-14T20:02:00Z').id,order=()=>f.s.orders.find(o=>o.id===target);
  f.run('creditTopup',{orderId:target,amount:50000,method:'cash'},'2026-10-14T20:03:00Z');
  f.run('addLine',{orderId:f.id,productId:'agnis-2810',quantity:2},'2026-10-14T21:00:00Z');
  f.run('addLine',{orderId:target,productId:'agnis-2810',quantity:2},'2026-10-14T21:10:00Z');
  const wallets=structuredClone(f.s.creditLedger),sourceCustomer=f.order().customerId,targetCustomer=order().customerId;
  f.run('mergeOrders',{orderId:f.id,revision:f.order().revision,targetOrderId:target,targetRevision:order().revision},'2026-10-14T21:15:00Z');
  assert.deepEqual(f.s.creditLedger,wallets);assert.equal(f.order().customerId,sourceCustomer);assert.equal(order().customerId,targetCustomer);
  function pay(quantity,at){const lock=f.run('beginPayment',{orderId:target,revision:order().revision},at);return f.run('checkout',{orderId:target,revision:order().revision,paymentToken:lock.token,operationId:crypto.randomUUID(),selected:[{id:order().lines[0].id,quantity}],mode:'credit',received:0},at);}
  const first=pay(1,'2026-10-14T21:20:00Z');assert.equal(first.visitEstimated,true);
  assert.throws(()=>f.run('endVisit',{orderId:target,revision:order().revision,endedAt:'2026-10-14T21:19:59Z'},'2026-10-14T21:30:00Z'),/aktivit/);
  pay(3,'2026-10-14T21:40:00Z');const p=I.profile(f.s,order().name,order(),'2026-10-14T22:00:00Z');
  assert.equal(p.spend,22000);assert.equal(p.timedSpend,0);assert.equal(p.creditBalance,28000);assert.equal(C.creditBalance(f.s,sourceCustomer),0);
  assert.equal(I.profile(f.s,f.order().name,f.order(),'2026-10-14T21:45:00Z').currentMinutes,45);C.validate(f.s);
 });
}
