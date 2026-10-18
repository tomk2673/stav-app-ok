const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const {JSDOM}=require('jsdom');
const C=require('../../pub_bizz_pos/core.js');
const D=require('../../pub_bizz_pos/server-domain.js');
const root=path.resolve(__dirname,'../../pub_bizz_pos');
const pause=ms=>new Promise(r=>setTimeout(r,ms));
function paidCorrectionSeed(mode='cash'){
 return s=>{
  C.execute(s,'openShift',{opening:0});
  const table=C.execute(s,'newOrder',{name:'Stůl 1'}), other=C.execute(s,'newOrder',{name:'Stůl 2'});
  C.execute(s,'addLine',{orderId:table.id,productId:'agnis-2810',quantity:3});const o=s.orders.find(x=>x.id===table.id);
  C.execute(s,'checkout',{orderId:o.id,revision:o.revision,operationId:crypto.randomUUID(),selected:o.lines.map(l=>({id:l.id,quantity:l.quantity})),mode,received:20000,splitCash:1000,cardConfirmed:true});
  return s;
 };
}
async function until(predicate,label){for(let i=0;i<200;i++){if(predicate())return;await pause(10);}throw new Error('Timed out: '+label);}
async function harness(seed=state=>state,role='owner'){
  const html=fs.readFileSync(path.join(root,'index.html'),'utf8');
  const dom=new JSDOM(html,{url:'https://pos.test/pub_bizz_pos/index.html',runScripts:'outside-only',pretendToBeVisual:true});
  const w=dom.window,venue={id:crypto.randomUUID(),organization_id:crypto.randomUUID(),name:'Test venue',currency:'CZK',role},user={id:crypto.randomUUID(),email:'owner@example.test'};
  let server=C.initial();server.venueId=venue.id;server.recipes={};server=seed(server);
  const requests=new Map(),calls=[];let dropNext=false,dropBefore=false,holdNext=false,release;
  w.structuredClone=structuredClone;w.TextEncoder=TextEncoder;
  w.HTMLDialogElement.prototype.showModal=function(){this.setAttribute('open','');};
  w.HTMLDialogElement.prototype.close=function(){this.removeAttribute('open');this.dispatchEvent(new w.Event('close'));};
  w.HTMLElement.prototype.scrollIntoView=function(){};w.print=()=>{};
  w.supabase={createClient:()=>({auth:{getSession:async()=>({data:{session:{access_token:'test-only'}}}),refreshSession:async()=>({data:{session:{access_token:'test-only'}}}),signOut:async()=>({})},channel:()=>({subscribe:()=>({})})})};
  const envelope=result=>({state:structuredClone(server),result:structuredClone(result),stock:[],issues:[],issueCount:0,role,venue});
  w.fetch=async(url,init)=>{
   let data,status=200;
   if(init.method==='GET') data=url.includes('venueId=')?envelope(null):{venues:[venue],user};
   else {
    const r=JSON.parse(init.body);calls.push(r);
    if(dropBefore){dropBefore=false;throw new TypeError('Simulated disconnected request before commit');}
    if(holdNext){holdNext=false;await new Promise(resolve=>release=resolve);}
    if(requests.has(r.requestId))data=envelope(requests.get(r.requestId));
    else {try {const p={...r.payload};if(r.type==='checkout')p.operationId=r.requestId;const next=D.run(server,r.type,p,{id:user.id,role},[]);server=next.state;requests.set(r.requestId,next.result);data=envelope(next.result);} catch(e) {status=422;data={error:e.message,definitive:true};} }
    if(dropNext===true||dropNext===r.type){dropNext=false;throw new TypeError('Simulated lost response after successful commit');}
   }
   return {ok:status===200,status,json:async()=>data};
  };
  for(const name of ['catalog.js','core.js','customer.js','storage.js','config.js','cloud.js','stock.js','app.js'])w.eval(fs.readFileSync(path.join(root,name),'utf8'));
  await until(()=>w.document.querySelector('.product'),'register open');
  const click=selector=>{const el=w.document.querySelector(selector);assert.ok(el,'Missing '+selector);el.click();};
  const submit=()=>w.document.querySelector('#dialog-form').dispatchEvent(new w.Event('submit',{bubbles:true,cancelable:true}));
  return {dom,w,click,submit,get server(){return server;},calls,drop(type=true){dropNext=type;},disconnect(){dropBefore=true;},hold(){holdNext=true;},release(){release?.();},external(type,payload){server=D.run(server,type,payload,{id:user.id,role:'owner'},[]).state;}};
}
test('2cl toggle marks real piece counts, keeps plus/quantity edits small and splits only selected small shots',{concurrency:false},async()=>{
 const h=await harness(s=>{C.execute(s,'openShift',{opening:0});return s;});try{
  h.click('[data-action="category"][data-id="Pivo"]');const search=h.w.document.querySelector('#search');search.value='Radegast';search.dispatchEvent(new h.w.Event('input'));
  h.click('[data-action="smallShot"]');assert.equal(h.w.document.querySelector('[data-action="smallShot"]').getAttribute('aria-pressed'),'true');
  assert.match(h.w.document.querySelector('#entry-count-label').textContent,/2 cl/);assert.equal(h.w.document.querySelector('.product[data-id="agnis-50"]'),null);
  h.click('[data-action="entryCount"][data-id="3"]');h.click('.product[data-id="agnis-2810"]');
  await until(()=>h.server.orders[0].lines.length===1,'three small shots');
  const small=h.server.orders[0].lines[0];assert.equal(small.quantity,3);assert.equal(small.price,2750);assert.equal(small.servingMl,20);
  assert.equal(h.calls.filter(c=>c.type==='addLine').length,1);assert.equal(h.w.document.querySelector('#entry-quantity').textContent,'1×');
  h.click('[data-action="smallShot"]');h.click('.line [data-action="add"]');
  await until(()=>h.server.orders[0].lines[0].quantity===4,'small plus');assert.equal(h.server.orders[0].lines.length,1);
  h.click('.product[data-id="agnis-2810"]');await until(()=>h.server.orders[0].lines.length===2,'regular shot');
  assert.equal(h.server.orders[0].lines[1].price,5500);assert.equal(h.server.orders[0].lines[1].quantity,1);
  h.click('[data-action="quantityPad"][data-id="'+small.id+'"]');h.click('[data-qty="5"]');await until(()=>h.server.orders[0].lines[0].quantity===5,'five small shots');
  h.click('[data-action="paySplit"]');await until(()=>h.w.document.querySelector('.payment-item'),'split ready');h.click('.payment-item');h.click('[data-qty="2"]');h.click('[data-payment-mode="card"]');
  h.w.document.querySelector('[name="cardConfirmed"]').checked=true;h.submit();
  await until(()=>h.server.receipts.length===1&&!h.w.document.querySelector('#dialog').open,'two small paid');
  assert.equal(h.server.receipts[0].total,5500);assert.equal(h.server.receipts[0].lines[0].servingMl,20);assert.equal(h.server.receipts[0].lines[0].quantity,2);
  assert.equal(h.server.orders[0].lines[0].quantity,3);assert.equal(h.server.orders[0].lines[1].quantity,1);
 }finally{h.dom.window.close();}
});
test('2cl lost response replays the same portion and UUID without creating more shots',{concurrency:false},async()=>{
 const h=await harness(s=>{C.execute(s,'openShift',{opening:0});return s;});try{
  h.click('[data-action="smallShot"]');h.click('[data-action="entryCount"][data-id="3"]');h.drop();h.click('.product[data-id="agnis-2810"]');
  await until(()=>h.w.POSCloud.pending&&!h.w.POSCloud.busy,'uncertain small shots');const id=h.w.POSCloud.pending.requestId;
  assert.equal(h.w.POSCloud.pending.payload.servingMl,20);h.click('[data-action="retryPending"]');
  await until(()=>!h.w.POSCloud.pending&&!h.w.POSCloud.busy,'small shots verified');
  assert.equal(h.server.orders[0].lines.length,1);assert.equal(h.server.orders[0].lines[0].quantity,3);assert.equal(h.server.orders[0].lines[0].price,2750);
  assert.equal(h.calls.filter(c=>c.requestId===id).length,2);assert.equal(h.server.audit.filter(a=>a.type==='addLine').length,1);
 }finally{h.dom.window.close();}
});
test('manager can set a separate 2cl price without changing the standard price',{concurrency:false},async()=>{
 const h=await harness(s=>{C.execute(s,'openShift',{opening:0});return s;});try{
  h.click('[data-view="catalog"]');h.click('[data-action="editProduct"][data-id="agnis-2810"]');
  h.w.document.querySelector('[name="smallShotPrice"]').value='30';h.submit();await until(()=>!h.w.document.querySelector('#dialog').open,'small price saved');
  assert.equal(h.server.products.find(p=>p.id==='agnis-2810').price,5500);assert.equal(h.server.products.find(p=>p.id==='agnis-2810').smallShotPrice,3000);
  h.click('[data-view="pos"]');h.click('[data-action="smallShot"]');assert.match(h.w.document.querySelector('.product[data-id="agnis-2810"] .product-price').textContent,/30/);
  h.click('[data-action="entryCount"][data-id="3"]');h.click('.product[data-id="agnis-2810"]');await until(()=>h.server.orders[0].lines.length===1,'custom small shots');assert.equal(C.sum(h.server.orders[0].lines),9000);
 }finally{h.dom.window.close();}
});
test('setting a missing standard price retains the selected small size and count',{concurrency:false},async()=>{
 const h=await harness(s=>{C.execute(s,'openShift',{opening:0});s.products.find(p=>p.id==='agnis-2810').price=null;return s;});try{
  h.click('[data-action="smallShot"]');h.click('[data-action="entryCount"][data-id="3"]');h.click('.product[data-id="agnis-2810"]');
  h.w.document.querySelector('[name="price"]').value='70';h.submit();await until(()=>h.server.orders[0].lines.length===1,'priced small shots');
  assert.equal(h.server.orders[0].lines[0].servingMl,20);assert.equal(h.server.orders[0].lines[0].quantity,3);assert.equal(h.server.orders[0].lines[0].price,3500);
 }finally{h.dom.window.close();}
});
test('rename UI preserves the same account, updates search and survives a lost response once',{concurrency:false},async()=>{
 const h=await harness(paidCorrectionSeed());try{
  const id=h.server.orders.find(o=>o.name==='Stůl 1').id;
  h.external('addLine',{orderId:id,productId:'agnis-2810',quantity:2});await h.w.POSCloud.refresh();
  h.click('[data-action="account"][data-id="'+id+'"]');
  const before=structuredClone(h.server),order=before.orders.find(o=>o.id===id);
  h.click('[data-action="renameOrder"]');
  assert.equal(h.w.document.querySelector('[name="name"]').value,'Stůl 1');
  h.w.document.querySelector('[name="name"]').value='Stůl 2';h.submit();
  await until(()=>/existuje/.test(h.w.document.querySelector('#dialog-error').textContent),'duplicate shown');
  assert.deepEqual(h.server,before);
  h.w.document.querySelector('[name="name"]').value='Petr';h.hold();h.submit();h.submit();
  await until(()=>h.w.POSCloud.busy,'rename request in progress');h.release();
  await until(()=>!h.w.document.querySelector('#dialog').open,'renamed');
  assert.equal(h.server.orders.find(o=>o.id===id).name,'Petr');
  assert.deepEqual(h.server.orders.find(o=>o.id===id).lines,order.lines);assert.deepEqual(h.server.receipts,before.receipts);
  assert.equal(h.w.document.querySelector('.receipt-head h2').textContent,'Petr');assert.equal(h.w.document.querySelector('#account-search').value,'Petr');
  assert.equal(h.calls.filter(x=>x.type==='renameOrder'&&x.payload.name==='Petr').length,1);
  h.click('[data-action="customerProfile"]');assert.match(h.w.document.querySelector('#dialog-body').textContent,/Věrnostní body/);h.click('#dialog .close-dialog');
  h.click('[data-action="renameOrder"]');h.w.document.querySelector('[name="name"]').value='Petr Král';h.drop();h.submit();
  await until(()=>h.w.POSCloud.pending&&!h.w.POSCloud.busy,'uncertain rename');
  const request=h.w.POSCloud.pending.requestId;h.click('[data-action="retryPending"]');
  await until(()=>!h.w.POSCloud.pending&&!h.w.POSCloud.busy,'rename verified');
  assert.equal(h.server.orders.find(o=>o.id===id).name,'Petr Král');
  assert.equal(h.server.audit.filter(x=>x.type==='renameOrder').length,2);assert.deepEqual(h.server.receipts,before.receipts);
  assert.equal(h.calls.filter(x=>x.requestId===request).length,2);
  assert.equal(h.w.document.querySelector('.receipt-head h2').textContent,'Petr Král');
  if(h.w.document.querySelector('#dialog').open)h.click('#dialog .close-dialog');
  h.external('beginPayment',{orderId:id,revision:h.server.orders.find(o=>o.id===id).revision});await h.w.POSCloud.refresh();
  assert.equal(h.w.document.querySelector('[data-action="renameOrder"]').disabled,true);
  h.click('[data-action="account"][data-id="bar"]');assert.equal(h.w.document.querySelector('[data-action="renameOrder"]'),null);
 }finally{h.dom.window.close();}
});
test('rename rejects an account changed by another device while the dialog stays open',{concurrency:false},async()=>{
 const h=await harness(paidCorrectionSeed());try{
  const id=h.server.orders.find(o=>o.name==='Stůl 1').id;h.click('[data-action="account"][data-id="'+id+'"]');
  h.click('[data-action="renameOrder"]');h.w.document.querySelector('[name="name"]').value='Petr';
  h.external('renameOrder',{orderId:id,revision:h.server.orders.find(o=>o.id===id).revision,name:'Jana'});const before=structuredClone(h.server);
  h.submit();await until(()=>/změnil/.test(h.w.document.querySelector('#dialog-error').textContent),'stale name rejected');assert.deepEqual(h.server,before);
 }finally{h.dom.window.close();}
});
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
   assert.equal(h.server.orders[0].paymentLock,undefined,'cash reserves only at confirmation');
   h.submit();await until(()=>h.server.receipts.length===1&&!h.server.orders[0].lines.length,'paid');
   assert.equal(h.w.document.querySelector('#dialog').open,false);
   assert.match(h.w.document.querySelector('#toast').textContent,/Zaplaceno/);
   assert.equal(h.server.orders[0].paymentLock,undefined);
   assert.match(h.w.document.querySelector('#save-state').textContent,/Potvrzeno/);
  }finally{h.dom.window.close();}
});
test('cash payment can be abandoned without reserving or changing the quick account',{concurrency:false},async()=>{
 const h=await harness(s=>{C.execute(s,'openShift',{opening:0});C.execute(s,'addLine',{orderId:'bar',productId:'agnis-2810',quantity:2});return s;});try{
  const before=structuredClone(h.server);h.click('[data-action="payCash"]');await until(()=>h.w.document.querySelector('[name="received"]'),'cash dialog');
  assert.equal(h.server.orders[0].paymentLock,undefined,'opening cash must not reserve the account');
  h.click('#dialog .dialog-actions .close-dialog');assert.equal(h.w.document.querySelector('#dialog').open,false);
  assert.deepEqual(h.server,before);assert.equal(h.calls.filter(c=>c.type==='beginPayment').length,0);
  h.click('.line [data-action="add"]');await until(()=>h.server.orders[0].lines[0].quantity===3,'quick account remains markable');assert.equal(h.server.receipts.length,0);
 }finally{h.dom.window.close();}
});
test('legacy quick-sale reservation has a direct cancellation that keeps all items and financial records',{concurrency:false},async()=>{
 const h=await harness(s=>{C.execute(s,'openShift',{opening:0});C.execute(s,'addLine',{orderId:'bar',productId:'agnis-2810',quantity:2});return s;});try{
  h.external('beginPayment',{orderId:'bar',revision:h.server.orders[0].revision});await h.w.POSCloud.refresh();
  const before=structuredClone(h.server);h.click('[data-action="cancelPayment"]');
  assert.equal(h.w.document.querySelector('[name="operation"]'),null,'no hidden cancellation option');
  h.submit();await until(()=>/potvrď/.test(h.w.document.querySelector('#dialog-error').textContent),'unchecked cancellation rejected');
  assert.deepEqual(h.server,before);assert.equal(h.calls.filter(c=>c.type==='cancelPayment').length,0);
  h.w.document.querySelector('[name="checked"]').checked=true;h.hold();h.submit();h.submit();await until(()=>h.w.POSCloud.busy,'cancellation in progress');
  h.w.document.querySelector('#dialog').dispatchEvent(new h.w.Event('cancel',{cancelable:true}));assert.equal(h.w.document.querySelector('#dialog').open,true,'cannot dismiss in-flight command');h.release();
  await until(()=>!h.w.document.querySelector('#dialog').open&&!h.w.POSCloud.busy,'quick sale unlocked');
  assert.equal(h.server.orders[0].paymentLock,undefined);assert.deepEqual(h.server.orders[0].lines,before.orders[0].lines);
  for(const key of ['receipts','creditLedger','stockIssues','shifts'])assert.deepEqual(h.server[key],before[key],key+' unchanged');
  assert.equal(h.server.audit.filter(a=>a.type==='cancelPayment').length,1);assert.equal(h.calls.filter(c=>c.type==='cancelPayment').length,1);
  h.click('.line [data-action="add"]');await until(()=>h.server.orders[0].lines[0].quantity===3,'marking after cancellation');
 }finally{h.dom.window.close();}
});
for(const close of ['footer','header','escape'])test('card payment '+close+' offers cancellation instead of silently leaving a blocked quick sale',{concurrency:false},async()=>{
 const h=await harness(s=>{C.execute(s,'openShift',{opening:0});C.execute(s,'addLine',{orderId:'bar',productId:'agnis-2810'});return s;});try{
  h.click('[data-action="payCard"]');await until(()=>h.w.document.querySelector('[name="cardConfirmed"]'),'card payment');
  const before=structuredClone(h.server);
  if(close==='escape')h.w.document.querySelector('#dialog').dispatchEvent(new h.w.Event('cancel',{cancelable:true}));else h.click('#dialog '+(close==='footer'?'.dialog-actions':'.dialog-head')+' .close-dialog');
  assert.equal(h.w.document.querySelector('#dialog-title').textContent,'Zrušit rozpracovanou platbu');assert.deepEqual(h.server,before);
  h.w.document.querySelector('[name="checked"]').checked=true;h.submit();await until(()=>!h.w.document.querySelector('#dialog').open,'card cancellation');
  assert.equal(h.server.orders[0].paymentLock,undefined);assert.deepEqual(h.server.orders[0].lines,before.orders[0].lines);assert.equal(h.server.receipts.length,0);
 }finally{h.dom.window.close();}
});
for(const timing of ['before','after'])test('cancellation interrupted '+timing+' commit recovers its UUID once and never creates a sale',{concurrency:false},async()=>{
 const h=await harness(s=>{C.execute(s,'openShift',{opening:0});C.execute(s,'addLine',{orderId:'bar',productId:'agnis-2810',quantity:2});return s;});try{
  h.external('beginPayment',{orderId:'bar',revision:h.server.orders[0].revision});await h.w.POSCloud.refresh();
  const lines=structuredClone(h.server.orders[0].lines);h.click('[data-action="cancelPayment"]');h.w.document.querySelector('[name="checked"]').checked=true;
  timing==='before'?h.disconnect():h.drop();h.submit();await until(()=>h.w.POSCloud.pending&&!h.w.POSCloud.busy,'uncertain cancellation');
  const pending=structuredClone(h.w.POSCloud.pending);assert.equal(pending.type,'cancelPayment');
  assert.equal(!!h.server.orders[0].paymentLock,timing==='before');assert.equal(h.w.document.querySelector('[data-action="payCash"]').disabled,true);
  h.click('[data-action="retryPending"]');await until(()=>!h.w.POSCloud.pending&&!h.w.document.querySelector('#dialog').open,'cancellation recovered');
  assert.equal(h.server.orders[0].paymentLock,undefined);assert.deepEqual(h.server.orders[0].lines,lines);assert.equal(h.server.receipts.length,0);
  assert.equal(h.server.audit.filter(a=>a.type==='cancelPayment').length,1);const calls=h.calls.filter(c=>c.type==='cancelPayment');assert.equal(calls.length,2);assert.ok(calls.every(c=>c.requestId===pending.requestId));
 }finally{h.dom.window.close();}
});
test('old cancellation cannot release a new payment reserved on another device',{concurrency:false},async()=>{
 const h=await harness(s=>{C.execute(s,'openShift',{opening:0});C.execute(s,'addLine',{orderId:'bar',productId:'agnis-2810'});return s;});try{
  h.external('beginPayment',{orderId:'bar',revision:h.server.orders[0].revision});await h.w.POSCloud.refresh();h.click('[data-action="cancelPayment"]');
  const oldToken=h.server.orders[0].paymentLock.token;h.external('cancelPayment',{orderId:'bar',paymentToken:oldToken,terminalChecked:true,reason:'TEST other device'});h.external('beginPayment',{orderId:'bar',revision:h.server.orders[0].revision});
  const before=structuredClone(h.server);h.w.document.querySelector('[name="checked"]').checked=true;h.submit();await until(()=>/Rezervace/.test(h.w.document.querySelector('#dialog-error').textContent),'stale token rejected');
  assert.deepEqual(h.server,before);assert.notEqual(h.server.orders[0].paymentLock.token,oldToken);
 }finally{h.dom.window.close();}
});
test('switching accounts refreshes cancellation controls for the selected reservation without rebuilding products',{concurrency:false},async()=>{
 const h=await harness(s=>{C.execute(s,'openShift',{opening:0});const o=C.execute(s,'newOrder',{name:'TEST Locked Customer'});C.execute(s,'addLine',{orderId:o.id,productId:'agnis-2810'});return s;});try{
  const o=h.server.orders.find(o=>o.name==='TEST Locked Customer');h.external('beginPayment',{orderId:o.id,revision:o.revision});await h.w.POSCloud.refresh();
  const grid=h.w.document.querySelector('#products');assert.equal(h.w.document.querySelector('[data-action="cancelPayment"]'),null);
  h.click('[data-action="account"][data-id="'+o.id+'"]');assert.ok(h.w.document.querySelector('[data-action="cancelPayment"]'));assert.equal(h.w.document.querySelector('#products'),grid);
  h.click('[data-action="account"][data-id="bar"]');assert.equal(h.w.document.querySelector('[data-action="cancelPayment"]'),null);
  h.click('[data-action="account"][data-id="'+o.id+'"]');h.click('[data-action="cancelPayment"]');h.w.document.querySelector('[name="checked"]').checked=true;h.submit();
  await until(()=>!h.w.document.querySelector('#dialog').open,'customer unlocked');assert.equal(h.server.orders.find(x=>x.id===o.id).paymentLock,undefined);assert.equal(h.w.document.querySelector('[data-action="cancelPayment"]'),null);
  assert.equal(h.w.document.querySelector('.receipt-head h2').textContent,o.name);assert.equal(h.server.orders.find(x=>x.id===o.id).lines.length,1);
 }finally{h.dom.window.close();}
});
test('closing card payment offers explicit cancellation; stock and settings screens work',{concurrency:false},async()=>{
  const h=await harness();try{
   h.click('[data-action="openShift"]');h.w.document.querySelector('[name="opening"]').value='0';h.submit();await until(()=>h.server.shifts.length===1&&!h.w.document.querySelector('#dialog').open,'shift opened');
   h.click('.product[data-action="add"]');await until(()=>h.w.document.querySelector('.quantity-tap'),'line');h.click('[data-action="payCard"]');await until(()=>h.w.document.querySelector('[name="cardConfirmed"]'),'payment dialog');
   h.click('.close-dialog');assert.ok(h.server.orders[0].paymentLock);
   assert.equal(h.w.document.querySelector('#dialog-title').textContent,'Zrušit rozpracovanou platbu');h.click('.close-dialog');
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
   h.drop('checkout');h.submit();await until(()=>h.w.POSCloud.pending?.type==='checkout'&&!h.w.POSCloud.busy&&!h.w.document.querySelector('#dialog-submit').disabled,'checkout awaiting recovery');
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
  const restored=sold(server,ids.restored,40);C.execute(server,'restoreReceipt',{receiptId:restored.id,reason:'Test vrácení na stůl'});
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

for(const mode of ['cash','card','split']){
 test('receipt correction '+mode+': opening is neutral; staff attribution never refunds or reopens paid items',{concurrency:false},async()=>{
  const h=await harness(paidCorrectionSeed(mode),'staff');try{
   const before=structuredClone(h.server);h.click('[data-view="history"]');h.click('[data-action="restoreReceipt"]');
   assert.equal(h.calls.length,0);assert.equal(h.w.document.querySelector('[name="correction"]'),null);assert.equal(h.w.document.querySelector('[name="cardConfirmed"]'),null);
   const target=h.server.orders.find(o=>o.name==='Stůl 2');h.w.document.querySelector('[name="targetOrderId"]').value=target.id;
   h.submit();h.submit();await until(()=>!h.w.document.querySelector('#dialog').open&&h.server.audit.at(-1).type==='reassignReceipt','attribution saved');
   assert.equal(h.calls.filter(c=>c.type==='reassignReceipt').length,1);
   assert.deepEqual(h.server.receipts,before.receipts);assert.deepEqual(h.server.orders,before.orders);assert.deepEqual(h.server.shifts,before.shifts);
   assert.match(h.w.document.querySelector('#app').textContent,/Stůl 2/);assert.match(h.w.document.querySelector('#toast').textContent,/Platba zůstává/);
  }finally{h.dom.window.close();}
 });
 test('receipt correction '+mode+': explicit financial action checks terminal and double submit writes only once',{concurrency:false},async()=>{
  const h=await harness(paidCorrectionSeed(mode));try{
   h.click('[data-view="history"]');h.click('[data-action="restoreReceipt"]');
   const form=h.w.document.querySelector('#dialog-form');form.elements.correction.value='restore';form.elements.correction.dispatchEvent(new h.w.Event('change'));
   assert.equal(form.elements.targetOrderId.disabled,true);assert.equal(h.w.document.querySelector('#receipt-reversal').disabled,false);
   form.elements.reason.value='Test vrácení';
   if(h.server.receipts[0].card){
    assert.equal(form.elements.cardConfirmed.required,true);assert.equal(form.elements.terminalReference.required,true);
    h.submit();await until(()=>/terminálu/.test(h.w.document.querySelector('#dialog-error').textContent),'no terminal confirmation rejected');
    assert.equal(h.server.receipts.length,1);form.elements.cardConfirmed.checked=true;
    h.submit();await until(()=>/číslo/.test(h.w.document.querySelector('#dialog-error').textContent),'reference required');
    assert.equal(h.server.receipts.length,1);form.elements.terminalReference.value='TEST-TERM-123';
   }
   h.hold();h.submit();h.submit();await until(()=>h.w.POSCloud.busy,'financial commit held');
   const submitted=h.calls.filter(c=>c.type==='restoreReceipt').length;h.submit();assert.equal(h.calls.filter(c=>c.type==='restoreReceipt').length,submitted);
   h.release();await until(()=>h.server.receipts.length===2&&!h.w.document.querySelector('#dialog').open,'financial restore confirmed');
   assert.equal(h.server.receipts[1].restock,true);assert.equal(h.server.receipts[1].card,-h.server.receipts[0].card);
   assert.equal(h.server.orders.find(o=>o.name==='Stůl 1').lines[0].quantity,3);assert.equal(h.w.document.querySelector('.receipt-head h2').textContent,'Stůl 1');
   assert.match(h.w.document.querySelector('#toast').textContent,/Platba vrácena/);
  }finally{h.dom.window.close();}
 });
}
for(const timing of ['before','after'])for(const type of ['restoreReceipt','reassignReceipt']){
 test(type+' interrupted '+timing+' commit keeps its durable ID and recovers exactly once',{concurrency:false},async()=>{
  const h=await harness(paidCorrectionSeed('split'));try{
   h.click('[data-view="history"]');h.click('[data-action="restoreReceipt"]');const form=h.w.document.querySelector('#dialog-form');
   if(type==='restoreReceipt'){
    form.elements.correction.value='restore';form.elements.correction.dispatchEvent(new h.w.Event('change'));
    form.elements.reason.value='Test';form.elements.cardConfirmed.checked=true;form.elements.terminalReference.value='TEST-TERM-1';
   }else form.elements.targetOrderId.value=h.server.orders.find(o=>o.name==='Stůl 2').id;
   timing==='before'?h.disconnect():h.drop();h.submit();
   await until(()=>h.w.POSCloud.pending&&!h.w.POSCloud.busy,'uncertain correction retained');
   const request=h.w.POSCloud.pending;assert.equal(request.type,type);
   assert.equal(h.server.audit.filter(a=>a.type===type).length,timing==='after'?1:0);
   assert.equal(h.w.document.querySelector('[data-action="restoreReceipt"]').disabled,true);
   h.click('[data-action="retryPending"]');await until(()=>!h.w.POSCloud.pending&&h.server.audit.filter(a=>a.type===type).length===1,'correction recovered');
   assert.equal(h.w.document.querySelector('#dialog').open,false,'recovery closes the old correction dialog');
   const calls=h.calls.filter(c=>c.type===type);assert.equal(calls.length,2);assert.equal(calls[0].requestId,calls[1].requestId);assert.deepEqual(calls[0].payload,calls[1].payload);
   assert.equal(h.server.receipts.length,type==='restoreReceipt'?2:1);
   if(type==='restoreReceipt'){assert.equal(h.w.document.querySelector('.receipt-head h2').textContent,'Stůl 1');assert.equal(h.server.orders.find(o=>o.name==='Stůl 1').lines[0].quantity,3);}
  }finally{h.dom.window.close();}
 });
}
test('wrong full-payment click switches to item split locally with the same reservation and resets stale terminal confirmation',{concurrency:false},async()=>{
 const h=await harness();try{
  await startShift(h);h.click('[data-action="entryCount"][data-id="3"]');h.click('.product[data-action="add"]');await until(()=>h.server.orders[0].lines[0]?.quantity===3,'three marked');
  h.click('[data-action="payCard"]');await until(()=>h.w.document.querySelector('[data-payment-reset]'),'whole card dialog');
  const token=h.server.orders[0].paymentLock.token,calls=h.calls.length;h.w.document.querySelector('[name="cardConfirmed"]').checked=true;
  h.click('[data-payment-reset]');assert.equal(h.calls.length,calls,'splitting is entirely local');assert.equal(h.w.document.querySelector('[name="cardConfirmed"]').checked,false);
  assert.equal(h.w.document.querySelector('.payment-item-count').firstChild.textContent,'0');assert.equal(h.w.document.querySelector('#dialog-submit').disabled,true);
  h.click('.payment-item');h.click('[data-qty="1"]');h.w.document.querySelector('[name="cardConfirmed"]').checked=true;
  h.submit();await until(()=>h.server.receipts.length===1&&!h.w.document.querySelector('#dialog').open,'one piece paid');
  assert.equal(h.server.receipts[0].lines[0].quantity,1);assert.equal(h.server.orders[0].lines[0].quantity,2);
  assert.equal(h.calls.filter(c=>c.type==='beginPayment').length,1);assert.equal(h.calls.find(c=>c.type==='checkout').payload.paymentToken,token);
 }finally{h.dom.window.close();}
});
test('back from a mistaken whole payment permits a direct split without reserving or paying the entire table again',{concurrency:false},async()=>{
 const h=await harness();try{
  await startShift(h);h.click('[data-action="entryCount"][data-id="3"]');h.click('.product[data-action="add"]');await until(()=>h.server.orders[0].lines[0]?.quantity===3,'three marked');
  h.click('[data-action="payCash"]');await until(()=>h.w.document.querySelector('[name="received"]'),'whole cash dialog');
  assert.equal(h.server.orders[0].paymentLock,undefined);h.click('.close-dialog');assert.equal(h.server.receipts.length,0);
  assert.equal(h.w.document.querySelector('[data-action="paySplit"]').disabled,false);h.click('[data-action="paySplit"]');
  await until(()=>h.w.document.querySelector('.payment-item'),'split resume');assert.equal(h.w.document.querySelector('#dialog-title').textContent,'Rozdělit účet');
  h.click('.payment-item');h.click('[data-qty="1"]');h.submit();await until(()=>h.server.receipts.length===1&&!h.w.document.querySelector('#dialog').open,'one piece cash');
  assert.equal(h.server.orders[0].lines[0].quantity,2);assert.equal(h.calls.filter(c=>c.type==='beginPayment').length,1);
  assert.ok(h.calls.find(c=>c.type==='checkout').payload.paymentToken,'confirmation uses a server reservation');
 }finally{h.dom.window.close();}
});
test('a lost reservation response freezes payment until its result is recovered, then allows a direct split',{concurrency:false},async()=>{
 const h=await harness();try{
  await startShift(h);h.click('[data-action="entryCount"][data-id="3"]');h.click('.product[data-action="add"]');await until(()=>h.server.orders[0].lines[0]?.quantity===3,'three marked');
  h.drop();h.click('[data-action="payCard"]');await until(()=>h.w.POSCloud.pending&&!h.w.POSCloud.busy,'lost reservation');
  assert.equal(h.w.document.querySelector('[data-action="paySplit"]').disabled,true);const id=h.w.POSCloud.pending.requestId;
  h.click('[data-action="retryPending"]');await until(()=>!h.w.POSCloud.pending,'reservation recovered');
  h.click('[data-action="paySplit"]');await until(()=>h.w.document.querySelector('.payment-item'),'direct split');
  const reservations=h.calls.filter(c=>c.type==='beginPayment');assert.equal(reservations.length,2);assert.ok(reservations.every(c=>c.requestId===id));assert.equal(h.server.receipts.length,0);
 }finally{h.dom.window.close();}
});

test('customer departure UI freezes the visit while keeping the whole unpaid account',{concurrency:false},async()=>{
 const h=await harness(s=>{C.execute(s,'openShift',{opening:0});const o=C.execute(s,'newOrder',{name:'TEST Visit Customer'});C.execute(s,'addLine',{orderId:o.id,productId:'agnis-2810',quantity:2},new Date(Date.now()-30*60000).toISOString());return s;});try{
  const o=h.server.orders.find(o=>o.name==='TEST Visit Customer'),before=structuredClone(o.lines);
  h.click('[data-action="account"][data-id="'+o.id+'"]');h.click('[data-action="customerProfile"]');
  h.click('[data-action="endVisit"]');assert.match(h.w.document.querySelector('#dialog-body').textContent,/zůstane/);h.submit();
  await until(()=>!h.w.document.querySelector('#dialog').open&&h.server.orders.find(x=>x.id===o.id).visitEndedAt,'departure saved');
  assert.deepEqual(h.server.orders.find(x=>x.id===o.id).lines,before);assert.equal(h.server.receipts.length,0);
  h.click('[data-action="customerProfile"]');assert.match(h.w.document.querySelector('#dialog-body').textContent,/Návštěva je ukončená/);
 }finally{h.dom.window.close();}
});

test('departure form uses latest activity and server rejects an earlier time without changing any account',{concurrency:false},async()=>{
 const activity=new Date(Date.now()-10*60000).toISOString();
 const h=await harness(s=>{C.execute(s,'openShift',{opening:0});const o=C.execute(s,'newOrder',{name:'TEST Departure Guard'});C.execute(s,'addLine',{orderId:o.id,productId:'agnis-2810'},new Date(Date.now()-40*60000).toISOString());C.execute(s,'addLine',{orderId:o.id,productId:'agnis-2810'},activity);return s;});try{
  const o=h.server.orders.find(o=>o.name==='TEST Departure Guard'),before=structuredClone(h.server);
  h.click('[data-action="account"][data-id="'+o.id+'"]');h.click('[data-action="customerProfile"]');h.click('[data-action="endVisit"]');
  const input=h.w.document.querySelector('[name="endedAt"]'),local=at=>{const d=new Date(at);return new Date(d.getTime()-d.getTimezoneOffset()*60000).toISOString().slice(0,23);};
  assert.equal(Date.parse(input.min),Date.parse(activity));
  input.value=local(Date.parse(activity)-1000);h.submit();await until(()=>h.w.document.querySelector('#dialog-error').textContent.includes('aktivit'),'earlier departure rejected');
  assert.deepEqual(h.server,before);assert.equal(h.w.document.querySelector('#dialog').open,true);
  input.value=local(activity);h.submit();await until(()=>!h.w.document.querySelector('#dialog').open,'boundary departure saved');
  assert.equal(h.server.orders.find(x=>x.id===o.id).visitEndedAt,activity);assert.equal(h.server.receipts.length,0);
 }finally{h.dom.window.close();}
});

test('legacy departure form reconstructs activity after the saved end and prefills a valid local time',{concurrency:false},async()=>{
 const activity=new Date(Date.now()-10*60000).toISOString();
 const h=await harness(s=>{C.execute(s,'openShift',{opening:0});const o=C.execute(s,'newOrder',{name:'TEST Legacy Departure'});C.execute(s,'addLine',{orderId:o.id,productId:'agnis-2810'},new Date(Date.now()-40*60000).toISOString());C.execute(s,'addLine',{orderId:o.id,productId:'agnis-2810'},activity);const saved=s.orders.find(x=>x.id===o.id);saved.visitEndedAt=new Date(Date.now()-30*60000).toISOString();delete saved.visitLastActivityAt;for(const e of s.audit)delete e.visitActivity;return s;});try{
  const o=h.server.orders.find(o=>o.name==='TEST Legacy Departure'),before=structuredClone(h.server);
  h.click('[data-action="account"][data-id="'+o.id+'"]');h.click('[data-action="customerProfile"]');h.click('[data-action="endVisit"]');
  const input=h.w.document.querySelector('[name="endedAt"]');assert.equal(Date.parse(input.min),Date.parse(activity));assert.equal(Date.parse(input.value),Date.parse(input.min));
  input.removeAttribute('min');const d=new Date(Date.parse(activity)-1000);input.value=new Date(d.getTime()-d.getTimezoneOffset()*60000).toISOString().slice(0,23);
  h.submit();await until(()=>h.w.document.querySelector('#dialog-error').textContent.includes('aktivit'),'legacy time rejected');assert.deepEqual(h.server,before);
  input.value=input.getAttribute('value');h.submit();await until(()=>!h.w.document.querySelector('#dialog').open,'legacy end corrected');
  assert.equal(h.server.orders.find(x=>x.id===o.id).visitEndedAt,activity);assert.deepEqual(h.server.orders.find(x=>x.id===o.id).lines,o.lines);assert.equal(h.server.receipts.length,0);
 }finally{h.dom.window.close();}
});

for(const timing of ['before','after'])test('credit reversal UI '+timing+' lost response keeps one audited refund and terminal reference',{concurrency:false},async()=>{
 const h=await harness(s=>{C.execute(s,'openShift',{opening:0});const o=C.execute(s,'newOrder',{name:'TEST Credit Customer'});C.execute(s,'creditTopup',{orderId:o.id,amount:50000,method:'card',cardConfirmed:true});return s;});try{
  const order=h.server.orders.find(o=>o.name==='TEST Credit Customer'),entry=h.server.creditLedger[0];
  h.click('[data-action="account"][data-id="'+order.id+'"]');h.click('[data-action="customerProfile"]');h.click('[data-action="creditReverse"]');
  const form=h.w.document.querySelector('#dialog-form');form.elements.reason.value='TEST wrong customer';form.elements.terminalReference.value='TEST-CREDIT-REFUND';h.submit();
  await until(()=>h.w.document.querySelector('#dialog-error').textContent.includes('Potvrď'),'terminal proof required');assert.equal(h.server.creditLedger.length,1);
  form.elements.cardConfirmed.checked=true;if(timing==='before')h.disconnect();else h.drop();h.submit();h.submit();
  await until(()=>h.w.POSCloud.pending&&!h.w.POSCloud.busy,'credit reversal pending');const requestId=h.w.POSCloud.pending.requestId;
  h.click('#dialog .close-dialog');h.click('[data-action="retryPending"]');await until(()=>!h.w.POSCloud.pending&&!h.w.POSCloud.busy,'credit reversal recovered');
  const reversals=h.server.creditLedger.filter(x=>x.reversalOf===entry.id);assert.equal(reversals.length,1);assert.equal(reversals[0].terminalConfirmation.reference,'TEST-CREDIT-REFUND');
  assert.equal(C.creditBalance(h.server,order.customerId),0);assert.equal(h.server.receipts.length,0);assert.equal(C.totals(h.server,C.activeShift(h.server).id).terminal,0);
  assert.equal(h.calls.filter(x=>x.type==='creditReverse'&&x.payload.cardConfirmed===true).every(x=>x.requestId===requestId),true);
 }finally{h.dom.window.close();}
});

test('staff customer profile hides topup reversals and closing UI stops reserved customer payments',{concurrency:false},async()=>{
 const seed=s=>{C.execute(s,'openShift',{opening:0});const o=C.execute(s,'newOrder',{name:'TEST Locked Customer'});C.execute(s,'creditTopup',{orderId:o.id,amount:50000,method:'cash'});C.execute(s,'addLine',{orderId:o.id,productId:'agnis-2810'});o.paymentLock={token:crypto.randomUUID(),actorId:crypto.randomUUID()};return s;};
 const staff=await harness(seed,'staff');try{const o=staff.server.orders.find(o=>o.name==='TEST Locked Customer');staff.click('[data-action="account"][data-id="'+o.id+'"]');staff.click('[data-action="customerProfile"]');assert.equal(staff.w.document.querySelector('[data-action="creditReverse"]'),null);}finally{staff.dom.window.close();}
 const owner=await harness(seed);try{owner.click('[data-view="overview"]');owner.click('[data-action="closeShift"]');assert.match(owner.w.document.querySelector('#toast').textContent,/rozpracované platby/);assert.equal(owner.w.document.querySelector('#dialog').open,false);assert.equal(owner.calls.filter(x=>x.type==='closeShift').length,0);}finally{owner.dom.window.close();}
});

test('card credit funding reserves an empty customer before the terminal and resumes after closing the dialog',{concurrency:false},async()=>{
 const h=await harness(s=>{C.execute(s,'openShift',{opening:0});C.execute(s,'newOrder',{name:'TEST Empty Wallet'});return s;});try{
  const o=h.server.orders.find(o=>o.name==='TEST Empty Wallet');h.click('[data-action="account"][data-id="'+o.id+'"]');h.click('[data-action="customerProfile"]');h.click('[data-action="creditTopup"]');
  let form=h.w.document.querySelector('#dialog-form');form.elements.amount.value='500';form.elements.method.value='card';form.elements.method.dispatchEvent(new h.w.Event('change'));
  assert.equal(h.w.document.querySelector('#topup-card-confirm').hidden,true);assert.equal(o.paymentLock,undefined);h.submit();
  await until(()=>h.server.orders.find(x=>x.id===o.id).paymentLock?.purpose==='creditTopup'&&h.w.document.querySelector('#dialog-submit').textContent==='Připsat kredit','funding prepared');
  assert.equal(h.server.creditLedger.length,0);assert.throws(()=>h.external('closeShift',{counted:0}),/rozpracované platby/);
  h.click('#dialog .close-dialog');h.click('[data-action="checkPayment"]');form=h.w.document.querySelector('#dialog-form');form.elements.checked.checked=true;h.submit();
  await until(()=>!!h.w.document.querySelector('[name="cardConfirmed"]'),'funding resumed');form=h.w.document.querySelector('#dialog-form');form.elements.cardConfirmed.checked=true;h.submit();
  await until(()=>h.server.creditLedger.length===1,'funding recorded');assert.equal(h.server.creditLedger[0].amount,50000);assert.equal(h.server.orders.find(x=>x.id===o.id).paymentLock,undefined);assert.equal(h.server.receipts.length,0);
 }finally{h.dom.window.close();}
});

test('split card confirmation stays hidden until reservation succeeds, while just opening split remains editable',{concurrency:false},async()=>{
 const h=await harness(s=>{C.execute(s,'openShift',{opening:0});const o=C.execute(s,'newOrder',{name:'TEST Card Split'});C.execute(s,'addLine',{orderId:o.id,productId:'agnis-2810',quantity:2});return s;});try{
  const o=h.server.orders.find(o=>o.name==='TEST Card Split');h.click('[data-action="account"][data-id="'+o.id+'"]');h.click('[data-action="paySplit"]');h.click('.payment-item');h.click('[data-qty="1"]');
  assert.equal(h.server.orders.find(x=>x.id===o.id).paymentLock,undefined);h.hold();h.click('[data-payment-mode="card"]');await until(()=>h.w.POSCloud.busy,'preparing card');
  assert.equal(h.w.document.querySelector('#card-confirm-field').hidden,true);assert.equal(h.w.document.querySelector('#dialog-submit').disabled,true);h.release();
  await until(()=>!h.w.document.querySelector('#card-confirm-field').hidden,'card is safe to charge');assert.ok(h.server.orders.find(x=>x.id===o.id).paymentLock);assert.throws(()=>h.external('closeShift',{counted:0}),/rozpracované platby/);
 }finally{h.dom.window.close();}
});
