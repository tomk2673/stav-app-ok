const {test}=require('node:test');
const assert=require('node:assert/strict');
const I=require('../pub_bizz_pos/customer.js');
for(const prefix of ['../pub_bizz_pos/','../supabase/functions/pub-bizz-pos/']){
 const C=require(prefix+'core.js'),D=require(prefix+'server-domain.js'),actor={id:crypto.randomUUID(),role:'staff'};
 function setup(){let s=C.initial();const run=(type,p,at)=>{const out=D.run(s,type,p,actor,[],at);s=out.state;return out.result;};run('openShift',{opening:0},'2026-10-14T20:00:00Z');const id=run('newOrder',{name:'Lukas Novobilsky'},'2026-10-14T20:01:00Z').id;return {get s(){return s;},run,id,order:()=>s.orders.find(o=>o.id===id)};}
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
}
