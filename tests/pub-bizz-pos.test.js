const {test}=require('node:test');
const assert=require('node:assert/strict');
const C=require('../pub_bizz_pos/core.js');
function fixture(price=5500){let s=C.initial();const apply=(type,p)=>{const next=structuredClone(s);const result=C.execute(next,type,p);s=next;return result;};apply('openShift',{opening:200000,operator:'Test'});const product=apply('product',{name:'TEST nápoj',category:'Test',serving:'0,5 l',price,vatRate:21});apply('addLine',{orderId:'bar',productId:product.id});return {get s(){return s;},apply,product};}
function payload(f,overrides={}){const o=f.s.orders[0];return {operationId:crypto.randomUUID(),orderId:o.id,revision:o.revision,selected:o.lines.map(x=>({id:x.id,quantity:x.quantity})),mode:'cash',received:10000,splitCash:0,cardConfirmed:false,...overrides};}
test('parses Czech prices exactly and rejects ambiguity',()=>{assert.equal(C.money('1 234,50'),123450);for(const v of ['','-1','2.345','1e3','NaN','2 Kč'])assert.throws(()=>C.money(v));});
test('full payment removes lines and records exact cash/change',()=>{const f=fixture();const r=f.apply('checkout',payload(f));assert.equal(r.total,5500);assert.equal(r.change,4500);assert.equal(f.s.orders[0].lines.length,0);assert.equal(C.totals(f.s,r.shiftId).expected,205500);C.validate(f.s);});
test('same operation cannot create a second receipt, even after shift closing',()=>{const f=fixture(),p=payload(f),r=f.apply('checkout',p);assert.equal(f.apply('checkout',p).id,r.id);f.apply('closeShift',{counted:205500});assert.equal(f.apply('checkout',p).id,r.id);assert.equal(f.s.receipts.length,1);});
test('partial payment preserves remaining quantities and original prices',()=>{const f=fixture();f.apply('addLine',{orderId:'bar',productId:f.product.id});const p=payload(f);p.selected[0].quantity=1;f.apply('checkout',p);assert.equal(f.s.orders[0].lines[0].quantity,1);assert.equal(f.s.receipts[0].total,5500);f.apply('product',{...f.product,price:8000});assert.equal(C.sum(f.s.orders[0].lines),5500);});
test('stale payment from another window is rejected atomically',()=>{const f=fixture(),p=payload(f);f.apply('addLine',{orderId:'bar',productId:f.product.id});assert.throws(()=>f.apply('checkout',p),/změnil/);assert.equal(f.s.receipts.length,0);assert.equal(f.s.orders[0].lines[0].quantity,2);});
test('cash shortage and unconfirmed card never mark an order paid',()=>{const f=fixture();assert.throws(()=>f.apply('checkout',payload(f,{received:5000})),/nižší/);assert.throws(()=>f.apply('checkout',payload(f,{mode:'card',received:0})),/terminálu/);assert.equal(f.s.receipts.length,0);assert.equal(f.s.orders[0].lines.length,1);});
test('cash rounds once, card stays exact, split balances',()=>{assert.deepEqual(C.payment(5550,'cash',10000,0),{total:5600,cash:5600,card:0,credit:0,received:10000,change:4400,rounding:50,mode:'cash'});assert.equal(C.payment(5550,'card',0,0).card,5550);const f=fixture(5550);const r=f.apply('checkout',payload(f,{mode:'split',splitCash:3000,received:5000,cardConfirmed:true}));assert.equal(r.cash,3000);assert.equal(r.card,2550);assert.equal(r.change,2000);assert.equal(r.total,5550);});
test('duplicates and oversized selected quantities cannot overcharge',()=>{const f=fixture(),p=payload(f);p.selected.push({...p.selected[0]});assert.throws(()=>f.apply('checkout',p),/dvakrát/);p.selected=[{id:f.s.orders[0].lines[0].id,quantity:2}];assert.throws(()=>f.apply('checkout',p));assert.equal(f.s.receipts.length,0);});
test('refund preserves original and reverses only once',()=>{const f=fixture(),r=f.apply('checkout',payload(f));const refund=f.apply('refund',{receiptId:r.id,reason:'Test vratky'});assert.equal(refund.total,-5500);assert.equal(f.s.receipts[0].total,5500);assert.equal(C.totals(f.s,r.shiftId).total,0);assert.throws(()=>f.apply('refund',{receiptId:r.id,reason:'Znovu'}),/už má/);C.validate(f.s);});
test('shift close refuses unpaid tables and reconciles cash movements',()=>{const f=fixture();assert.throws(()=>f.apply('closeShift',{counted:200000}),/doplať/);f.apply('checkout',payload(f));f.apply('cashMovement',{amount:-10000,reason:'Výběr'});const closed=f.apply('closeShift',{counted:195400});assert.equal(closed.difference,-100);assert.equal(closed.summary.expected,195500);assert.throws(()=>f.apply('addLine',{orderId:'bar',productId:f.product.id}),/otevři/);C.validate(f.s);});
test('unknown prices and missing configured VAT cannot be sold',()=>{const f=fixture();f.s.products[0].price=null;assert.throws(()=>f.apply('addLine',{orderId:'bar',productId:f.s.products[0].id}),/cenu/);f.apply('settings',{...f.s.settings,vat:'payer'});const p=f.apply('product',{name:'Bez sazby',price:10000,vatRate:null});assert.throws(()=>f.apply('addLine',{orderId:'bar',productId:p.id}),/sazbu/);});
test('invalid bulk import rolls back the complete operation',()=>{const f=fixture();const before=JSON.stringify(f.s);assert.throws(()=>f.apply('importProducts',{items:[{name:'Valid',price:5500,vatRate:null},{name:'Invalid',price:-1,vatRate:null}]}));assert.equal(JSON.stringify(f.s),before);});
test('corrupted backup totals are rejected',()=>{const f=fixture();f.apply('checkout',payload(f));const copy=structuredClone(f.s);copy.receipts[0].total++;assert.throws(()=>C.validate(copy),/součet/);});

test("provided catalog keeps only 208 priced IDs and agreed Cuba price",()=>{const s=C.initial();assert.equal(s.products.length,208);assert.equal(s.products.filter(p=>p.price===null).length,0);assert.equal(new Set(s.products.map(p=>p.id)).size,208);for(const id of ["agnis-4328","agnis-4336"])assert.equal(s.products.find(p=>p.id===id).price,13000);assert.equal(s.products.find(p=>p.id==="agnis-63").price,4200);assert.equal(s.products.find(p=>p.id==="agnis-6301"),undefined);});


test('multiple pieces are added in one atomic command, with default single-piece compatibility',()=>{
 const f=fixture(),revision=f.s.revision,audit=f.s.audit.length;
 f.apply('addLine',{orderId:'bar',productId:f.product.id,quantity:5});
 assert.equal(f.s.orders[0].lines[0].quantity,6);
 assert.equal(C.sum(f.s.orders[0].lines),33000);
 assert.equal(f.s.revision,revision+1);assert.equal(f.s.audit.length,audit+1);
 f.apply('addLine',{orderId:'bar',productId:f.product.id});assert.equal(f.s.orders[0].lines[0].quantity,7);
 C.validate(f.s);
});
test('invalid counts and accumulated limits do not change the order',()=>{
 const f=fixture();
 for(const quantity of [0,-1,1.5,1000,null,'5',NaN]){
  const before=JSON.stringify(f.s);assert.throws(()=>f.apply('addLine',{orderId:'bar',productId:f.product.id,quantity}));assert.equal(JSON.stringify(f.s),before);
 }
 f.apply('addLine',{orderId:'bar',productId:f.product.id,quantity:998});
 const before=JSON.stringify(f.s);assert.throws(()=>f.apply('addLine',{orderId:'bar',productId:f.product.id,quantity:1}),/999/);assert.equal(JSON.stringify(f.s),before);
});

test('named customer visit spans split payments and ends only after the final payment',()=>{
  let s=C.initial();
  const apply=(type,p,now)=>{const next=structuredClone(s);const result=C.execute(next,type,p,now);s=next;return result;};
  apply('openShift',{opening:0,operator:'Test'},'2026-10-14T18:00:00.000Z');
  const product=apply('product',{name:'Pivo',category:'Pivo',serving:'0,5 l',price:5000,vatRate:null},'2026-10-14T18:01:00.000Z');
  const customer=apply('newOrder',{name:'Petr'},'2026-10-14T18:02:00.000Z');
  apply('addLine',{orderId:customer.id,productId:product.id,quantity:2},'2026-10-14T19:00:00.000Z');
  const order=()=>s.orders.find(x=>x.id===customer.id);
  const firstLine=()=>order().lines[0];
  const first=apply('checkout',{operationId:crypto.randomUUID(),orderId:customer.id,revision:order().revision,selected:[{id:firstLine().id,quantity:1}],mode:'cash',received:5000,splitCash:0,cardConfirmed:false},'2026-10-14T20:00:00.000Z');
  assert.equal(first.visitStartedAt,'2026-10-14T19:00:00.000Z');assert.equal(first.visitEndedAt,undefined);assert.equal(order().lines.length,1);
  const second=apply('checkout',{operationId:crypto.randomUUID(),orderId:customer.id,revision:order().revision,selected:[{id:firstLine().id,quantity:1}],mode:'cash',received:5000,splitCash:0,cardConfirmed:false},'2026-10-14T21:30:00.000Z');
  assert.equal(second.visitId,first.visitId);assert.equal(second.visitDurationMinutes,150);assert.equal(second.visitEndedAt,'2026-10-14T21:30:00.000Z');
  assert.equal(order().visitId,undefined);assert.equal(order().visitStartedAt,undefined);C.validate(s);
});

test('credit is a separate exact payment method and settlement column',()=>{
 const s=C.initial();s.shifts.push({id:'shift-credit',openedAt:'2026-10-15T00:00:00Z',closedAt:null,opening:10000,operator:'Test',movements:[]});
 s.receipts.push({id:'sale-credit',kind:'sale',shiftId:'shift-credit',total:5550,cash:0,card:0,credit:5550,rounding:0,lines:[{id:'l',name:'Drink',price:5550,quantity:1}],settings:{venue:'Test'}});
 s.creditLedger.push({id:'topup-cash',type:'topup',customerId:'c1',amount:10000,method:'cash',shiftId:'shift-credit',at:'2026-10-15T00:01:00Z'});
 s.creditLedger.push({id:'topup-card',type:'topup',customerId:'c1',amount:20000,method:'card',shiftId:'shift-credit',at:'2026-10-15T00:02:00Z'});
 s.customers.push({id:'c1',name:'Petr',aliases:['Petr'],createdAt:'2026-10-15T00:00:00Z'});
 const p=C.payment(5550,'credit',0,0);assert.equal(p.credit,5550);assert.equal(p.cash,0);assert.equal(p.card,0);assert.equal(p.rounding,0);
 const t=C.totals(s,'shift-credit');assert.equal(t.total,5550);assert.equal(t.credit,5550);assert.equal(t.creditTopupCash,10000);assert.equal(t.creditTopupCard,20000);assert.equal(t.expected,20000);assert.equal(t.terminal,20000);
 C.validate(s);
});
