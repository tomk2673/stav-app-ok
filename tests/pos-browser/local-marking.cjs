'use strict';
// Real Chromium/WebKit, real SDK, real PWA/cache/storage. All remote traffic is fictional.
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),http=require('node:http'),cp=require('node:child_process');
const C=require('../../pub_bizz_pos/core.js'),D=require('../../pub_bizz_pos/server-domain.js'),M=require('../../pub_bizz_pos/marking.js');
const root=path.resolve(__dirname,'../..'),api=fs.readFileSync(path.join(root,'pub_bizz_pos/config.js'),'utf8').match(/url: '([^']+)'/)[1];
const baseRef=process.env.POS_MARKING_BASE_REF||'82d251ac2955bf6dd96b01f03a61155678a0b964';
const before=new Map();
for(const file of cp.execFileSync('git',['ls-tree','-r','--name-only',baseRef,'pub_bizz_pos'],{cwd:root,encoding:'utf8'}).trim().split('\n'))before.set(file,cp.execFileSync('git',['show',baseRef+':'+file],{cwd:root}));
let originOnline=true;
const fixtures=new Map();
const serve=async(req,res)=>{
 if(!originOnline){req.socket.destroy();return;}
 const url=new URL(req.url,'http://127.0.0.1'),parts=decodeURIComponent(url.pathname).split('/').filter(Boolean);
 if(parts[0]==='TEST-api') {
  const f=fixtures.get(parts[1]);if(!f?.networkOnline){req.socket.destroy();return;}
  const cors={'access-control-allow-origin':'*','access-control-allow-headers':req.headers['access-control-request-headers']||'authorization,apikey,content-type','access-control-allow-methods':'GET,POST,OPTIONS'};
  if(req.method==='OPTIONS'){res.writeHead(204,cors);res.end();return;}
  try {
   const chunks=[];for await(const chunk of req)chunks.push(chunk);
   const r=await f.service('/'+parts.slice(2).join('/'),url.searchParams,req.method,chunks.length?JSON.parse(Buffer.concat(chunks).toString()):null);
   res.writeHead(r.status||200,{...cors,'content-type':'application/json','cache-control':'no-store'});res.end(JSON.stringify(r.body));
  }catch{req.socket.destroy();}
  return;
 }
 const [mode,key,...segments]=parts,file=segments.join('/'),absolute=path.resolve(root,file);
 if(!absolute.startsWith(root+path.sep)||!['before','after'].includes(mode)||!fixtures.has(key)){res.writeHead(403);return res.end();}
 try{
  res.setHeader('Content-Type',file.endsWith('.js')?'application/javascript':file.endsWith('.css')?'text/css':file.endsWith('.svg')?'image/svg+xml':'text/html');
  res.setHeader('Content-Security-Policy',`default-src 'self'; script-src 'self'; connect-src 'self' http://127.0.0.1:${apiServer.address().port}; style-src 'self' 'unsafe-inline'; img-src 'self' data:`);
  res.setHeader('Cache-Control','no-cache');
  let data=mode==='before'?before.get(file):fs.readFileSync(absolute);
  if(file==='pub_bizz_pos/config.js')data=Buffer.from(data.toString().replace(api,'http://127.0.0.1:'+apiServer.address().port+'/TEST-api/'+key));
  res.end(data);
 }catch{res.writeHead(404);res.end();}
};
const server=http.createServer(serve),apiServer=http.createServer(serve);
const pause=ms=>new Promise(r=>setTimeout(r,ms));
async function until(page,fn,arg){for(let i=0;i<500;i++){if(await page.evaluate(fn,arg))return;await pause(20);}throw new Error('Timed out '+fn+' '+JSON.stringify(await page.evaluate(()=>({busy:window.POSCloud?.busy,connected:window.POSCloud?.connected,auth:window.POSCloud?.authBlocked,storage:window.POSCloud?.storageError,requests:window.POSCloud?.outbox.map(r=>({id:r.requestId,type:r.type,status:r.local?.status,error:r.local?.error}))}))));}
function fixture(){
 const user={id:crypto.randomUUID(),email:'test@example.test',aud:'authenticated',role:'authenticated',app_metadata:{provider:'email'},user_metadata:{},identities:[]};
 const venue={id:crypto.randomUUID(),organization_id:crypto.randomUUID(),name:'TEST ONLY',currency:'CZK',role:'owner'};
 let state=C.initial();state.venueId=venue.id;C.execute(state,'openShift',{opening:0});const a=C.execute(state,'newOrder',{name:'TEST A'}),b=C.execute(state,'newOrder',{name:'TEST B'});
 const requests=new Map(),calls=[];let drop=false,dropId=null,delay=0;
 const session=()=>{const exp=Math.floor(Date.now()/1000)+3600;return {access_token:[{alg:'HS256',typ:'JWT'},{sub:user.id,aud:'authenticated',role:'authenticated',exp}].map(x=>Buffer.from(JSON.stringify(x)).toString('base64url')).join('.')+'.test',refresh_token:'test-only',token_type:'bearer',expires_at:exp,expires_in:3600,user};};
 const snapshot=result=>({state:structuredClone(state),result,stock:[],issues:[],issueCount:0,role:'owner',venue,markingProtocol:1});
 async function service(pathname,query,method,r){
  const respond=(body,status=200)=>({body,status});
  if(pathname==='/auth/v1/user')return respond(user);
  if(pathname==='/auth/v1/token')return respond(session());
  assert.equal(pathname,'/functions/v1/pub-bizz-pos');
  if(method==='GET')return respond(query.has('venueId')?snapshot(null):{user,venues:[venue]});
  calls.push(r);if(delay)await pause(delay);
  let result=requests.get(r.requestId);
  if(!requests.has(r.requestId)){
   let next;try{const p={...r.payload};if(r.type==='checkout')p.operationId=r.requestId;next=D.run(state,r.type,p,{id:user.id,role:'owner'},[]);}
   catch(e){if(!r.payload.marking)return respond({error:e.message,definitive:true},422);next=M.reject(state,r.type,r.payload,e.message,user.id);}
   state=next.state;result=next.result;requests.set(r.requestId,result);
  }
  if(drop){drop=false;dropId=r.requestId;}if(dropId===r.requestId)throw new Error('Test lost acknowledgment');return respond(snapshot(result));
 }
 return {key:crypto.randomUUID(),networkOnline:true,user,venue,a:a.id,b:b.id,calls,requests,session,service,get state(){return state;},set delay(ms){delay=ms;},drop(){drop=true;},resume(){dropId=null;drop=false;},external(type,p){state=D.run(state,type,p,{id:user.id,role:'owner'},[]).state;}};
}
async function open(browser,base,mode,width,f=fixture(),pwa=false){
 const context=await browser.newContext({viewport:{width,height:850},serviceWorkers:pwa?'allow':'block'});fixtures.set(f.key,f);
 await context.addInitScript(session=>localStorage.setItem('sb-127-auth-token',JSON.stringify(session)),f.session());
 await context.route('**/*',route=>{const u=new URL(route.request().url());return u.hostname==='127.0.0.1'?route.continue():route.abort();});
 const page=await context.newPage(),errors=[];page.on('pageerror',e=>errors.push(e.message));
 await page.goto(base+'/'+mode+'/'+f.key+'/pub_bizz_pos/index.html');await page.locator('.product').first().waitFor();
 return {context,page,f,errors,async offline(value){if(pwa&&browser.browserType().name()==='webkit'){originOnline=!value;f.networkOnline=!value;}else await context.setOffline(value);await page.evaluate(v=>window.dispatchEvent(new Event(v?'offline':'online')),value);},async settled(){await until(page,()=>!POSCloud.pending&&!POSCloud.busy);},async close(){originOnline=true;f.networkOnline=true;assert.deepEqual(errors,[]);await context.close();}};
}
async function paint(page){return page.evaluate(async()=>{
 const q=Number(document.querySelector('.quantity-tap')?.textContent.replace('×','')||0),start=performance.now();
 const ready=()=>Number(document.querySelector('.quantity-tap')?.textContent.replace('×','')||0)===q+1;
 const done=new Promise(resolve=>{const observer=new MutationObserver(()=>{if(ready()){observer.disconnect();requestAnimationFrame(()=>requestAnimationFrame(()=>resolve(performance.now()-start)));}});observer.observe(document.querySelector('#app'),{childList:true,subtree:true,characterData:true});});
 document.querySelector('.product[data-id="agnis-2810"]').click();return done;
});}
async function benchmark(browser,base,width){
 const result={engine:browser.browserType().name(),width,delayMs:600,before:[],after:[],touches:{one:{before:1,after:1},five:{before:2,after:2},twelve:{}}};
 for(const mode of ['before','after']){
  const h=await open(browser,base,mode,width);try{
   h.f.delay=600;
   for(let i=0;i<6;i++){result[mode].push(await paint(h.page));await h.settled();}
   let five=0;await h.page.locator('[data-action="entryCount"][data-id="5"]').click();five++;await h.page.locator('.product[data-id="agnis-2810"]').click();five++;await h.settled();result.touches.five[mode]=five;
   let touches=0;await h.page.locator('[data-action="entryQuantity"]').click();touches++;
   if(await h.page.locator('.qty-quick').isVisible()){await h.page.locator('[data-qty-more]').click();touches++;}
   for(const n of [1,2]){await h.page.locator('[data-qty-digit="'+n+'"]').click();touches++;}
   await h.page.locator('[data-qty-confirm]').click();touches++;await h.page.locator('.product[data-id="agnis-2810"]').click();touches++;await h.settled();
   result.touches.twelve[mode]=touches;assert.equal(h.f.state.orders[0].lines[0].quantity,23);
  }finally{await h.close();}
 }
 return result;
}
async function resilience(browser,base){
 const h=await open(browser,base,'after',390,fixture(),true);try{
  const {page,f}=h;await page.locator('#account-search').fill('TEST A');await page.locator('#account-results [data-id="'+f.a+'"]').click();
  await page.evaluate(async()=>{await navigator.serviceWorker.ready;});await until(page,()=>!!navigator.serviceWorker.controller);
  await h.offline(true);await page.locator('[data-action="smallShot"]').click();
  for(let i=0;i<10;i++)await page.locator('.product[data-id="agnis-2810"]').click();
  const ids=await page.evaluate(()=>POSCloud.outbox.map(r=>r.requestId));assert.equal(ids.length,10);assert.equal(f.calls.length,0);
  assert.equal(await page.locator('[data-action="payCash"]').isDisabled(),true);
  await page.reload();await page.locator('.quantity-tap').waitFor();assert.equal(await page.locator('.quantity-tap').textContent(),'10×');assert.equal(await page.locator('.receipt-head h2').textContent(),'TEST A');
  assert.deepEqual(await page.evaluate(()=>POSCloud.outbox.map(r=>r.requestId)),ids);
  await h.offline(false);await h.settled();assert.equal(f.state.orders.find(o=>o.id===f.a).lines[0].quantity,10);assert.equal(f.state.orders.find(o=>o.id===f.a).lines[0].servingMl,20);
  f.drop();await page.locator('.product[data-id="agnis-2810"]').click();await until(page,()=>POSCloud.pending&&!POSCloud.busy);
  const pending=await page.evaluate(()=>POSCloud.pending.requestId);f.resume();await page.reload();await page.locator('.product').first().waitFor();await h.settled();
  assert.ok(f.calls.filter(r=>r.requestId===pending).length>=2);assert.equal(f.state.audit.filter(a=>a.detail?.marking?.operationId===pending).length,1);assert.equal(f.state.orders.find(o=>o.id===f.a).lines.reduce((n,l)=>n+l.quantity,0),11);
  const target=page.locator('.product[data-id="agnis-2810"]'),before=await target.boundingBox();f.delay=600;
  const burst=await page.evaluate(async()=>{const button=document.querySelector('.product[data-id="agnis-2810"]'),start=performance.now();for(let i=0;i<20;i++)button.click();await new Promise(r=>setTimeout(r,0));return {ms:performance.now()-start,pending:POSCloud.outbox.length};});
  assert.equal(burst.pending,20);const after=await target.boundingBox();assert.equal(after.x,before.x);assert.equal(after.y,before.y,'pending status never moves product buttons');
  f.delay=0;await h.settled();assert.equal(f.state.orders.find(o=>o.id===f.a).lines.reduce((n,l)=>n+l.quantity,0),31);
  await h.offline(true);await target.click();f.external('renameOrder',{orderId:f.a,revision:f.state.orders.find(o=>o.id===f.a).revision,name:'TEST renamed'});
  await h.offline(false);await until(page,()=>POSCloud.outbox.some(r=>r.local.status==='blocked'));
  assert.equal(f.state.orders.find(o=>o.id===f.a).lines.reduce((n,l)=>n+l.quantity,0),31);await page.locator('[data-action="syncDetails"]').click();assert.match(await page.locator('.sync-list').textContent(),/TEST A/);
  if(process.env.POS_MARKING_SCREENSHOTS){fs.mkdirSync(process.env.POS_MARKING_SCREENSHOTS,{recursive:true});await page.screenshot({path:path.join(process.env.POS_MARKING_SCREENSHOTS,browser.browserType().name()+'-conflict.png')});}
  await page.locator('[data-action="dismissMarking"]').click();assert.equal(f.state.receipts.length,0);assert.equal(f.state.stockIssues.length,0);
  return {offlineReload:true,originalHost:true,smallShots:true,lostAck:true,stableButtons:true,rapidTaps:20,burstMs:burst.ms,conflict:true,realPaymentsUsed:false};
 }finally{await h.close();}
}
async function twoDevices(browser,base){
 const f=fixture(),a=await open(browser,base,'after',390,f),b=await open(browser,base,'after',1440,f);
 try{
  for(const h of [a,b]){await h.page.locator('#account-search').fill('TEST A');await h.page.locator('#account-results [data-id="'+f.a+'"]').click();await h.offline(true);}
  await a.page.locator('[data-action="entryCount"][data-id="2"]').click();await b.page.locator('[data-action="entryCount"][data-id="3"]').click();
  await a.page.locator('.product[data-id="agnis-2810"]').click();await b.page.locator('.product[data-id="agnis-2810"]').click();
  await a.offline(false);await b.offline(false);await a.settled();await b.settled();
  const o=f.state.orders.find(o=>o.id===f.a);assert.equal(o.lines.length,1);assert.equal(o.lines[0].quantity,5);assert.equal(f.requests.size,2);
  return {phoneAndPC:true,expectedPieces:5,actualPieces:o.lines[0].quantity};
 }finally{await a.close();await b.close();}
}
async function largeHistory(browser,base){
 const f=fixture();
 for(let i=0;i<6000;i++){f.state.audit.push({id:crypto.randomUUID(),type:'backup',at:new Date().toISOString(),orderId:null,detail:{test:'x'.repeat(450)}});f.state.revision++;}
 const h=await open(browser,base,'after',390,f);try{
  const bytes=JSON.stringify(f.state).length;assert.ok(bytes>3000000);f.delay=600;
  const paintMs=await paint(h.page);await h.settled();
  assert.equal(f.state.orders[0].lines[0].quantity,1);
  const storageMax=await h.page.evaluate(()=>Math.max(...Object.values(localStorage).map(v=>v.length)));assert.ok(storageMax<20000,'large confirmed history must never consume localStorage journal space');
  return {snapshotCharacters:bytes,paintMs,localStorageMaxCharacters:storageMax,confirmedInIndexedDB:true};
 }finally{await h.close();}
}
(async()=>{
 await Promise.all([new Promise(r=>server.listen(0,'127.0.0.1',r)),new Promise(r=>apiServer.listen(0,'127.0.0.1',r))]);const base='http://127.0.0.1:'+server.address().port,results=[];
 try{
  for(const engine of (process.env.POS_MARKING_ENGINES||'chromium,webkit').split(',')){
   const browser=await require('pwmodern')[engine].launch({headless:true});try{
    for(const width of (process.env.POS_MARKING_ONLY_CHECKS?[]:[390,900,1440])){const r=await benchmark(browser,base,width);results.push(r);console.log(JSON.stringify(r));}
    const checks={engine,resilience:await resilience(browser,base),concurrency:await twoDevices(browser,base),largeHistory:await largeHistory(browser,base)};results.push(checks);console.log(JSON.stringify(checks));
   }finally{await browser.close();}
  }
  if(process.env.POS_MARKING_RESULTS)fs.writeFileSync(process.env.POS_MARKING_RESULTS,JSON.stringify({baseRef,environment:process.platform,delayMs:600,results},null,2)+'\n');
 }finally{await Promise.all([new Promise(r=>server.close(r)),new Promise(r=>apiServer.close(r))]);}
})().catch(e=>{console.error(e);process.exitCode=1;});
