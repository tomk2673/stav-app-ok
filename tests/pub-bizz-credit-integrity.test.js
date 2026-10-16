'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict');
const I=require('../pub_bizz_pos/customer.js');
for(const base of ['../pub_bizz_pos/','../supabase/functions/pub-bizz-pos/'])for(const shared of [false,true]){
 const C=require(base+'core.js'),D=require(base+'server-domain.js'),label=base+(shared?'server':'local');
 function fixture(){
  let s=C.initial();s.recipes={};const actor={id:crypto.randomUUID(),role:'owner'};
  const run=(type,p={},role='owner')=>{
   if(shared&&type==='creditTopup'&&p.method==='card'&&p.cardConfirmed===true&&!s.orders.find(o=>o.id===p.orderId)?.paymentLock){const o=s.orders.find(o=>o.id===p.orderId),lock=run('beginPayment',{orderId:o.id,revision:o.revision,purpose:'creditTopup',amount:p.amount},role);p={...p,paymentToken:lock.token};}
   if(shared){const result=D.run(s,type,p,{...actor,role},[],'2026-10-16T03:00:00Z');s=result.state;return result.result;}
   const next=structuredClone(s),result=C.execute(next,type,p,'2026-10-16T03:00:00Z',undefined,actor.id);C.validate(next);s=next;return result;
  };
  run('openShift',{opening:10000});const id=run('newOrder',{name:'Test Petr'}).id;
  const order=()=>s.orders.find(o=>o.id===id);
  const pay=(quantity,mode='credit',orderId=id)=>{
   const o=s.orders.find(o=>o.id===orderId),lock=shared?run('beginPayment',{orderId,revision:o.revision}):null;
   return run('checkout',{orderId,revision:o.revision,paymentToken:lock?.token,operationId:crypto.randomUUID(),selected:[{id:o.lines[0].id,quantity}],mode,received:100000,splitCash:0,cardConfirmed:true});
  };
  return {get s(){return s;},run,id,order,pay};
 }
 test(label+': credited identity and aliases survive rename, deletion and recreation without merging wallets',()=>{
  const f=fixture();f.run('creditTopup',{orderId:f.id,amount:50000,method:'cash'});const cid=f.order().customerId;
  f.run('renameOrder',{orderId:f.id,revision:f.order().revision,name:'Test Petr Král'});
  assert.equal(f.s.customers.find(x=>x.id===cid).name,'Test Petr Král');
  assert.deepEqual(f.s.customers.find(x=>x.id===cid).aliases,['Test Petr','Test Petr Král']);
  f.run('deleteOrder',{orderId:f.id});const recreated=f.run('newOrder',{name:'Test Petr Král'});
  assert.equal(recreated.customerId,cid);assert.equal(C.creditBalance(f.s,recreated.customerId),50000);
  const other=f.run('newOrder',{name:'Test Jana'}),before=structuredClone(f.s);
  assert.throws(()=>f.run('renameOrder',{orderId:other.id,revision:other.revision,name:'Test Petr'}),/jinému zákazníkovi/);assert.deepEqual(f.s,before);
  assert.throws(()=>f.run('newOrder',{name:'Test Petr'}),/otevřený účet/);assert.deepEqual(f.s,before);
 });
 test(label+': explicit receipt assignment moves spend, points and favorites exactly once and keeps refund on original wallet',()=>{
  const f=fixture();f.run('creditTopup',{orderId:f.id,amount:50000,method:'cash'});
  f.run('addLine',{orderId:f.id,productId:'agnis-2810',quantity:2,servingMl:20});const sale=f.pay(2),cid=f.order().customerId;
  const other=f.run('newOrder',{name:'Test Jana'}),table=f.run('newOrder',{name:'Stůl 9'});
  f.run('reassignReceipt',{receiptId:sale.id,previousOrderId:f.id,targetOrderId:other.id,reason:'TEST correction'});
  assert.equal(I.profile(f.s,f.order().name,f.order()).spend,0);assert.equal(I.profile(f.s,other.name,other).spend,sale.total);
  assert.equal(I.productCounts(f.s,other.name,other.customerId,other.id).get('agnis-2810'),2);
  assert.equal(I.leaderboard(f.s).reduce((n,x)=>n+x.spend,0),sale.total);
  f.run('reassignReceipt',{receiptId:sale.id,previousOrderId:other.id,targetOrderId:table.id,reason:'TEST table'});
  assert.equal(I.profile(f.s,other.name,other).spend,0);assert.equal(I.profile(f.s,f.order().name,f.order()).spend,0);
  f.run('refund',{receiptId:sale.id,reason:'TEST refund'});assert.equal(C.creditBalance(f.s,cid),50000);assert.equal(C.creditBalance(f.s,other.customerId),0);
 });
 test(label+': all payment reservations block closing, including a named or empty account',()=>{
  const f=fixture();f.run('addLine',{orderId:f.id,productId:'agnis-2810'});
  if(shared)f.run('beginPayment',{orderId:f.id,revision:f.order().revision});else f.order().paymentLock={token:crypto.randomUUID()};
  const before=structuredClone(f.s);assert.throws(()=>f.run('closeShift',{counted:10000}),/rozpracované platby/);assert.deepEqual(f.s,before);
  f.order().lines=[];assert.throws(()=>f.run('closeShift',{counted:10000}),/rozpracované platby/);
 });
 test(label+': carried portions freeze one physical issue across repeated closes, splits, merges and restoration',()=>{
  const f=fixture(),ingredient=crypto.randomUUID();f.s.recipes['agnis-2810']={version:1,mode:'recipe',components:[{productId:ingredient,quantity:40,unit:'ml'}]};
  f.run('addLine',{orderId:f.id,productId:'agnis-2810',quantity:3,servingMl:20});
  const visit=f.order().visitId,closed=f.run('closeShift',{counted:10000});assert.equal(closed.summary.total,0);assert.equal(f.s.receipts.length,0);
  assert.equal(f.s.stockIssues.length,1);const issue=f.s.stockIssues[0];assert.equal(issue.lines[0].stockRecipe.components[0].quantity,20);assert.equal(f.order().visitId,visit);
  f.run('openShift',{opening:0});f.run('creditTopup',{orderId:f.id,amount:50000,method:'cash'});const sale=f.pay(1);
  assert.deepEqual(sale.lines[0].stockIssue,{id:issue.id,offset:0});assert.deepEqual(f.order().lines[0].stockIssue,{id:issue.id,offset:1});
  f.run('restoreReceipt',{receiptId:sale.id,reason:'TEST accidental payment'});
  assert.equal(f.order().lines.reduce((n,l)=>n+l.quantity,0),3);assert.equal(f.s.stockIssues.length,1);
  assert.throws(()=>f.run('removeLine',{orderId:f.id,lineId:f.order().lines[0].id,reason:'TEST'}),/vydaná/);
  f.run('closeShift',{counted:50000});assert.equal(f.s.stockIssues.length,1,'second close cannot issue the same drinks again');
  f.run('openShift',{opening:0});f.run('addLine',{orderId:f.id,productId:'agnis-2810',quantity:1,servingMl:20});assert.equal(f.order().lines.filter(l=>!l.stockIssue).length,1);
  f.run('closeShift',{counted:0});assert.equal(f.s.stockIssues.length,2,'only the new portion gets a new issue');C.validate(f.s);
 });
 for(const method of ['cash','card'])test(label+': '+method+' erroneous topup reverses once with audit, no sale or stock, and correct drawer/terminal totals',()=>{
  const f=fixture(),entry=f.run('creditTopup',{orderId:f.id,amount:50000,method,cardConfirmed:true}),before=structuredClone(f.s);
  if(shared)assert.throws(()=>f.run('creditReverse',{entryId:entry.id,reason:'TEST'},'staff'),/vedoucí/);
  if(method==='card'){assert.throws(()=>f.run('creditReverse',{entryId:entry.id,reason:'TEST',cardConfirmed:'true',terminalReference:'TEST'}),/Potvrď/);assert.deepEqual(f.s,before);}
  const r=f.run('creditReverse',{entryId:entry.id,reason:'TEST wrong customer',cardConfirmed:true,terminalReference:'TEST-REFUND'});
  assert.equal(r.amount,-50000);assert.equal(r.reversalOf,entry.id);assert.equal(C.creditBalance(f.s,entry.customerId),0);
  for(const key of ['receipts','orders','stockIssues','sequence'])assert.deepEqual(f.s[key],before[key]);
  assert.equal(f.s.audit.at(-1).type,'creditReverse');assert.equal(C.totals(f.s,C.activeShift(f.s).id).expected,10000);assert.equal(C.totals(f.s,C.activeShift(f.s).id).terminal,0);
  const after=structuredClone(f.s);assert.throws(()=>f.run('creditReverse',{entryId:entry.id,reason:'TEST duplicate',cardConfirmed:true,terminalReference:'TEST'}),/stornované/);assert.deepEqual(f.s,after);
 });
 test(label+': a spent topup cannot be reversed into a negative wallet; later-shift reversal belongs to the current shift',()=>{
  const f=fixture(),entry=f.run('creditTopup',{orderId:f.id,amount:10000,method:'cash'});f.run('addLine',{orderId:f.id,productId:'agnis-2810'});const sale=f.pay(1),before=structuredClone(f.s);
  assert.throws(()=>f.run('creditReverse',{entryId:entry.id,reason:'TEST'}),/čerpán/);assert.deepEqual(f.s,before);
  f.run('refund',{receiptId:sale.id,reason:'TEST refund'});f.run('closeShift',{counted:20000});f.run('openShift',{opening:20000});f.run('creditReverse',{entryId:entry.id,reason:'TEST old deposit'});
  const totals=C.totals(f.s,C.activeShift(f.s).id);assert.equal(totals.creditTopupCash,-10000);assert.equal(totals.total,0);assert.equal(totals.expected,10000);
 });
 if(shared)test(label+': an empty-wallet card reservation blocks closure and cannot fund a different amount or pay a sale',()=>{
  const f=fixture(),lock=f.run('beginPayment',{orderId:f.id,revision:f.order().revision,purpose:'creditTopup',amount:50000}),before=structuredClone(f.s);
  assert.throws(()=>f.run('closeShift',{counted:10000}),/rozpracované platby/);
  assert.throws(()=>f.run('creditTopup',{orderId:f.id,amount:60000,method:'card',cardConfirmed:true,paymentToken:lock.token}),/připravenou platbou/);
  assert.throws(()=>f.run('checkout',{orderId:f.id,paymentToken:lock.token}),/dobití/);assert.deepEqual(f.s,before);
  f.run('creditTopup',{orderId:f.id,amount:50000,method:'card',cardConfirmed:true,paymentToken:lock.token});assert.equal(f.order().paymentLock,undefined);assert.equal(C.creditBalance(f.s,f.order().customerId),50000);assert.equal(f.s.receipts.length,0);
 });
}
