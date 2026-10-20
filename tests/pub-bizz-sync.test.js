'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const C=require('../pub_bizz_pos/core.js'),S=require('../pub_bizz_pos/sync.js');
function seed(){const s=C.initial();C.execute(s,'openShift',{opening:0});return s;}
test('same revision sends no history; changed revision reconstructs the exact authoritative state',()=>{
 const base=seed(),c=S.cursor(base);assert.equal(S.encode(base,c).unchanged,true);assert.equal(S.decode(base,S.encode(base,c)),base);
 const next=structuredClone(base);C.execute(next,'addLine',{orderId:'bar',productId:'agnis-2810',quantity:3});
 const packet=S.encode(next,c);assert.equal(packet.delta.state.audit.length,1);assert.deepEqual(S.decode(base,packet),next);
});
test('out-of-order deltas rebase onto the immutable prefix without duplicating or losing events',()=>{
 const base=seed(),a=structuredClone(base);C.execute(a,'addLine',{orderId:'bar',productId:'agnis-2810'});
 const b=structuredClone(a);C.execute(b,'addLine',{orderId:'bar',productId:'agnis-2810'});
 assert.deepEqual(S.decode(a,S.encode(b,S.cursor(base))),b);assert.equal(S.decode(b,S.encode(a,S.cursor(base))),b);
});
test('partial payment, refund, assignment and account changes preserve every history row and total',()=>{
 const base=seed(),s=structuredClone(base);C.execute(s,'addLine',{orderId:'bar',productId:'agnis-2810',quantity:3});
 const o=s.orders[0];const sale=C.execute(s,'checkout',{orderId:'bar',revision:o.revision,operationId:crypto.randomUUID(),selected:[{id:o.lines[0].id,quantity:1}],mode:'cash',received:10000,splitCash:0});
 const paid=structuredClone(s);C.execute(s,'refund',{receiptId:sale.id,reason:'TEST'});C.execute(s,'newOrder',{name:'TEST target'});
 assert.deepEqual(S.decode(base,S.encode(s,S.cursor(base))),s);assert.deepEqual(S.decode(paid,S.encode(s,S.cursor(paid))),s);assert.equal(s.receipts[0].kind,'sale');
});
test('unknown, invalid or other-venue cursors fall back to a full authorized snapshot',()=>{
 const s=seed();for(const c of [null,{}, {...S.cursor(s),venueId:crypto.randomUUID()}, {...S.cursor(s),audits:999999},{...S.cursor(s),auditTail:'wrong'}])assert.deepEqual(S.encode(s,c),{state:s});
 assert.throws(()=>S.decode(null,S.encode(s,S.cursor(s))),/základ|obnovení/);
});
test('mismatched prefixes and truncated history never become an accepted register',()=>{
 const base=seed(),next=structuredClone(base);C.execute(next,'addLine',{orderId:'bar',productId:'agnis-2810'});
 const wrong=structuredClone(base);wrong.audit[0].id=crypto.randomUUID();assert.throws(()=>S.decode(wrong,S.encode(next,S.cursor(base))),/Historie/);
 const packet=S.encode(next,S.cursor(base));packet.delta.state.audit=[];assert.throws(()=>S.decode(base,packet),/úplný/);
});
test('large histories use small incremental responses and constant-size idle polling',()=>{
 const base=seed();for(let i=0;i<6000;i++){base.audit.push({id:crypto.randomUUID(),type:'backup',detail:{test:'x'.repeat(450)}});base.revision++;}
 const next=structuredClone(base);C.execute(next,'addLine',{orderId:'bar',productId:'agnis-2810'});
 const full=JSON.stringify(next).length,delta=JSON.stringify(S.encode(next,S.cursor(base))).length,idle=JSON.stringify(S.encode(next,S.cursor(next))).length;
 assert.ok(delta<full/20);assert.ok(idle<500);assert.deepEqual(S.decode(base,S.encode(next,S.cursor(base))),next);
});
