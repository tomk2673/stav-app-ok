'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
const {JSDOM}=require('jsdom');
const {IDBFactory}=require('fake-indexeddb');
const C=require('../../pub_bizz_pos/core.js'),D=require('../../pub_bizz_pos/server-domain.js'),M=require('../../pub_bizz_pos/marking.js');
const root=path.resolve(__dirname,'../../pub_bizz_pos'),pause=ms=>new Promise(r=>setTimeout(r,ms));
async function until(predicate,label){for(let i=0;i<400;i++){if(await predicate())return;await pause(5);}throw new Error('Timed out: '+label);}
function fixture(){
 const user={id:crypto.randomUUID(),email:'test@example.test'},venue={id:crypto.randomUUID(),organization_id:crypto.randomUUID(),role:'owner',currency:'CZK',name:'TEST ONLY'};
 let state=C.initial();state.venueId=venue.id;C.execute(state,'openShift',{opening:0});const a=C.execute(state,'newOrder',{name:'Test A'}),b=C.execute(state,'newOrder',{name:'Test B'});
 const ledger=new Map(),calls=[];let drop=false,gate,releaseGate,quota=false;
 const envelope=result=>({state:structuredClone(state),result,stock:[],issues:[],issueCount:0,venue,role:'owner',markingProtocol:1});
 async function fetch(url,init){
  if(quota)return {ok:false,status:402,json:async()=>({message:'Service restricted: exceed_egress_quota'})};
  if(init.method==='GET'){
   const query=new URL(url).searchParams;
   if(query.has('requestId'))return {ok:true,status:200,json:async()=>({committed:ledger.has(query.get('requestId'))})};
   return {ok:true,status:200,json:async()=>query.has('venueId')?envelope(null):{user,venues:[venue]}};
  }
  const r=JSON.parse(init.body);calls.push(r);if(gate)await gate;
  let result=ledger.get(r.requestId);
  if(!ledger.has(r.requestId)){
   let next;
   try{const p={...r.payload};if(r.type==='checkout')p.operationId=r.requestId;next=D.run(state,r.type,p,{id:user.id,role:'owner'},[]);}
   catch(e){if(!r.payload.marking)return {ok:false,status:422,json:async()=>({definitive:true,error:e.message})};next=M.reject(state,r.type,r.payload,e.message,user.id);}
   state=next.state;result=next.result;ledger.set(r.requestId,result);
  }
  if(drop){drop=false;throw new TypeError('Lost acknowledgment after commit');}
  const response=envelope(result);return {ok:true,status:200,json:async()=>response};
 }
 return {user,venue,a:a.id,b:b.id,calls,ledger,fetch,get state(){return state;},quota(value){quota=value;},external(type,p){state=D.run(state,type,p,{id:user.id,role:'owner'},[]).state;},drop(){drop=true;},hold(){gate=new Promise(r=>releaseGate=r);},release(){gate=null;releaseGate?.();}};
}
function storage(){
 const data=new Map(),windows=new Set();let fail=false;
 return {data,windows,idb:new IDBFactory(),set fail(value){fail=value;},forWindow(w){return {
  get length(){return data.size;},key:i=>[...data.keys()][i]||null,getItem:k=>data.get(k)??null,
  setItem(k,v){if(fail)throw new Error('QuotaExceededError');data.set(k,String(v));for(const other of windows)if(other!==w)setTimeout(()=>other.dispatchEvent(new other.StorageEvent('storage',{key:k})),0);},
  removeItem(k){data.delete(k);for(const other of windows)if(other!==w)setTimeout(()=>other.dispatchEvent(new other.StorageEvent('storage',{key:k})),0);}
 };}};
}
async function harness(server=fixture(),disk=storage(),offline=false,localMarking=true){
 const dom=new JSDOM(fs.readFileSync(path.join(root,'index.html'),'utf8'),{url:'https://pos.test/pub_bizz_pos/index.html',runScripts:'outside-only',pretendToBeVisual:true});
 const w=dom.window;disk.windows.add(w);let network=!offline;
 Object.defineProperty(w,'localStorage',{value:disk.forWindow(w)});Object.defineProperty(w.navigator,'onLine',{get:()=>network});
 w.indexedDB=disk.idb;w.structuredClone=structuredClone;w.TextEncoder=TextEncoder;w.HTMLElement.prototype.scrollIntoView=()=>{};
 w.HTMLDialogElement.prototype.showModal=function(){this.setAttribute('open','');};w.HTMLDialogElement.prototype.close=function(){this.removeAttribute('open');};
 w.supabase={createClient:()=>({auth:{getSession:async()=>({data:{session:{access_token:'test-only',user:server.user}}}),refreshSession:async()=>({data:{session:null},error:true})}})};
 w.fetch=(...args)=>network?server.fetch(...args):Promise.reject(new TypeError('Offline'));
 for(const file of ['catalog.js','core.js','marking.js','sync.js','customer.js','storage.js','config.js','cloud.js','stock.js','app.js']){w.eval(fs.readFileSync(path.join(root,file),'utf8'));if(file==='config.js')w.POS_CONFIG=Object.freeze({...w.POS_CONFIG,localMarking});}
 await until(()=>w.document.querySelector('.product'),'boot');
 const click=s=>{const el=w.document.querySelector(s);assert.ok(el,'Missing '+s);assert.equal(el.disabled,false,'Disabled '+s);el.click();};
 return {w,dom,server,disk,click,async select(id){click('[data-action="account"][data-id="'+id+'"]');await pause(0);},
  async add(id='agnis-2810'){click('.product[data-id="'+id+'"]');await pause(0);},
  network(value){network=value;w.dispatchEvent(new w.Event(value?'online':'offline'));},
  close(){disk.windows.delete(w);w.close();},async settled(){await until(()=>!w.POSCloud.pending&&!w.POSCloud.busy,'outbox drained');},
  async quantity(id){return (await w.POSStore.read()).orders.find(o=>o.id===id).lines.reduce((n,l)=>n+l.quantity,0);}};
}
test('20 offline taps persist immediately under the original host; reload restores host, portions and edits; reconnect sends exactly once',async()=>{
 const server=fixture(),disk=storage();let h=await harness(server,disk);
 try{
  await h.select(server.a);h.network(false);h.click('[data-action="smallShot"]');h.click('[data-action="entryCount"][data-id="5"]');
  for(let i=0;i<20;i++)await h.add();
  assert.equal(await h.quantity(server.a),24);assert.equal(server.calls.length,0);assert.equal(h.w.POSCloud.outbox.length,20);
  assert.equal(new Set(h.w.POSCloud.outbox.map(r=>r.requestId)).size,20);
  assert.equal(h.w.document.querySelector('[data-action="payCash"]').disabled,true);
  assert.match(h.w.document.querySelector('#sync-warning').textContent,/20 změn/);assert.ok(h.w.document.querySelector('.line-pending'));
  const line=(await h.w.POSStore.read()).orders.find(o=>o.id===server.a).lines[0];
  await h.w.POSStore.command('setLineQuantity',{orderId:server.a,lineId:line.id,quantity:10});
  await h.w.POSStore.command('removeLine',{orderId:server.a,lineId:line.id,reason:'Test correction'});
  await assert.rejects(h.w.POSStore.command('checkout',{}),/počkej|ověř/);
  const ids=h.w.POSCloud.outbox.map(r=>r.requestId);h.close();h=await harness(server,disk,true);
  assert.equal(h.w.document.querySelector('.receipt-head h2').textContent,'Test A');assert.equal(await h.quantity(server.a),9);
  assert.equal(JSON.stringify(h.w.POSCloud.outbox.map(r=>r.requestId)),JSON.stringify(ids));
  h.network(true);await h.settled();
  const o=server.state.orders.find(o=>o.id===server.a);assert.equal(o.lines[0].quantity,9);assert.equal(o.lines[0].servingMl,20);assert.equal(o.lines[0].price,2750);
  assert.equal(server.state.orders.find(o=>o.id===server.b).lines.length,0);assert.equal(server.state.orders[0].lines.length,0);
  assert.equal(server.ledger.size,22);assert.equal(server.state.receipts.length,0);assert.equal(server.state.stockIssues.length,0);
 }finally{h.close();}
});
test('lost acknowledgment followed by reload reuses UUIDs, suppresses confirmed overlays and preserves all later additions',async()=>{
 const server=fixture(),disk=storage();let h=await harness(server,disk);
 try{
  await h.select(server.a);server.drop();await h.add();
  await until(()=>!h.w.POSCloud.busy&&server.ledger.size===1,'lost reply');
  h.network(false);await h.add();const ids=h.w.POSCloud.outbox.map(r=>r.requestId);
  assert.equal(await h.quantity(server.a),2);h.close();h=await harness(server,disk);await h.settled();
  assert.equal(await h.quantity(server.a),2);assert.equal(server.state.orders.find(o=>o.id===server.a).lines[0].quantity,2);
  assert.equal(server.state.audit.filter(a=>a.type==='addLine').length,2);
  assert.ok(ids.every(id=>server.ledger.has(id)));assert.equal(server.calls.filter(r=>r.requestId===ids[0]).length,2);
 }finally{h.close();}
});
test('concurrent phone and PC additions converge; a stale absolute edit becomes a durable conflict',async()=>{
 const server=fixture(),phone=await harness(server),pc=await harness(server);
 try{
  await phone.select(server.a);await pc.select(server.a);phone.network(false);pc.network(false);
  phone.click('[data-action="entryCount"][data-id="2"]');pc.click('[data-action="entryCount"][data-id="3"]');await phone.add();await pc.add();
  phone.network(true);await phone.settled();pc.network(true);await pc.settled();await phone.w.POSCloud.refresh();
  assert.equal(await phone.quantity(server.a),5);assert.equal(await pc.quantity(server.a),5);
  phone.network(false);const line=(await phone.w.POSStore.read()).orders.find(o=>o.id===server.a).lines[0];
  await phone.w.POSStore.command('setLineQuantity',{orderId:server.a,lineId:line.id,quantity:8});
  await pc.add();await pc.settled();assert.equal(server.state.orders.find(o=>o.id===server.a).lines[0].quantity,6);
  phone.network(true);await until(()=>phone.w.POSCloud.outbox[0]?.local.status==='blocked','stale quantity rejected');
  assert.equal(server.state.orders.find(o=>o.id===server.a).lines[0].quantity,6);assert.equal(await phone.quantity(server.a),6);
  const r=phone.w.POSCloud.outbox[0];assert.match(r.local.error,/jiné zařízení/);assert.equal(server.ledger.get(r.requestId).type,'markingRejected');
  phone.w.POSCloud.dismiss(r.requestId);assert.equal(phone.w.POSCloud.pending,null);
 }finally{phone.close();pc.close();}
});
test('offline add after another device renamed the account remains attached to its original host in conflict review',async()=>{
 const server=fixture(),disk=storage();let h=await harness(server,disk);
 try{
  await h.select(server.a);h.network(false);await h.add();const id=h.w.POSCloud.pending.requestId;
  server.external('renameOrder',{orderId:server.a,revision:0,name:'Another test guest'});
  h.network(true);await until(()=>h.w.POSCloud.pending?.local.status==='blocked','renamed account conflict');
  await until(()=>h.w.document.querySelector('#account-search').value==='Another test guest','selected account label follows the server');
  assert.equal(server.state.orders.find(o=>o.id===server.a).lines.length,0);h.click('[data-action="syncDetails"]');
  assert.match(h.w.document.querySelector('.sync-list').textContent,/Test A/);
  h.close();h=await harness(server,disk);assert.equal(h.w.POSCloud.pending.requestId,id);
  assert.equal(h.w.POSCloud.pending.local.status,'blocked');h.w.POSCloud.dismiss(id);
  assert.equal(h.w.POSCloud.pending,null);assert.equal(server.ledger.get(id).type,'markingRejected');
 }finally{h.close();}
});
test('same-origin tabs share an immutable journal and duplicate delivery is deduplicated by UUID',async()=>{
 const server=fixture(),disk=storage(),a=await harness(server,disk),b=await harness(server,disk);
 try{
  await a.select(server.a);await b.select(server.b);a.network(false);b.network(false);await a.add();await b.add();
  await until(()=>a.w.POSCloud.outbox.length===2&&b.w.POSCloud.outbox.length===2,'shared journal');
  a.network(true);b.network(true);await a.settled();await b.settled();
  assert.equal(server.state.orders.find(o=>o.id===server.a).lines[0].quantity,1);assert.equal(server.state.orders.find(o=>o.id===server.b).lines[0].quantity,1);
  assert.equal(server.ledger.size,2);assert.equal(server.state.audit.filter(a=>a.type==='addLine').length,2);
 }finally{a.close();b.close();}
});
test('storage exhaustion refuses the local change and sends nothing',async()=>{
 const h=await harness();try{
  h.network(false);const before=await h.quantity('bar');h.disk.fail=true;
  await assert.rejects(h.w.POSStore.command('addLine',{orderId:'bar',productId:'agnis-2810'}),/místo/);
  assert.equal(await h.quantity('bar'),before);assert.equal(h.server.calls.length,0);assert.equal(h.w.POSCloud.pending,null);
  assert.match(h.w.POSCloud.storageError,/místo/);
 }finally{h.close();}
});
test('a failed durable account selection keeps the visible and actual target on the original guest',async()=>{
 const h=await harness();try{
  await h.select(h.server.a);h.network(false);h.disk.fail=true;
  assert.throws(()=>h.w.POSCloud.selectOrder(h.server.b),/původní host/);
  h.click('[data-action="account"][data-id="'+h.server.b+'"]');await pause(0);
  assert.equal(h.w.document.querySelector('.receipt-head h2').textContent,'Test A');
  assert.equal(h.w.POSCloud.selectedOrder,h.server.a);assert.equal(h.server.calls.length,0);
 }finally{h.close();}
});
test('an older strict journal is recovered before marking even when its timestamp sorts after the local intent',async()=>{
 const h=await harness();try{
  h.network(false);await h.add();const strictId=crypto.randomUUID();
  h.w.localStorage.setItem('pub-bizz-cloud-pending:'+h.server.venue.id+':'+h.server.user.id+':'+strictId,JSON.stringify({venueId:h.server.venue.id,requestId:strictId,type:'backup',payload:{},sentAt:new Date(Date.now()+10000).toISOString()}));
  assert.equal(h.w.POSCloud.pending.requestId,strictId);
  h.network(true);await h.w.POSCloud.retry();await h.settled();
  assert.equal(h.server.state.orders[0].lines[0].quantity,1);assert.equal(h.server.ledger.size,2);
 }finally{h.close();}
});
test('a held server never blocks repeated local additions, count reset or switching the target guest',async()=>{
 const server=fixture(),h=await harness(server);
 try{
  server.hold();await h.select(server.a);h.click('[data-action="entryCount"][data-id="3"]');await h.add();
  await until(()=>h.w.POSCloud.busy,'held HTTP');for(let i=0;i<5;i++)await h.add();
  await h.select(server.b);await h.add();assert.equal(await h.quantity(server.a),8);assert.equal(await h.quantity(server.b),1);
  assert.equal(h.w.document.querySelector('#entry-quantity').textContent,'1×');assert.equal(server.state.orders.find(o=>o.id===server.a).lines.length,0);
  server.release();await h.settled();assert.equal(server.state.orders.find(o=>o.id===server.a).lines[0].quantity,8);assert.equal(server.state.orders.find(o=>o.id===server.b).lines[0].quantity,1);
 }finally{server.release();h.close();}
});
test('disabling new optimistic entries preserves and drains the existing journal without deleting data',async()=>{
 const server=fixture(),disk=storage();let h=await harness(server,disk);
 try{
  await h.select(server.a);h.network(false);await h.add();const id=h.w.POSCloud.pending.requestId;h.close();
  h=await harness(server,disk,true,false);assert.equal(h.w.POSCloud.optimisticMarking,false);
  assert.equal(h.w.POSCloud.pending.requestId,id);assert.equal(await h.quantity(server.a),1);
  await assert.rejects(h.w.POSStore.command('addLine',{orderId:server.a,productId:'agnis-2810'}),/počkej|ověř/);
  h.network(true);await h.settled();assert.equal(server.state.orders.find(o=>o.id===server.a).lines[0].quantity,1);
  server.hold();const command=h.w.POSStore.command('addLine',{orderId:server.a,productId:'agnis-2810'});await until(()=>h.w.POSCloud.busy,'strict online fallback');
  assert.equal(await h.quantity(server.a),1);server.release();await command;assert.equal(await h.quantity(server.a),2);
 }finally{server.release();h.close();}
});
test('merge persists its actual destination and offline reload restores the displayed account',async()=>{
 const server=fixture(),disk=storage();let h=await harness(server,disk);
 try{
  await h.select(server.a);await h.add();await h.settled();h.click('[data-action="mergeOrders"]');
  h.w.document.querySelector('[name="targetOrderId"]').value=server.b;
  h.w.document.querySelector('#dialog-form').dispatchEvent(new h.w.Event('submit',{bubbles:true,cancelable:true}));
  await until(()=>h.w.POSCloud.selectedOrder===server.b&&h.w.document.querySelector('.receipt-head h2').textContent==='Test B','merged destination saved');
  h.close();h=await harness(server,disk,true);assert.equal(h.w.document.querySelector('.receipt-head h2').textContent,'Test B');assert.equal(await h.quantity(server.b),1);
  assert.equal(server.state.orders.find(o=>o.id===server.a).lines.length,0);
 }finally{h.close();}
});
test('egress quota restriction remains visible and retains the exact local UUID until service returns',async()=>{
 const h=await harness();try{
  h.server.quota(true);await h.add();await until(()=>h.w.POSCloud.serviceError&&!h.w.POSCloud.busy,'quota visible');
  const id=h.w.POSCloud.pending.requestId;assert.equal(await h.quantity('bar'),1);assert.equal(h.server.state.orders[0].lines.length,0);
  assert.match(h.w.document.querySelector('#sync-warning').textContent,/datovému limitu/);
  h.server.quota(false);await h.w.POSCloud.retry();await h.settled();assert.equal(h.server.state.orders[0].lines[0].quantity,1);assert.ok(h.server.ledger.has(id));
 }finally{h.close();}
});
test('unchanged polling preserves the Settings form and unsaved input even with an older full-snapshot server',async()=>{
 const h=await harness();try{
  h.click('[data-view="settings"]');const form=h.w.document.querySelector('#settings-form'),input=form.querySelector('input');input.value='TEST unsaved settings';
  const view=await h.w.POSStore.read();for(let i=0;i<3;i++)await h.w.POSCloud.refresh();
  assert.equal(await h.w.POSStore.read(),view);assert.equal(h.w.document.querySelector('#settings-form'),form);assert.equal(input.value,'TEST unsaved settings');
 }finally{h.close();}
});
