const {test}=require('node:test');
const assert=require('node:assert/strict');
const I=require('../pub_bizz_pos/customer.js');
const staff={id:crypto.randomUUID(),role:'staff'};
for(const base of ['../pub_bizz_pos/','../supabase/functions/pub-bizz-pos/']){
  const C=require(base+'core.js'),D=require(base+'server-domain.js');
  function fixture(){
    let s=C.initial();
    const run=(type,p,now)=>{const n=D.run(s,type,p,staff,[],now);s=n.state;return n.result;};
    run('openShift',{opening:0});
    const id=run('newOrder',{name:'Petr'}).id;
    run('newOrder',{name:'Stůl 2'});
    run('addLine',{orderId:id,productId:'agnis-2810',quantity:3},'2026-10-14T20:00:00Z');
    const order=()=>s.orders.find(o=>o.id===id);
    const lock=run('beginPayment',{orderId:id,revision:order().revision});
    run('checkout',{orderId:id,revision:order().revision,paymentToken:lock.token,operationId:crypto.randomUUID(),selected:[{id:order().lines[0].id,quantity:1}],mode:'cash',received:10000},'2026-10-14T21:00:00Z');
    return {get s(){return s;},run,order,id,payload:()=>({orderId:id,revision:order().revision,name:'Petr Král'})};
  }
  test(base+'staff rename preserves partial payment, visit, lines, receipts and customer points',()=>{
    const f=fixture(),before=structuredClone(f.s),old=structuredClone(f.order()),p=I.profile(f.s,'Petr',f.order(),'2026-10-14T21:30:00Z');
    const result=f.run('renameOrder',{...f.payload(),name:'  Petr Král  '});
    assert.deepEqual(f.order(),{...old,name:'Petr Král',revision:old.revision+1});
    for(const key of ['receipts','receiptAssignments','shifts','sequence','products','loyalty'])assert.deepEqual(f.s[key],before[key]);
    assert.equal(result.previousName,'Petr');assert.equal(result.orderId,f.id);
    assert.deepEqual(f.s.audit.at(-1).rename,result);assert.equal(f.s.audit.at(-1).actorId,staff.id);
    const after=I.profile(f.s,'Petr Král',f.order(),'2026-10-14T21:30:00Z');
    for(const key of ['spend','points','items','currentMinutes','receiptCount'])assert.deepEqual(after[key],p[key]);
    assert.equal(I.profile(f.s,'Petr').spend,0);C.validate(f.s);
    const lock=f.run('beginPayment',{orderId:f.id,revision:f.order().revision});
    const sale=f.run('checkout',{orderId:f.id,revision:f.order().revision,paymentToken:lock.token,operationId:crypto.randomUUID(),selected:f.order().lines.map(l=>({id:l.id,quantity:l.quantity})),mode:'cash',received:20000},'2026-10-14T22:00:00Z');
    assert.equal(sale.orderName,'Petr Král');assert.equal(sale.visitDurationMinutes,120);
    f.run('renameOrder',{...f.payload(),name:'Petr K.'});
    const profile=I.profile(f.s,'Petr K.');assert.equal(profile.receiptCount,2);assert.equal(profile.totalMinutes,120);assert.equal(profile.timedSpend,profile.spend);
  });
  test(base+'invalid names, quick sale, reserved payment and stale revision leave every field intact',()=>{
    const f=fixture();
    for(const patch of [{name:''},{name:'   '},{name:'x'.repeat(121)},{name:123},{name:'sTůL 2'},{name:'rychlý prodej'},{revision:-1},{revision:undefined},{orderId:'bar',revision:0},{orderId:'missing'}]){
      const before=structuredClone(f.s);assert.throws(()=>f.run('renameOrder',{...f.payload(),...patch}));assert.deepEqual(f.s,before);
    }
    const stale=f.payload();f.run('addLine',{orderId:f.id,productId:'agnis-2810'});
    assert.throws(()=>f.run('renameOrder',stale),/změnil/);
    f.run('beginPayment',{orderId:f.id,revision:f.order().revision});
    const before=structuredClone(f.s);assert.throws(()=>f.run('renameOrder',f.payload()),/platbu/);assert.deepEqual(f.s,before);
    assert.throws(()=>D.run(f.s,'renameOrder',f.payload(),{id:staff.id,role:'accountant'},[]),/oprávnění/);
  });
  test(base+'empty named account can be renamed before opening a shift',()=>{
    const s=C.initial(),o=C.execute(s,'newOrder',{name:'Stůl 7'});
    C.execute(s,'renameOrder',{orderId:o.id,revision:0,name:'Stůl 8'});
    assert.equal(o.name,'Stůl 8');assert.equal(s.orders.length,2);
  });
}
