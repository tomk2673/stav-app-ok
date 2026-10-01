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
async function harness(){
  const html=fs.readFileSync(path.join(root,'index.html'),'utf8');
  const dom=new JSDOM(html,{url:'https://pos.test/pub_bizz_pos/index.html',runScripts:'outside-only',pretendToBeVisual:true});
  const w=dom.window,venue={id:crypto.randomUUID(),organization_id:crypto.randomUUID(),name:'Test venue',currency:'CZK',role:'owner'},user={id:crypto.randomUUID(),email:'owner@example.test'};
  let server=C.initial();server.venueId=venue.id;server.recipes={};
  const requests=new Map(),calls=[];let dropNext=false;
  w.structuredClone=structuredClone;w.TextEncoder=TextEncoder;w.AbortController=AbortController;
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
   await until(()=>h.w.document.querySelector('.quantity-select')?.value==='1','first line');
   h.drop();h.click('.product[data-action="add"]');
   await until(()=>h.w.POSCloud.pending&&!h.w.POSCloud.busy,'uncertain operation retained');
   assert.equal(h.server.orders[0].lines[0].quantity,2);
   assert.equal(h.w.document.querySelector('#sync-warning').hidden,false);
   h.click('[data-action="retryPending"]');
   await until(()=>!h.w.POSCloud.pending&&h.w.document.querySelector('.quantity-select')?.value==='2','same operation recovered');
   assert.equal(h.server.orders[0].lines[0].quantity,2);
   const additions=h.calls.filter(x=>x.type==='addLine');assert.equal(additions[1].requestId,additions[2].requestId);
   h.click('[data-action="payCash"]');
   await until(()=>h.w.document.querySelector('[name="received"]'),'payment dialog');
   assert.ok(h.server.orders[0].paymentLock,'reserved before terminal/cash prompt');
   h.submit();await until(()=>h.server.receipts.length===1&&!h.server.orders[0].lines.length,'paid');
   await until(()=>h.w.document.querySelector('#dialog-title').textContent==='Zaplaceno','receipt acknowledgement');
   assert.equal(h.server.orders[0].paymentLock,undefined);
   assert.match(h.w.document.querySelector('#save-state').textContent,/Potvrzeno/);
  }finally{h.dom.window.close();}
});
test('closing payment dialog preserves reservation for explicit recovery; stock and settings screens work',{concurrency:false},async()=>{
  const h=await harness();try{
   h.click('[data-action="openShift"]');h.w.document.querySelector('[name="opening"]').value='0';h.submit();await until(()=>h.server.shifts.length===1&&!h.w.document.querySelector('#dialog').open,'shift opened');
   h.click('.product[data-action="add"]');await until(()=>h.w.document.querySelector('.quantity-select'),'line');h.click('[data-action="payCard"]');await until(()=>h.w.document.querySelector('[name="cardConfirmed"]'),'payment dialog');
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
   h.click('.product[data-action="add"]');await until(()=>h.w.document.querySelector('.quantity-select')?.value==='1','item '+name);
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
   assert.equal(h.w.document.querySelector('.quantity-select').value,'2');
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

