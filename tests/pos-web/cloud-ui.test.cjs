const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const {JSDOM}=require('jsdom');
const C=require('../../pub_bizz_pos/core.js');
const D=require('../../pub_bizz_pos/server-domain.js');
const root=path.resolve(__dirname,'../../pub_bizz_pos');
const pause=ms=>new Promise(r=>setTimeout(r,ms));
async function until(predicate,label){for(let i=0;i<200;i++){if(predicate())return;await pause(10);}throw new Error('Timed out: '+label);}
async function harness(seed=state=>state){
  const html=fs.readFileSync(path.join(root,'index.html'),'utf8');
  const dom=new JSDOM(html,{url:'https://pos.test/pub_bizz_pos/index.html',runScripts:'outside-only',pretendToBeVisual:true});
  const w=dom.window,venue={id:crypto.randomUUID(),organization_id:crypto.randomUUID(),name:'Test venue',currency:'CZK',role:'owner'},user={id:crypto.randomUUID(),email:'owner@example.test'};
  let server=C.initial();server.venueId=venue.id;server.recipes={};server=seed(server);
  const requests=new Map(),calls=[];let dropNext=false;
  w.structuredClone=structuredClone;w.TextEncoder=TextEncoder;
  w.HTMLDialogElement.prototype.showModal=function(){this.setAttribute('open','');};
  w.HTMLDialogElement.prototype.close=function(){this.removeAttribute('open');this.dispatchEvent(new w.Event('close'));};
  w.HTMLElement.prototype.scrollIntoView=function(){};w.print=()=>{};
  w.supabase={createClient:()=>({auth:{getSession:async()=>({data:{session:{access_token:'test-only'}}}),refreshSession:async()=>({data:{session:{access_token:'test-only'}}}),signOut:async()=>({})},channel:()=>({subscribe:()=>({})})})};
  const envelope=result=>({state:structuredClone(server),result:structuredClone(result),stock:[],issues:[],issueCount:0,role:'owner',venue});
  w.fetch=async(url,init)=>{
   let data,status=200;
   if(init.method==='GET') data=url.includes('venueId=')?envelope(null):{venues:[venue],user};
   else {
    const r=JSON.parse(init.body);calls.push(r);
    if(requests.has(r.requestId))data=envelope(requests.get(r.requestId));
    else {try {const p={...r.payload};if(r.type==='checkout')p.operationId=r.requestId;const next=D.run(server,r.type,p,{id:user.id,role:'owner'},[]);server=next.state;requests.set(r.requestId,next.result);data=envelope(next.result);} catch(e) {status=422;data={error:e.message,definitive:true};} }
    if(dropNext){dropNext=false;throw new TypeError('Simulated lost response after successful commit');}
   }
   return {ok:status===200,status,json:async()=>data};
  };
  for(const name of ['catalog.js','core.js','storage.js','config.js','cloud.js','stock.js','app.js'])w.eval(fs.readFileSync(path.join(root,name),'utf8'));
  await until(()=>w.document.querySelector('.product'),'register open');
  const click=selector=>{const el=w.document.querySelector(selector);assert.ok(el,'Missing '+selector);el.click();};
  const submit=()=>w.document.querySelector('#dialog-form').dispatchEvent(new w.Event('submit',{bubbles:true,cancelable:true}));
  return {dom,w,click,submit,get server(){return server;},calls,drop(){dropNext=true;},external(type,payload){server=D.run(server,type,payload,{id:user.id,role:'owner'},[]).state;}};
}
test('online UI survives a lost response without adding an item twice and completes a reserved payment',{concurrency:false},async()=>{
  const h=await harness();try {
   h.click('[data-action="openShift"]');
   h.w.document.querySelector('[name="opening"]').value='0';h.submit();
   await until(()=>h.server.shifts.length===1&&!h.w.document.querySelector('#dialog').open,'shift opened');
   h.click('.product[data-action="add"]');
   await until(()=>h.w.document.querySelector('.quantity-tap')?.textContent.replace('×','')==='1','first line');
   h.drop();h.click('.product[data-action="add"]');
   await until(()=>h.w.POSCloud.pending&&!h.w.POSCloud.busy,'uncertain operation retained');
   assert.equal(h.server.orders[0].lines[0].quantity,2);
   assert.equal(h.w.document.querySelector('#sync-warning').hidden,false);
   h.click('[data-action="retryPending"]');
   await until(()=>!h.w.POSCloud.pending&&h.w.document.querySelector('.quantity-tap')?.textContent.replace('×','')==='2','same operation recovered');
   assert.equal(h.server.orders[0].lines[0].quantity,2);
   const additions=h.calls.filter(x=>x.type==='addLine');assert.equal(additions[1].requestId,additions[2].requestId);
   h.click('[data-action="payCash"]');
   await until(()=>h.w.document.querySelector('[name="received"]'),'payment dialog');
   assert.ok(h.server.orders[0].paymentLock,'reserved before terminal/cash prompt');
   h.submit();await until(()=>h.server.receipts.length===1&&!h.server.orders[0].lines.length,'paid');
   assert.equal(h.w.document.querySelector('#dialog').open,false);
   assert.match(h.w.document.querySelector('#toast').textContent,/Zaplaceno/);
   assert.equal(h.server.orders[0].paymentLock,undefined);
   assert.match(h.w.document.querySelector('#save-state').textContent,/Potvrzeno/);
  }finally{h.dom.window.close();}
});
test('closing payment dialog preserves reservation for explicit recovery; stock and settings screens work',{concurrency:false},async()=>{
  const h=await harness();try{
   h.click('[data-action="openShift"]');h.w.document.querySelector('[name="opening"]').value='0';h.submit();await until(()=>h.server.shifts.length===1&&!h.w.document.querySelector('#dialog').open,'shift opened');
   h.click('.product[data-action="add"]');await until(()=>h.w.document.querySelector('.quantity-tap'),'line');h.click('[data-action="payCard"]');await until(()=>h.w.document.querySelector('[name="cardConfirmed"]'),'payment dialog');
   h.click('.close-dialog');assert.ok(h.server.orders[0].paymentLock);
   h.click('[data-action="checkPayment"]');const form=h.w.document.querySelector('#dialog-form');form.elements.operation.value='cancel';form.elements.checked.checked=true;h.submit();await until(()=>!h.server.orders[0].paymentLock,'payment reservation cleared');
   h.click('[data-view="stock"]');assert.ok(h.w.document.querySelector('#recipe-search'));
   assert.match(h.w.document.querySelector('#app').textContent,/0 \/ 208/);
   h.click('[data-action="recipe"]');assert.ok(h.w.document.querySelector('.recipe-product'));
   h.click('.close-dialog');h.click('[data-view="settings"]');assert.ok(h.w.document.querySelector('#settings-form'));
   assert.match(h.w.document.querySelector('#app').textContent,/Společné účty a sklad/);
  }finally{h.dom.window.close();}
});
test('two pending tab operations keep separate durable IDs and can both be recovered',{concurrency:false},async()=>{
  const h=await harness();try{
   h.click('[data-action="openShift"]');h.w.document.querySelector('[name="opening"]').value='0';h.submit();await until(()=>h.server.shifts.length===1&&!h.w.document.querySelector('#dialog').open,'shift opened');
   h.drop();h.click('.product[data-action="add"]');await until(()=>h.w.POSCloud.pending&&!h.w.POSCloud.busy,'first pending operation');
   const first=h.w.POSCloud.pending;
   const second={...structuredClone(first),requestId:crypto.randomUUID(),sentAt:new Date(Date.now()+1000).toISOString()};
   const prefix=`pub-bizz-cloud-pending:${h.w.POSCloud.venue.id}:${h.w.POSCloud.user.id}:`;
   h.w.localStorage.setItem(prefix+second.requestId,JSON.stringify(second));
   await h.w.POSCloud.retry();assert.equal(h.w.POSCloud.pending.requestId,second.requestId);
   assert.equal(h.server.orders[0].lines[0].quantity,1);
   await h.w.POSCloud.retry();assert.equal(h.w.POSCloud.pending,null);
   assert.equal(h.server.orders[0].lines[0].quantity,2);
  }finally{h.dom.window.close();}
});

async function accountsForMerge(h){
  h.click('[data-action="openShift"]');h.w.document.querySelector('[name="opening"]').value='0';h.submit();
  await until(()=>h.server.shifts.length===1&&!h.w.document.querySelector('#dialog').open,'shift');
  const ids=[];
  for(const name of ['Stůl 1','Petr']){
   h.click('[data-action="newOrder"]');h.w.document.querySelector('[name="name"]').value=name;h.submit();
   await until(()=>h.w.document.querySelector('.receipt-head h2')?.textContent===name&&!h.w.document.querySelector('#dialog').open,'account '+name);
   const id=h.server.orders.find(o=>o.name===name).id;ids.push(id);
   h.click('.product[data-action="add"]');await until(()=>h.w.document.querySelector('.quantity-tap')?.textContent.replace('×','')==='1','item '+name);
  }
  h.click(`[data-action="account"][data-id="${ids[0]}"]`);
  h.click('[data-action="mergeOrders"]');
  assert.equal(h.w.document.querySelector('#dialog-submit').disabled,true);
  const select=h.w.document.querySelector('[name="targetOrderId"]');select.value=ids[1];select.dispatchEvent(new h.w.Event('change'));
  return {source:ids[0],target:ids[1]};
}
test('merge UI previews the chosen total, conserves items and selects the combined customer account',{concurrency:false},async()=>{
  const h=await harness();try{
   const {source,target}=await accountsForMerge(h);
   const total=h.server.orders.reduce((n,o)=>n+C.sum(o.lines),0);
   const formatted=new Intl.NumberFormat('cs-CZ',{style:'currency',currency:'CZK',maximumFractionDigits:0}).format(total/100);
   assert.equal(h.w.document.querySelector('#merge-summary .total strong').textContent,formatted);
   assert.match(h.w.document.querySelector('#merge-summary p').textContent,/Petr/);
   h.submit();await until(()=>h.w.document.querySelector('.receipt-head h2')?.textContent==='Petr'&&!h.w.document.querySelector('#dialog').open,'combined account selected');
   assert.equal(h.server.orders.find(o=>o.id===source).lines.length,0);
   assert.equal(C.sum(h.server.orders.find(o=>o.id===target).lines),total);
   assert.equal(h.w.document.querySelector('.quantity-tap').textContent,'2×');
   assert.equal(h.server.receipts.length,0);
  }finally{h.dom.window.close();}
});
test('merge UI rejects a stale preview when another device changes the chosen account',{concurrency:false},async()=>{
  const h=await harness();try{
   const {source,target}=await accountsForMerge(h);
   h.external('addLine',{orderId:target,productId:h.server.orders.find(o=>o.id===target).lines[0].productId});
   await h.w.POSCloud.refresh();
   h.submit();await until(()=>/změnil/.test(h.w.document.querySelector('#dialog-error').textContent),'stale merge rejected');
   assert.equal(h.server.orders.find(o=>o.id===source).lines[0].quantity,1);
   assert.equal(h.server.orders.find(o=>o.id===target).lines[0].quantity,2);
   assert.equal(h.server.audit.filter(a=>a.type==='mergeOrders').length,0);
  }finally{h.dom.window.close();}
});
test('lost merge response retries the same request without moving items added later to the old table',{concurrency:false},async()=>{
  const h=await harness();try{
   const {source,target}=await accountsForMerge(h);
   h.drop();h.submit();await until(()=>h.w.POSCloud.pending?.type==='mergeOrders'&&!h.w.POSCloud.busy&&!h.w.document.querySelector('#dialog-submit').disabled,'merge awaiting recovery');
   assert.equal(h.server.orders.find(o=>o.id===source).lines.length,0);
   h.external('addLine',{orderId:source,productId:h.server.orders.find(o=>o.id===target).lines[0].productId});
   h.click('.close-dialog');h.click('[data-action="retryPending"]');
   await until(()=>!h.w.POSCloud.pending&&h.w.document.querySelector('.receipt-head h2')?.textContent==='Petr','merge recovered');
   assert.equal(h.server.orders.find(o=>o.id===source).lines[0].quantity,1);
   assert.equal(h.server.orders.find(o=>o.id===target).lines[0].quantity,2);
   assert.equal(h.server.audit.filter(a=>a.type==='mergeOrders').length,1);
   const calls=h.calls.filter(c=>c.type==='mergeOrders');assert.equal(calls.length,2);assert.equal(calls[0].requestId,calls[1].requestId);
  }finally{h.dom.window.close();}
});


test('fast register keeps product grid node stable while adding and correcting an unpaid item',{concurrency:false},async()=>{
 const h=await harness();try{
  h.click('[data-action="openShift"]');h.w.document.querySelector('[name="opening"]').value='0';h.submit();
  await until(()=>h.server.shifts.length===1&&!h.w.document.querySelector('#dialog').open,'shift');
  const grid=h.w.document.querySelector('#products');
  h.click('.product[data-action="add"]');await until(()=>h.w.document.querySelector('.quantity-tap')?.textContent==='1×','line added');
  assert.equal(h.w.document.querySelector('#products'),grid);
  h.click('[data-action="add"]');await until(()=>h.w.document.querySelector('.quantity-tap')?.textContent==='2×','line incremented');
  assert.equal(h.w.document.querySelector('#products'),grid);
  h.click('[data-action="minus"]');await until(()=>h.w.document.querySelector('.quantity-tap')?.textContent==='1×','line corrected');
  assert.equal(h.w.document.querySelector('#dialog').open,false);
  assert.equal(h.w.document.querySelector('#products'),grid);
 }finally{h.dom.window.close();}
});


async function startShift(h){
 h.click('[data-action="openShift"]');h.w.document.querySelector('[name="opening"]').value='0';h.submit();
 await until(()=>h.server.shifts.length===1&&!h.w.document.querySelector('#dialog').open,'shift opened');
}
async function namedAccount(h,name='Stůl 12'){
 h.click('[data-action="newOrder"]');h.w.document.querySelector('[name="name"]').value=name;h.submit();
 await until(()=>h.w.document.querySelector('.receipt-head h2')?.textContent===name&&!h.w.document.querySelector('#dialog').open,'named account selected');
 return h.server.orders.find(o=>o.name===name).id;
}
test('no account selection marks a quick sale; a blank new account reuses it without creating an account',{concurrency:false},async()=>{
 const h=await harness();try{
  await startShift(h);
  assert.equal(h.w.document.querySelector('#account-search').value,'');
  h.click('.product[data-action="add"]');await until(()=>h.server.orders[0].lines.length===1,'automatic quick sale');
  assert.equal(h.calls.filter(c=>c.type==='newOrder').length,0);
  const id=await namedAccount(h,'Petr');
  h.click('.product[data-action="add"]');await until(()=>h.server.orders.find(o=>o.id===id).lines.length===1,'named item');
  const before=structuredClone(h.server);
  h.click('[data-action="newOrder"]');
  const name=h.w.document.querySelector('[name="name"]');assert.equal(name.required,false);assert.equal(name.value,'');
  name.value='   ';h.submit();
  await until(()=>!h.w.document.querySelector('#dialog').open&&h.w.document.querySelector('.receipt-head h2').textContent==='Rychlý prodej','blank means quick sale');
  assert.deepEqual(h.server,before);assert.equal(h.calls.filter(c=>c.type==='newOrder').length,1);
  assert.equal(h.w.document.querySelector('#account-search').value,'');
  h.click('.product[data-action="add"]');await until(()=>h.server.orders[0].lines[0].quantity===2,'next quick sale item');
  assert.equal(h.server.orders.find(o=>o.id===id).lines[0].quantity,1);
 }finally{h.dom.window.close();}
});
test('clearing the displayed table or customer switches to quick sale and preserves the unpaid account',{concurrency:false},async()=>{
 const h=await harness();try{
  await startShift(h);const id=await namedAccount(h);
  h.click('.product[data-action="add"]');await until(()=>h.server.orders.find(o=>o.id===id).lines.length===1,'table item');
  assert.equal(h.w.document.querySelector('#account-search').value,'Stůl 12');
  h.external('newOrder',{name:'Žaneta'});await h.w.POSCloud.refresh();
  await until(()=>h.w.document.querySelectorAll('.account').length===3,'refresh rendered');
  const input=h.w.document.querySelector('#account-search'),grid=h.w.document.querySelector('#products');
  assert.equal(input.value,'Stůl 12');input.value='';input.dispatchEvent(new h.w.Event('input'));
  assert.equal(h.w.document.querySelector('.receipt-head h2').textContent,'Rychlý prodej');
  assert.equal(h.w.document.querySelector('#entry-account-name').textContent,'Rychlý prodej');
  assert.equal(h.w.document.querySelector('#products'),grid);
  h.click('.product[data-action="add"]');await until(()=>h.server.orders[0].lines.length===1,'quick sale after clearing');
  assert.equal(h.server.orders.find(o=>o.id===id).lines[0].quantity,1);
 }finally{h.dom.window.close();}
});
test('a fully paid named account returns to quick sale for the next guest after cash or confirmed card payment',{concurrency:false},async()=>{
 for(const mode of ['Cash','Card']){
  const h=await harness();try{
   await startShift(h);const id=await namedAccount(h);
   h.click('.product[data-action="add"]');await until(()=>h.server.orders.find(o=>o.id===id).lines.length===1,'named item');
   h.click('[data-action="pay'+mode+'"]');await until(()=>h.w.document.querySelector('[name="received"]'),'payment dialog');
   if(mode==='Card'){
    h.submit();await until(()=>/terminálu/.test(h.w.document.querySelector('#dialog-error').textContent),'unconfirmed card rejected');
    assert.equal(h.w.document.querySelector('.receipt-head h2').textContent,'Stůl 12');
    h.w.document.querySelector('[name="cardConfirmed"]').checked=true;
   }
   h.submit();await until(()=>h.server.receipts.length===1&&!h.w.document.querySelector('#dialog').open,'paid');
   assert.equal(h.w.document.querySelector('.receipt-head h2').textContent,'Rychlý prodej');
   assert.equal(h.w.document.querySelector('#account-search').value,'');
   assert.equal(h.server.receipts[0].orderId,id);assert.equal(h.server.receipts[0].orderName,'Stůl 12');
   h.click('.product[data-action="add"]');await until(()=>h.server.orders[0].lines.length===1,'next guest');
   assert.equal(h.server.orders.find(o=>o.id===id).lines.length,0);
  }finally{h.dom.window.close();}
 }
});
test('a partial named payment keeps its remainder selected and only the final payment returns to quick sale',{concurrency:false},async()=>{
 const h=await harness();try{
  await startShift(h);const id=await namedAccount(h,'Žaneta');
  h.click('[data-action="entryCount"][data-id="3"]');h.click('.product[data-action="add"]');
  await until(()=>h.server.orders.find(o=>o.id===id).lines[0]?.quantity===3,'three pieces');
  h.click('[data-action="paySplit"]');await until(()=>h.w.document.querySelector('.payment-item'),'split');
  h.click('.payment-item');h.click('[data-qty="1"]');h.submit();
  await until(()=>h.server.receipts.length===1&&!h.w.document.querySelector('#dialog').open,'partial paid');
  assert.equal(h.w.document.querySelector('.receipt-head h2').textContent,'Žaneta');
  assert.equal(h.w.document.querySelector('#account-search').value,'Žaneta');
  assert.equal(h.w.document.querySelector('.quantity-tap').textContent,'2×');
  h.click('[data-action="payCash"]');await until(()=>h.w.document.querySelector('#dialog').open&&h.w.document.querySelector('#dialog-title').textContent==='Zaplatit hotově','remaining payment');h.submit();
  await until(()=>h.server.receipts.length===2&&!h.w.document.querySelector('#dialog').open,'remainder paid');
  assert.equal(h.w.document.querySelector('.receipt-head h2').textContent,'Rychlý prodej');
  assert.equal(h.server.orders.find(o=>o.id===id).lines.length,0);
 }finally{h.dom.window.close();}
});
test('recovering a named checkout returns to quick sale once, or preserves items added before recovery',{concurrency:false},async()=>{
 for(const laterItem of [false,true]){
  const h=await harness();try{
   await startShift(h);const id=await namedAccount(h);
   h.click('.product[data-action="add"]');await until(()=>h.server.orders.find(o=>o.id===id).lines.length===1,'named item');
   const productId=h.server.orders.find(o=>o.id===id).lines[0].productId;
   h.click('[data-action="payCash"]');await until(()=>h.w.document.querySelector('[name="received"]'),'payment');
   h.drop();h.submit();await until(()=>h.w.POSCloud.pending?.type==='checkout'&&!h.w.POSCloud.busy&&!h.w.document.querySelector('#dialog-submit').disabled,'checkout awaiting recovery');
   assert.equal(h.w.document.querySelector('.receipt-head h2').textContent,'Stůl 12');
   if(laterItem)h.external('addLine',{orderId:id,productId});
   h.click('.close-dialog');h.click('[data-action="retryPending"]');
   await until(()=>!h.w.POSCloud.pending&&/Zaplaceno/.test(h.w.document.querySelector('#toast').textContent),'recovered');
   assert.equal(h.w.document.querySelector('.receipt-head h2').textContent,laterItem?'Stůl 12':'Rychlý prodej');
   assert.equal(h.server.receipts.length,1);
   const calls=h.calls.filter(c=>c.type==='checkout');assert.equal(calls.length,2);assert.equal(calls[0].requestId,calls[1].requestId);
   assert.equal(h.server.orders.find(o=>o.id===id).lines.length,laterItem?1:0);
  }finally{h.dom.window.close();}
 }
});
function sold(server,productId,quantity){
 C.execute(server,'addLine',{orderId:'bar',productId,quantity});
 const order=server.orders[0];
 return C.execute(server,'checkout',{orderId:order.id,revision:order.revision,operationId:crypto.randomUUID(),selected:order.lines.map(l=>({id:l.id,quantity:l.quantity})),mode:'cash',received:C.sum(order.lines)});
}
const productIds=h=>[...h.w.document.querySelectorAll('.product[data-action="add"]')].map(p=>p.dataset.id);
test('shared sales rank products by pieces across categories and search, excluding refunds and keeping ties stable',{concurrency:false},async()=>{
 const ids={};
 const h=await harness(server=>{
  C.execute(server,'openShift',{opening:0,operator:'Test'});
  for(const [key,name,category,price] of [
   ['rare','Častý drahý','Test',100000],['popular','Častý oblíbený','Test',100],
   ['tie','Častý stejný počet','Test',200],['global','Častý jiná kategorie','Jiná',100],
   ['refund','Častý vrácený','Test',100],['restored','Častý zpět na stůl','Test',100],
   ['archived','Častý archivovaný','Test',100]
  ])ids[key]=C.execute(server,'product',{name,category,price,vatRate:21}).id;
  sold(server,ids.rare,2);sold(server,ids.popular,5);sold(server,ids.tie,5);sold(server,ids.global,8);
  sold(server,ids.archived,50);C.execute(server,'archiveProduct',{id:ids.archived});
  const refunded=sold(server,ids.refund,30);C.execute(server,'refund',{receiptId:refunded.id,reason:'Test'});
  const restored=sold(server,ids.restored,40);C.execute(server,'restoreReceipt',{receiptId:restored.id});
  // The restored open items must not leak into the ranking of paid sales.
  return server;
 });
 try{
  assert.equal(h.w.document.querySelector('.category.active').dataset.id,'Vše');
  assert.deepEqual(productIds(h).slice(0,4),[ids.global,ids.popular,ids.tie,ids.rare]);
  assert.ok(!productIds(h).includes(ids.archived));
  h.click('[data-action="category"][data-id="Test"]');
  assert.deepEqual(productIds(h),[ids.popular,ids.tie,ids.rare,ids.refund,ids.restored]);
  const input=h.w.document.querySelector('#search');input.value='casty';input.dispatchEvent(new h.w.Event('input',{bubbles:true}));
  assert.deepEqual(productIds(h),[ids.global,ids.popular,ids.tie,ids.rare,ids.refund,ids.restored]);
 }finally{h.dom.window.close();}
});
test('new paid quantities update ranking and a refund removes them; unpaid marking leaves button positions unchanged',{concurrency:false},async()=>{
 const h=await harness();try{
  await startShift(h);h.click('[data-action="category"][data-id="Pivo"]');
  const original=productIds(h),id=original[1],firstButton=h.w.document.querySelector('.product[data-action="add"]');
  h.click('[data-action="entryCount"][data-id="5"]');h.click('.product[data-id="'+id+'"]');
  await until(()=>h.server.orders[0].lines[0]?.quantity===5,'five unpaid pieces');
  assert.deepEqual(productIds(h),original);assert.equal(h.w.document.querySelector('.product[data-action="add"]'),firstButton);
  h.click('[data-action="paySplit"]');await until(()=>h.w.document.querySelector('.payment-item'),'split dialog');
  h.click('.payment-item');h.click('[data-qty="2"]');h.submit();
  await until(()=>h.server.receipts.length===1&&!h.w.document.querySelector('#dialog').open,'two paid pieces');
  assert.equal(h.server.orders[0].lines[0].quantity,3);assert.equal(productIds(h)[0],id);
  await h.w.POSCloud.refresh();assert.equal(productIds(h)[0],id);
  h.external('refund',{receiptId:h.server.receipts[0].id,reason:'Test'});await h.w.POSCloud.refresh();
  await until(()=>productIds(h)[0]===original[0],'refund refreshes ranking');
  assert.deepEqual(productIds(h),original);
 }finally{h.dom.window.close();}
});
test('an unused catalog keeps its original order in all products and each category',{concurrency:false},async()=>{
 const h=await harness();try{
  assert.deepEqual(productIds(h),h.server.products.filter(p=>p.active).map(p=>p.id));
  h.click('[data-action="category"][data-id="Pivo"]');
  assert.deepEqual(productIds(h),h.server.products.filter(p=>p.active&&p.category==='Pivo').map(p=>p.id));
 }finally{h.dom.window.close();}
});
test('search selects the real table number or a customer without accents and marks five pieces in one request',{concurrency:false},async()=>{
 const h=await harness();try{
  await startShift(h);
  for(const name of ['Stůl 12','Stůl 2','Žaneta'])h.external('newOrder',{name});
  await h.w.POSCloud.refresh();await until(()=>h.w.document.querySelector('#account-search'),'search ready');
  const search=h.w.document.querySelector('#account-search');
  search.value='12';search.dispatchEvent(new h.w.Event('input'));
  const table=h.w.document.querySelector('#account-results [data-action="account"]');assert.equal(table.querySelector('strong').textContent,'Stůl 12');table.click();
  assert.equal(h.w.document.querySelector('.receipt-head h2').textContent,'Stůl 12');
  search.value='zaneta';search.dispatchEvent(new h.w.Event('input'));
  const customer=h.w.document.querySelector('#account-results [data-action="account"]');assert.equal(customer.querySelector('strong').textContent,'Žaneta');customer.click();
  h.click('[data-action="entryCount"][data-id="5"]');h.click('.product[data-action="add"]');
  await until(()=>h.server.orders.find(o=>o.name==='Žaneta').lines[0]?.quantity===5,'five pieces marked');
  assert.equal(h.calls.filter(c=>c.type==='addLine').length,1);
  assert.equal(h.calls.find(c=>c.type==='addLine').payload.quantity,5);
  assert.equal(h.w.document.querySelector('#entry-quantity').textContent,'1×');
  assert.equal(h.server.orders.find(o=>o.name==='Stůl 12').lines.length,0);
 }finally{h.dom.window.close();}
});
test('calculator accepts multi-digit counts and single-tap corrections close automatically',{concurrency:false},async()=>{
 const h=await harness();try{
  await startShift(h);h.click('[data-action="entryQuantity"]');h.click('[data-qty-more]');
  h.click('[data-qty-digit="1"]');h.click('[data-qty-digit="2"]');h.click('[data-qty-confirm]');
  assert.equal(h.w.document.querySelector('#dialog').open,false);assert.equal(h.w.document.querySelector('#entry-quantity').textContent,'12×');
  h.click('.product[data-action="add"]');await until(()=>h.w.document.querySelector('.quantity-tap')?.textContent==='12×','12 pieces marked');
  h.click('[data-action="quantityPad"]');h.click('[data-qty="3"]');
  await until(()=>h.w.document.querySelector('.quantity-tap')?.textContent==='3×','three pieces correction');
  assert.equal(h.w.document.querySelector('#dialog').open,false);
  assert.equal(h.calls.filter(c=>c.type==='setLineQuantity').length,1);
  h.click('[data-action="entryQuantity"]');h.click('[data-qty="4"]');h.click('.product[data-action="add"]');
  await until(()=>h.w.document.querySelector('.quantity-tap')?.textContent==='7×','second quantity picker has no stale listener');
 }finally{h.dom.window.close();}
});
test('split bill selects item then pieces, returns to other items, leaves the remainder and needs no receipt dismissal',{concurrency:false},async()=>{
 const h=await harness();try{
  await startShift(h);
  const products=[...h.w.document.querySelectorAll('.product[data-action="add"]')];
  h.click('[data-action="entryCount"][data-id="5"]');products[0].click();await until(()=>h.server.orders[0].lines[0]?.quantity===5,'first product');
  h.click('[data-action="entryCount"][data-id="3"]');products[1].click();await until(()=>h.server.orders[0].lines.length===2,'second product');
  const original=structuredClone(h.server.orders[0].lines);
  h.click('[data-action="paySplit"]');await until(()=>h.w.document.querySelector('.payment-item'),'split opened');
  assert.equal(h.w.document.querySelector('#dialog-submit').disabled,true);
  h.click(`[data-payment-line="${original[0].id}"]`);h.click('[data-qty="2"]');
  assert.equal(h.w.document.querySelector('#payment-items').hidden,false);assert.equal(h.w.document.querySelector('#payment-qty-editor').hidden,true);
  h.click(`[data-payment-line="${original[1].id}"]`);h.click('[data-qty="1"]');
  assert.equal(h.w.document.querySelector('#dialog-form').elements['line-'+original[0].id].value,'2');
  assert.equal(h.w.document.querySelector('#dialog-form').elements['line-'+original[1].id].value,'1');
  h.submit();await until(()=>h.server.receipts.length===1&&!h.w.document.querySelector('#dialog').open,'partial paid and returned to register');
  assert.deepEqual(h.server.receipts[0].lines.map(l=>l.quantity),[2,1]);assert.deepEqual(h.server.orders[0].lines.map(l=>l.quantity),[3,2]);
  assert.match(h.w.document.querySelector('#toast').textContent,/Zaplaceno/);
  h.w.document.querySelector('[data-view="history"]').click();h.click('[data-action="receipt"]');assert.equal(h.w.document.querySelector('#dialog-title').textContent,'Zaplaceno');
  assert.equal(h.w.document.querySelector('#dialog-submit').textContent,'Vytisknout doklad');
 }finally{h.dom.window.close();}
});
test('partial card payment requires terminal confirmation and preserves the other pieces',{concurrency:false},async()=>{
 const h=await harness();try{
  await startShift(h);h.click('[data-action="entryCount"][data-id="4"]');h.click('.product[data-action="add"]');
  await until(()=>h.server.orders[0].lines[0]?.quantity===4,'four pieces');
  h.click('[data-action="paySplit"]');await until(()=>h.w.document.querySelector('.payment-item'),'split');
  h.click('.payment-item');h.click('[data-qty="1"]');h.click('[data-payment-mode="card"]');
  const confirm=h.w.document.querySelector('[name="cardConfirmed"]');assert.equal(confirm.required,true);
  h.submit();await until(()=>/terminálu/.test(h.w.document.querySelector('#dialog-error').textContent),'unconfirmed terminal rejected');
  assert.equal(h.server.receipts.length,0);confirm.checked=true;h.submit();
  await until(()=>h.server.receipts.length===1&&!h.w.document.querySelector('#dialog').open,'card paid');
  assert.equal(h.server.orders[0].lines[0].quantity,3);assert.equal(h.server.receipts[0].cash,0);assert.ok(h.server.receipts[0].card>0);
 }finally{h.dom.window.close();}
});
test('a lost response to a five-piece entry recovers the same request without duplicating pieces',{concurrency:false},async()=>{
 const h=await harness();try{
  await startShift(h);h.click('[data-action="entryCount"][data-id="5"]');h.drop();h.click('.product[data-action="add"]');
  await until(()=>h.w.POSCloud.pending&&!h.w.POSCloud.busy,'lost quantity response');assert.equal(h.server.orders[0].lines[0].quantity,5);
  h.click('[data-action="retryPending"]');await until(()=>!h.w.POSCloud.pending&&h.w.document.querySelector('.quantity-tap')?.textContent==='5×','quantity recovered');
  const calls=h.calls.filter(c=>c.type==='addLine');assert.equal(calls.length,2);assert.equal(calls[0].requestId,calls[1].requestId);
  assert.equal(h.server.orders[0].lines[0].quantity,5);assert.equal(h.w.document.querySelector('#entry-quantity').textContent,'1×');
 }finally{h.dom.window.close();}
});
