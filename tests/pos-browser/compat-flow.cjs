'use strict';
// Real browser engines and the committed Supabase SDK; only HTTP responses are mocked.
// All remote requests are intercepted. No test account, sale or stock change reaches production.
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const http=require('node:http');
const {pathToFileURL}=require('node:url');
const crypto=require('node:crypto');
const C=require('../../pub_bizz_pos/core.js');
const D=require('../../pub_bizz_pos/server-domain.js');
const root=path.resolve(__dirname,'../..');
const cfg=fs.readFileSync(path.join(root,'pub_bizz_pos/config.js'),'utf8');
const api=cfg.match(/url: '([^']+)'/)[1];
const csp=JSON.parse(fs.readFileSync(path.join(root,'pub_bizz_pos/vercel.json'),'utf8')).headers[0].headers;
const server=http.createServer((req,res)=>{
  const name=decodeURIComponent(req.url.split('?')[0]),file=path.resolve(root,'.'+name);
  if(!file.startsWith(root+path.sep)){res.writeHead(403);return res.end();}
  try{
    for(const {key,value} of csp)res.setHeader(key,value);
    res.setHeader('Content-Type',name.endsWith('.js')?'application/javascript':name.endsWith('.css')?'text/css':name.endsWith('.svg')?'image/svg+xml':name.endsWith('.webmanifest')?'application/manifest+json':'text/html');
    res.end(fs.readFileSync(file));
  }catch{res.writeHead(404);res.end();}
});
const profiles=[
  {name:'Chromium 109',module:'pw109',engine:'chromium',widths:[320,390,900,1440]},
  {name:'Firefox 115',module:'pw115',engine:'firefox',widths:[390,900,1440]},
  {name:'Chromium 134',module:'pwmodern',engine:'chromium',widths:[390,900,1440]},
  {name:'WebKit 18.4',module:'pwmodern',engine:'webkit',widths:[390,900]}
];
async function until(page,predicate,arg){
  // Older Playwright's waitForFunction uses eval, forbidden by the production CSP.
  for(let i=0;i<200;i++){
    if(await page.evaluate(predicate,arg))return;
    await new Promise(r=>setTimeout(r,50));
  }
  throw new Error('Timed out waiting for browser state: '+predicate.toString());
}
function fixture(){
  const user={id:crypto.randomUUID(),email:'owner@example.test',aud:'authenticated',role:'authenticated',app_metadata:{provider:'email',providers:['email']},user_metadata:{},identities:[]};
  const venue={id:crypto.randomUUID(),organization_id:crypto.randomUUID(),name:'Test venue',currency:'CZK',role:'owner'};
  let state=C.initial();state.venueId=venue.id;state.recipes={};
  const calls=[],requests=new Map();let serial=0,unauthorized=false,drop=false;
  const session=()=>{
    const exp=Math.floor(Date.now()/1000)+3600;
    const token=[{alg:'HS256',typ:'JWT'},{sub:user.id,aud:'authenticated',role:'authenticated',exp,iat:exp-3600,jti:String(++serial)}].map(x=>Buffer.from(JSON.stringify(x)).toString('base64url')).join('.')+'.test-signature';
    return {access_token:token,refresh_token:'test-refresh-'+serial,token_type:'bearer',expires_in:3600,expires_at:exp,user};
  };
  const envelope=result=>({state:structuredClone(state),result,stock:[],issues:[],issueCount:0,role:'owner',venue});
  async function route(route){
    const request=route.request(),url=new URL(request.url()),method=request.method();
    const headers={'access-control-allow-origin':'*','access-control-allow-headers':'*','access-control-allow-methods':'GET, POST, OPTIONS','content-type':'application/json'};
    const respond=(body,status=200)=>route.fulfill({status,headers,body:JSON.stringify(body)});
    if(method==='OPTIONS')return route.fulfill({status:204,headers});
    if(url.pathname==='/auth/v1/token'){
      const body=request.postDataJSON();calls.push({type:'auth',grant:url.searchParams.get('grant_type')});
      if(url.searchParams.get('grant_type')==='password'&&body.password!=='test-password')return respond({code:'invalid_credentials',message:'Invalid login credentials'},400);
      return respond(session());
    }
    if(url.pathname==='/auth/v1/user')return respond(user);
    assert.equal(url.pathname,'/functions/v1/pub-bizz-pos','unexpected remote request');
    assert.match(request.headers().authorization||'',/^Bearer /,'authenticated transport');
    if(unauthorized){unauthorized=false;return respond({message:'JWT expired'},401);}
    if(method==='GET')return respond(url.searchParams.has('venueId')?envelope(null):{user,venues:[venue]});
    const body=request.postDataJSON();calls.push(body);
    let result;
    if(requests.has(body.requestId))result=requests.get(body.requestId);
    else{
      try{
        const payload={...body.payload};if(body.type==='checkout')payload.operationId=body.requestId;
        const next=D.run(state,body.type,payload,{id:user.id,role:'owner'},[]);state=next.state;result=next.result;requests.set(body.requestId,result);
      }catch(e){return respond({error:e.message,definitive:true},422);}
    }
    if(drop){drop=false;return route.abort();}
    return respond(envelope(result));
  }
  return {route,calls,get state(){return state;},rejectToken(){unauthorized=true;},dropResponse(){drop=true;}};
}
async function contextFor(browser,options={}){
  const context=await browser.newContext({viewport:{width:options.width||1440,height:900},...options});
  // Fail every unexpected external request, even if a test inadvertently tries to leave the stub.
  await context.route('**/*',route=>{const url=new URL(route.request().url());return url.hostname==='127.0.0.1'||url.protocol==='file:'?route.continue():route.abort();});
  return context;
}
async function flow(browser,base,width){
  const mobile=browser.browserType().name()==='webkit'&&width<631;
  const context=await contextFor(browser,{width,...(mobile?{isMobile:true,hasTouch:true}:{})}),f=fixture(),errors=[];
  await context.route(api+'/**',f.route);
  const page=await context.newPage();page.on('pageerror',e=>errors.push(e.message));
  page.setDefaultTimeout(10000);
  try{
    await page.goto(base+'/pub_bizz_pos/index.html');
    await page.locator('[name="email"]').fill('owner@example.test');await page.locator('[name="password"]').fill('wrong');
    await page.locator('#login-form button').click();await until(page,()=>document.querySelector('#login-error')?.textContent.includes('nepodařilo'));
    assert.equal(f.state.shifts.length,0);
    f.rejectToken();await page.locator('[name="password"]').fill('test-password');await page.locator('#login-form button').click();
    await page.locator('.product').first().waitFor();
    assert.equal(f.calls.filter(c=>c.grant==='refresh_token').length,1,'401 renews the session once');
    assert.ok(await page.evaluate(()=>localStorage.getItem('sb-gnfqlfxuagcgjztaueot-auth-token')),'session uses the shared default key');
    const signins=f.calls.filter(c=>c.grant==='password').length;
    await page.reload();await page.locator('.product').first().waitFor();assert.equal(f.calls.filter(c=>c.grant==='password').length,signins,'reload restores the session');
    await page.locator('[data-action="openShift"]').click();await page.locator('[name="opening"]').fill('0');await page.locator('#dialog-submit').click();
    await until(page,()=>!document.querySelector('#dialog').open);assert.equal(f.state.shifts.length,1);
    for(const name of ['Stůl 12','Žaneta']){
      await page.locator('#account-search').fill(name);await page.locator('#account-results [data-action="newOrder"]').click();await page.locator('[name="name"]').fill(name);await page.locator('#dialog-submit').click();
      await until(page,name=>document.querySelector('.receipt-head h2')?.textContent===name,name);
    }
    await page.locator('#account-search').fill('12');await page.locator('#account-results [data-action="account"]').first().click();
    assert.equal(await page.locator('.receipt-head h2').textContent(),'Stůl 12');
    await page.locator('#account-search').fill('zaneta');await page.locator('#account-results [data-action="account"]').first().click();
    assert.equal(await page.locator('.receipt-head h2').textContent(),'Žaneta');
    await page.locator('[data-action="entryQuantity"]').click();await page.locator('[data-qty-more]').click();
    for(const digit of ['1','2'])await page.locator('[data-qty-digit="'+digit+'"]').click();
    await page.locator('[data-qty-confirm]').click();assert.equal(await page.locator('#entry-quantity').textContent(),'12×');
    const markedProduct=await page.locator('.product[data-action="add"]').nth(1).getAttribute('data-id');
    const firstProduct=await page.locator('.product[data-action="add"]').first().getAttribute('data-id');
    await page.locator('.product[data-id="'+markedProduct+'"]').click();await until(page,()=>document.querySelector('.quantity-tap')?.textContent==='12×');
    assert.equal(await page.locator('.product[data-action="add"]').first().getAttribute('data-id'),firstProduct,'unpaid marking keeps product positions');
    await page.locator('[data-action="quantityPad"]').click();await page.locator('[data-qty="5"]').click();
    await until(page,()=>document.querySelector('.quantity-tap')?.textContent==='5×');
    await page.locator('[data-action="paySplit"]').click();await page.locator('.payment-item').first().click();await page.locator('[data-qty="2"]').click();
    assert.equal(await page.locator('#payment-items').isVisible(),true,'returns to item selection');
    await page.locator('[data-payment-mode="card"]').click();await page.locator('#dialog-submit').click();assert.equal(f.state.receipts.length,0,'terminal confirmation required');
    await page.locator('[name="cardConfirmed"]').check();await page.locator('#dialog-submit').click();await until(page,()=>!document.querySelector('#dialog').open);
    assert.equal(f.state.receipts[0].lines[0].quantity,2);assert.ok(f.state.receipts[0].card>0);
    assert.equal(await page.locator('.product[data-action="add"]').first().getAttribute('data-id'),markedProduct,'confirmed paid pieces move the product to the top');
    const order=f.state.orders.find(o=>o.name==='Žaneta');assert.equal(order.lines[0].quantity,3);
    f.dropResponse();await page.locator('.product[data-action="add"]').first().click();await page.locator('[data-action="retryPending"]').waitFor();
    const pendingId=await page.evaluate(()=>POSCloud.pending.requestId);
    await page.reload();await until(page,()=>window.POSCloud&&!POSCloud.pending&&document.querySelector('.product'));
    assert.equal(await page.locator('.product[data-action="add"]').first().getAttribute('data-id'),markedProduct,'sales ranking survives reload');
    assert.equal(f.state.orders.find(o=>o.name==='Žaneta').lines[0].quantity,4);
    assert.equal(f.calls.filter(c=>c.requestId===pendingId).length,2,'reload replays the same durable ID');
    await page.locator('#account-search').fill('zaneta');await page.locator('#account-results [data-action="account"]').first().click();
    await page.locator('[data-action="payCash"]').click();await page.locator('#dialog-submit').click();await until(page,()=>!document.querySelector('#dialog').open);
    assert.equal(f.state.receipts.length,2);assert.equal(f.state.orders.find(o=>o.name==='Žaneta').lines.length,0);
    assert.match(await page.locator('#toast').textContent(),/Zaplaceno/);
    await page.locator('.product[data-action="add"]').first().click();await until(page,()=>document.querySelector('.quantity-tap')?.textContent==='1×');
    assert.equal(await page.locator('#dialog').evaluate(el=>el.open),false,'ready to mark immediately after payment');
    const metrics=await page.evaluate(()=>({width:innerWidth,scroll:document.documentElement.scrollWidth,total:document.querySelector('.receipt-total').getBoundingClientRect().bottom,payment:document.querySelector('.payment-buttons').getBoundingClientRect().bottom,height:innerHeight}));
    assert.ok(metrics.scroll<=metrics.width,'no horizontal overflow');
    if(width>=631)assert.ok(metrics.total<=metrics.height&&metrics.payment<=metrics.height,'total and payments remain in view');
    // IndexedDB is used only for the explicitly separate local emergency backup.
    const local=await page.evaluate(async()=>{const s=await POSCloud.localBackup();return {orders:s.orders.length,receipts:s.receipts.length};});
    assert.equal(local.receipts,0);
    assert.deepEqual(errors,[]);
    return {width,passed:true,steps:['password rejection','password login','401 refresh','session reload','open shift','table/customer search','12-piece keypad','quantity correction','partial card confirmation','paid product ranking','stable unpaid buttons','ranking reload','return to marking','durable ID reload/replay','cash payment','IndexedDB backup','layout']};
  }finally{await context.close();}
}
async function failures(browser,base){
  for(const mode of ['sdk','app','storage','quota','api']){
    const context=await contextFor(browser);try{
      if(mode==='sdk'||mode==='app')await context.route('**/'+(mode==='sdk'?'vendor/supabase-2.117.2.js':'app.js'),route=>route.abort());
      if(mode==='storage')await context.addInitScript(()=>Object.defineProperty(window,'localStorage',{get(){throw new DOMException('blocked','SecurityError');}}));
      if(mode==='quota')await context.addInitScript(()=>{Storage.prototype.setItem=function(){throw new DOMException('full','QuotaExceededError');};});
      if(mode==='api')await context.addInitScript(()=>{String.prototype.replaceAll=undefined;});
      const page=await context.newPage();await page.goto(base+'/pub_bizz_pos/index.html');await page.locator('#app h1').waitFor();
      assert.match(await page.locator('#app').textContent(),/Pokladnu nelze otevřít/);
      assert.equal(await page.locator('[data-action="openShift"]').count(),0);
      if(mode!=='app')assert.equal(await page.evaluate(()=>!!window.POSCloud),false,mode);
    }finally{await context.close();}
  }
  const context=await contextFor(browser);try{
    const page=await context.newPage();await page.goto(pathToFileURL(path.join(root,'pub_bizz_pos/PUB-BIZZ-pokladna-offline.html')).href);
    await page.locator('[data-action="openShift"]').waitFor();assert.equal(await page.evaluate(()=>!!window.POSCloud),false);
    assert.match(await page.locator('#offline-status').textContent(),/Samostatná offline/);
  }finally{await context.close();}
  return ['missing SDK','missing app','blocked storage','full storage','missing modern API','explicit emergency HTML'];
}
(async()=>{
  await new Promise(r=>server.listen(0,'127.0.0.1',r));const base='http://127.0.0.1:'+server.address().port;
  try{
    const selected=process.env.POS_BROWSER_PROFILES?.split(','),results=[];
    for(const profile of profiles){
      if(selected&&!selected.includes(profile.module+'/'+profile.engine))continue;
      console.log('Checking '+profile.name);
      const options={headless:true,timeout:15000};
      if(profile.engine==='firefox'&&process.env.MOZ_DISABLE_CONTENT_SANDBOX==='1')options.firefoxUserPrefs={'security.sandbox.content.level':0};
      if(profile.engine==='webkit'&&process.env.POS_WEBKIT_EXECUTABLE)options.executablePath=process.env.POS_WEBKIT_EXECUTABLE;
      const browser=await require(profile.module)[profile.engine].launch(options);
      try{
        const result={browser:profile.name,version:browser.version(),os:process.platform,flows:[]};
        for(const width of profile.widths){result.flows.push(await flow(browser,base,width));console.log(profile.name+' '+width+'px: flow passed');}
        result.failures=await failures(browser,base);results.push(result);console.log(JSON.stringify(result));
      }finally{await browser.close();}
    }
    if(process.env.POS_BROWSER_RESULTS)fs.writeFileSync(process.env.POS_BROWSER_RESULTS,JSON.stringify({transport:'mocked Auth and Edge HTTP responses; real committed Supabase SDK',windows7:false,results},null,2)+'\n');
  }finally{await new Promise(r=>server.close(r));}
})().catch(e=>{console.error(e);process.exitCode=1;});
