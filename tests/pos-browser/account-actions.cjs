'use strict';
// Real layout, touches, SDK and local journal. Every server response uses fictional data.
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),http=require('node:http');
const {chromium,webkit}=require('pwmodern'),C=require('../../pub_bizz_pos/core.js'),D=require('../../pub_bizz_pos/server-domain.js'),M=require('../../pub_bizz_pos/marking.js');
const root=path.resolve(__dirname,'../..'),api=fs.readFileSync(path.join(root,'pub_bizz_pos/config.js'),'utf8').match(/url: '([^']+)'/)[1];
const pause=ms=>new Promise(r=>setTimeout(r,ms));
const server=http.createServer((req,res)=>{
 const file=path.resolve(root,'.'+new URL(req.url,'http://test').pathname);if(!file.startsWith(root+path.sep)){res.writeHead(403);return res.end();}
 try{res.setHeader('Content-Type',file.endsWith('.js')?'application/javascript':file.endsWith('.css')?'text/css':file.endsWith('.svg')?'image/svg+xml':'text/html');res.end(fs.readFileSync(file));}catch{res.writeHead(404);res.end();}
});
function fixture(){
 const user={id:crypto.randomUUID(),email:'test@example.test',aud:'authenticated',role:'authenticated',app_metadata:{provider:'email'},user_metadata:{},identities:[]},venue={id:crypto.randomUUID(),organization_id:crypto.randomUUID(),name:'TEST ONLY',currency:'CZK',role:'owner'};
 let state=C.initial();state.venueId=venue.id;C.execute(state,'openShift',{opening:0});const a=C.execute(state,'newOrder',{name:'Test A'}).id,b=C.execute(state,'newOrder',{name:'Test B'}).id;
 const ledger=new Map(),calls=[];const session=()=>{const exp=Math.floor(Date.now()/1000)+3600;return {access_token:[{alg:'HS256',typ:'JWT'},{sub:user.id,aud:'authenticated',role:'authenticated',exp}].map(x=>Buffer.from(JSON.stringify(x)).toString('base64url')).join('.')+'.test',refresh_token:'test-only',token_type:'bearer',expires_at:exp,expires_in:3600,user};};
 const envelope=result=>({state:structuredClone(state),result,stock:[],issues:[],issueCount:0,role:'owner',venue,markingProtocol:1,accountActionsProtocol:1});
 async function route(route){
  const req=route.request(),url=new URL(req.url()),headers={'access-control-allow-origin':'*','access-control-allow-headers':req.headers()['access-control-request-headers']||'*','access-control-allow-methods':'GET,POST,OPTIONS','content-type':'application/json'};
  const reply=(body,status=200)=>route.fulfill({status,headers,body:JSON.stringify(body)});
  if(req.method()==='OPTIONS')return route.fulfill({status:204,headers});
  if(url.pathname==='/auth/v1/user')return reply(user);if(url.pathname==='/auth/v1/token')return reply(session());
  assert.equal(url.pathname,'/functions/v1/pub-bizz-pos');if(req.method()==='GET')return reply(url.searchParams.has('venueId')?envelope(null):{user,venues:[venue]});
  const r=req.postDataJSON();calls.push(r);await pause(200);let result=ledger.get(r.requestId);
  if(!ledger.has(r.requestId)){
   let next;try{next=D.run(state,r.type,r.payload,{id:user.id,role:'owner'},[]);}catch(e){if(!r.payload.marking)return reply({error:e.message,definitive:true},422);next=M.reject(state,r.type,r.payload,e.message,user.id);}
   state=next.state;result=next.result;ledger.set(r.requestId,result);
  }
  return reply(envelope(result));
 }
 return {a,b,session,route,calls,get state(){return state;}};
}
async function until(page,fn){for(let i=0;i<300;i++){if(await page.evaluate(fn))return;await pause(10);}throw new Error('Browser state did not settle: '+fn);}
async function flow(browser,base,width,engine){
 const f=fixture(),context=await browser.newContext({serviceWorkers:'block',viewport:{width,height:850},deviceScaleFactor:1}),page=await context.newPage(),errors=[],requestsFailed=[];page.on('pageerror',e=>errors.push(e.message));page.on('requestfailed',r=>requestsFailed.push({url:r.url(),failure:r.failure()}));page.setDefaultTimeout(8000);
 await context.route('**/*',route=>{const url=route.request().url();if(url.startsWith(api+'/'))return f.route(route);if(url.startsWith(base+'/'))return route.continue();throw new Error('Unexpected remote request '+url);});
 await context.addInitScript(({session,api})=>localStorage.setItem('sb-'+new URL(api).hostname.split('.')[0]+'-auth-token',JSON.stringify(session)),{session:f.session(),api});
 const order=id=>f.state.orders.find(o=>o.id===id),settled=()=>until(page,()=>!POSCloud.pending&&!POSCloud.busy),control=action=>page.locator((width<=630?'#mobile-account-dock ':'.receipt-bottom ')+'[data-action="'+action+'"]');
 try{
  await page.goto(base+'/pub_bizz_pos/index.html');await page.locator('.product').first().waitFor();await page.locator('#account-search').fill('Test A');await page.locator('.account-result[data-id="'+f.a+'"]').click();
  const product=page.locator('.product[data-action="add"]').first(),productId=await product.getAttribute('data-id');
  await page.locator('[data-action="entryCount"][data-id="5"]').click();await product.click();await until(page,()=>document.querySelector('.quantity-tap')?.textContent==='5×');
  assert.match(await control('undoLast').textContent(),/Zpět · [45] s/);assert.equal(await control('undoLast').isEnabled(),true);
  const geometry=await page.evaluate(()=>({width:innerWidth,scroll:document.documentElement.scrollWidth,controls:[...document.querySelectorAll((innerWidth<=630?'#mobile-account-dock ':'.receipt-bottom ')+'.bill-action')].map(b=>({height:b.getBoundingClientRect().height,bottom:b.getBoundingClientRect().bottom})),dock:document.querySelector('#mobile-account-dock').getBoundingClientRect().bottom}));
  assert.ok(geometry.scroll<=width);assert.ok(geometry.controls.every(b=>b.height>=48));if(width<=630)assert.ok(geometry.dock<=850);
  if(width===390)await page.screenshot({path:'/tmp/pos-account-'+engine+'-390.png'});
  await control('undoLast').click();await until(page,()=>!document.querySelector('.quantity-tap'));await settled();assert.equal(order(f.a).lines.length,0);
  await page.locator('[data-action="entryCount"][data-id="5"]').click();await page.locator('.product[data-id="'+productId+'"]').click();await settled();
  await control('moveItems').click();await page.locator('[data-transfer-line]').click();await page.locator('#transfer-qty-editor [data-qty="2"]').click();await page.locator('[data-transfer-target="'+f.b+'"]').click();
  await page.locator('#dialog-submit').click();await until(page,()=>!document.querySelector('#dialog').open);assert.equal(order(f.a).lines[0].quantity,3);assert.equal(order(f.b).lines[0].quantity,2);
  assert.equal(await page.locator('.receipt-head h2').textContent(),'Test A');
  await control('paySplit').click();await page.locator('.payment-item').waitFor();await page.locator('#dialog .dialog-actions .close-dialog').click();
  await control('moveAccount').click();await page.locator('[data-transfer-target="'+f.b+'"]').click();await page.locator('#dialog-submit').click();await until(page,()=>!document.querySelector('#dialog').open);
  assert.equal(order(f.a).lines.length,0);assert.equal(order(f.b).lines[0].quantity,5);assert.equal(await page.locator('.receipt-head h2').textContent(),'Test B');
  assert.equal(f.state.receipts.length,0);assert.equal(f.state.stockIssues.length,0);assert.deepEqual(errors,[]);
  console.log(JSON.stringify({engine,width,undoBatch:true,partialTransfer:true,wholeTransfer:true,splitAccessible:true,noMoneyOrStockWrites:true,geometry}));
 }catch(e){console.error(JSON.stringify({engine,width,requestsFailed,calls:f.calls.map(r=>({type:r.type,payload:r.payload})),server:order(f.a).lines,client:await page.evaluate(()=>({online:navigator.onLine,busy:POSCloud.busy,error:POSCloud.serviceError,auth:POSCloud.authBlocked,storage:POSCloud.storageError,outbox:POSCloud.outbox})).catch(()=>null)}));throw e;}finally{await context.close();}
}
async function splitScrollFlow(browser,base,engine){
 const f=fixture();for(const p of f.state.products.filter(p=>p.active&&p.price>0).slice(0,24))C.execute(f.state,'addLine',{orderId:f.a,productId:p.id,quantity:2});
 const context=await browser.newContext({serviceWorkers:'block',viewport:{width:393,height:667},isMobile:true,hasTouch:true}),page=await context.newPage();page.setDefaultTimeout(8000);
 await context.route('**/*',route=>{const url=route.request().url();if(url.startsWith(api+'/'))return f.route(route);if(url.startsWith(base+'/'))return route.continue();throw new Error('Unexpected remote request '+url);});
 await context.addInitScript(({session,api})=>localStorage.setItem('sb-'+new URL(api).hostname.split('.')[0]+'-auth-token',JSON.stringify(session)),{session:f.session(),api});
 try{
  await page.goto(base+'/pub_bizz_pos/index.html');await page.locator('.product').first().waitFor();await page.locator('#account-search').fill('Test A');await page.locator('.account-result[data-id="'+f.a+'"]').click();
  await page.locator('[data-action="payCash"]').click();await page.locator('.payment-item').last().waitFor();
  const dimensions=await page.evaluate(()=>({body:document.querySelector('#dialog-body').clientHeight,total:document.querySelector('#dialog-body').scrollHeight,button:document.querySelector('#dialog-submit').getBoundingClientRect().bottom,summary:document.querySelector('#dialog-summary').getBoundingClientRect().bottom,height:innerHeight}));
  assert.ok(dimensions.total>dimensions.body);assert.ok(dimensions.button<dimensions.height&&dimensions.summary<dimensions.height,'payment controls stay in view with all 24 rows selected');
  await page.locator('#dialog-body').evaluate(el=>el.scrollTop=el.scrollHeight);await page.locator('.payment-item').last().click();await page.locator('#payment-qty-editor [data-qty="1"]').click();
  assert.equal(await page.locator('#dialog-body').evaluate(el=>el.scrollTop),0,'choosing pieces returns to the top of the bill');
  assert.ok(await page.locator('#dialog-submit').isVisible());await page.locator('#dialog-submit').click();await until(page,()=>!document.querySelector('#dialog').open);
  assert.equal(f.state.receipts.length,1);assert.equal(f.state.orders.find(o=>o.id===f.a).lines[0].quantity,1);assert.equal(await page.locator('.receipt-head h2').textContent(),'Test A');
  assert.equal(await page.locator('.catalog-area').evaluate(el=>el.scrollTop),0);assert.ok((await page.locator('.order-entry').boundingBox()).y<120,'partial payment returns to drinks at the top');
  console.log(JSON.stringify({engine,longBillRows:24,stickyPaymentControls:true,quantityReturnsToTop:true,partialPaymentReturnsToDrinks:true,dimensions}));
 }finally{await context.close();}
}
(async()=>{
 await new Promise(r=>server.listen(0,'127.0.0.1',r));const base='http://127.0.0.1:'+server.address().port;
 try{for(const [name,engine] of [['chromium',chromium],['webkit',webkit]]){if(process.env.POS_ACCOUNT_ENGINES&&!process.env.POS_ACCOUNT_ENGINES.split(',').includes(name))continue;const browser=await engine.launch({headless:true,...(name==='webkit'&&process.env.POS_WEBKIT_EXECUTABLE?{executablePath:process.env.POS_WEBKIT_EXECUTABLE}:{})});try{for(const width of [320,390,900,1440])await flow(browser,base,width,name);await splitScrollFlow(browser,base,name);}finally{await browser.close();}}}finally{server.closeAllConnections();await new Promise(r=>server.close(r));}
})().catch(e=>{console.error(e);process.exitCode=1;});
