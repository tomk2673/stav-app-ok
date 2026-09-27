const {test}=require('node:test');
const assert=require('node:assert/strict');
const C=require('../pub_bizz_pos/core.js');
const D=require('../pub_bizz_pos/server-domain.js');
const staff={id:crypto.randomUUID(),role:'staff'};
function fixture(){
  let s=C.initial();
  const run=(type,p)=>{const next=D.run(s,type,p,staff,[]);s=next.state;return next.result;};
  run('openShift',{opening:0});
  const source=run('newOrder',{name:'Stůl 1'}).id,target=run('newOrder',{name:'Petr'}).id;
  run('addLine',{orderId:source,productId:'agnis-2810'});
  run('addLine',{orderId:target,productId:'agnis-2810'});
  const order=id=>s.orders.find(o=>o.id===id);
  const payload=()=>({orderId:source,revision:order(source).revision,targetOrderId:target,targetRevision:order(target).revision});
  return {get s(){return s;},run,order,payload,source,target};
}
test('staff merges into the selected account, conserves value, leaves source reusable and records audit',()=>{
  const f=fixture(),p=f.payload(),before=structuredClone(f.s),expected=C.sum(f.order(f.source).lines)+C.sum(f.order(f.target).lines);
  const result=f.run('mergeOrders',p);
  assert.equal(result.orderId,f.target);assert.equal(result.sourceOrderId,f.source);assert.equal(result.total,expected);
  assert.equal(f.order(f.source).lines.length,0);assert.equal(f.order(f.source).revision,p.revision+1);
  assert.equal(f.order(f.target).lines.length,1);assert.equal(f.order(f.target).lines[0].quantity,2);
  assert.equal(f.order(f.target).revision,p.targetRevision+1);assert.equal(C.sum(f.order(f.target).lines),expected);
  assert.deepEqual(f.s.receipts,before.receipts);assert.deepEqual(f.s.shifts,before.shifts);
  assert.equal(f.s.sequence,before.sequence);assert.equal(f.s.audit.at(-1).actorId,staff.id);
  assert.deepEqual(f.s.audit.at(-1).merge,result);C.validate(f.s);
  f.run('addLine',{orderId:f.source,productId:'agnis-2810'});
  const after=structuredClone(f.s);
  assert.throws(()=>f.run('mergeOrders',p),/změnil/);assert.deepEqual(f.s,after);
});
test('merging preserves different prices, VAT, names, servings and stock references',()=>{
  for(const patch of [{price:1234},{vatRate:21},{name:'Jiný název'},{serving:'jiná porce'},{stockProductId:'another-stock'},{sourceCode:'other-code'}]){
    const f=fixture();Object.assign(f.order(f.source).lines[0],patch);
    const original=structuredClone(f.order(f.source).lines[0]),expected=C.sum(f.order(f.source).lines)+C.sum(f.order(f.target).lines);
    f.run('mergeOrders',f.payload());
    assert.equal(f.order(f.target).lines.length,2);assert.deepEqual(f.order(f.target).lines[1],original);
    assert.equal(C.sum(f.order(f.target).lines),expected);C.validate(f.s);
  }
});
test('both payment reservations and stale revisions reject a merge without changing either account',()=>{
  for(const which of ['source','target']){
    const f=fixture(),p=f.payload();f.run('beginPayment',{orderId:f[which],revision:f.order(f[which]).revision});
    const before=structuredClone(f.s);assert.throws(()=>f.run('mergeOrders',p),/platba/);assert.deepEqual(f.s,before);
    const g=fixture(),q=g.payload();g.run('addLine',{orderId:g[which],productId:'agnis-2810'});
    const changed=structuredClone(g.s);assert.throws(()=>g.run('mergeOrders',q),/změnil/);assert.deepEqual(g.s,changed);
  }
});
test('self, missing, empty, closed-shift and oversized merges are rejected',()=>{
  const f=fixture();
  for(const patch of [{targetOrderId:f.source},{targetOrderId:'missing'},{orderId:'missing'},{revision:undefined},{targetRevision:undefined}]){
    const before=structuredClone(f.s);assert.throws(()=>f.run('mergeOrders',{...f.payload(),...patch}));assert.deepEqual(f.s,before);
  }
  f.order(f.source).lines=[];assert.throws(()=>f.run('mergeOrders',f.payload()),/prázdný/);
  const g=fixture();g.s.shifts[0].closedAt=new Date().toISOString();assert.throws(()=>g.run('mergeOrders',g.payload()),/směnu/);
  const h=fixture();h.order(h.source).lines[0].price=60000000;h.order(h.target).lines[0].price=60000000;
  const before=structuredClone(h.s);assert.throws(()=>h.run('mergeOrders',h.payload()),/limit/);assert.deepEqual(h.s,before);
});
test('large quantities stay on separate valid lines, with unique IDs for later checkout',()=>{
  const f=fixture();f.order(f.source).lines[0].quantity=600;f.order(f.target).lines[0].quantity=600;
  f.order(f.source).lines[0].id=f.order(f.target).lines[0].id;
  const expected=C.sum(f.order(f.source).lines)+C.sum(f.order(f.target).lines);
  f.run('mergeOrders',f.payload());const o=f.order(f.target);
  assert.equal(o.lines.length,2);assert.equal(new Set(o.lines.map(l=>l.id)).size,2);assert.equal(C.sum(o.lines),expected);C.validate(f.s);
  const lock=f.run('beginPayment',{orderId:o.id,revision:o.revision});
  const receipt=f.run('checkout',{orderId:o.id,revision:o.revision,paymentToken:lock.token,operationId:crypto.randomUUID(),selected:o.lines.map(l=>({id:l.id,quantity:l.quantity})),mode:'card',received:0,splitCash:0,cardConfirmed:true});
  assert.equal(receipt.total,expected);assert.equal(receipt.lines.reduce((n,l)=>n+l.quantity,0),1200);C.validate(f.s);
});
test('quick sale stays present, empty targets work and read-only users cannot merge',()=>{
  const f=fixture(),p={...f.payload(),targetOrderId:'bar',targetRevision:0};
  assert.throws(()=>D.run(f.s,'mergeOrders',p,{...staff,role:'accountant'},[]),/oprávnění/);
  f.run('mergeOrders',p);assert.equal(f.order('bar').lines.length,1);
  f.run('mergeOrders',{orderId:'bar',revision:f.order('bar').revision,targetOrderId:f.target,targetRevision:f.order(f.target).revision});
  assert.equal(f.order('bar').lines.length,0);assert.equal(f.order(f.target).lines[0].quantity,2);C.validate(f.s);
});
