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
  const diagnostic=await page.evaluate(()=>({dialogError:document.querySelector('#dialog-error')?.textContent,dialogTitle:document.querySelector('#dialog-title')?.textContent,dialogOpen:document.querySelector('#dialog')?.open,account:document.querySelector('.receipt-head h2')?.textContent,saveState:document.querySelector('#save-state')?.textContent,pending:!!window.POSCloud?.pending}));
  throw new Error('Timed out waiting for browser state: '+predicate.toString()+' '+JSON.stringify(diagnostic));
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
    const headers={'access-control-allow-origin':'*','access-control-allow-headers':request.headers()['access-control-request-headers']||'authorization, apikey, content-type, x-client-info, x-supabase-api-version','access-control-allow-methods':'GET, POST, OPTIONS','content-type':'application/json'};
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
  // Route-based Auth/Edge mocks must see every request. Service-worker routing
  // is Chromium-only; real SW/cache/outage behavior has its own local test.
  const context=await browser.newContext({serviceWorkers:'block',viewport:{width:options.width||1440,height:900},...options});
  // Fail every unexpected external request, even if a test inadvertently tries to leave the stub.
  await context.route('**/*',route=>{const url=new URL(route.request().url());return url.hostname==='127.0.0.1'||url.protocol==='file:'?route.continue():route.abort();});
  return context;
}
async function navigate(page,view){
  const button=page.locator('[data-view="'+view+'"]');
  if(!await button.isVisible())await page.locator('#nav-toggle').click();
  await button.click();
  assert.equal(await page.locator('#nav-toggle').getAttribute('aria-expanded'),'false');
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
    const beforeNavigation=JSON.stringify(f.state);
    const toolbarHeight=await page.evaluate(()=>document.querySelector('.topbar').getBoundingClientRect().height+document.querySelector('.contextbar').getBoundingClientRect().height);
    if(width<=630){
      assert.ok(toolbarHeight<=80,'phone chrome must leave space for the account');
      assert.equal(await page.locator('#main-nav').isVisible(),false);
      await page.locator('#account-search').fill('rychly');
      assert.equal(await page.locator('#account-results').isVisible(),true);
      await page.locator('#nav-toggle').click();
      assert.equal(await page.locator('#account-results').isVisible(),false,'opening navigation closes account results');
      await page.keyboard.press('Escape');
      assert.equal(await page.locator('#account-results').isVisible(),false);
      assert.equal(await page.locator('#account-search').inputValue(),'rychly','navigation preserves the typed customer query');
      await page.locator('#account-search').click();
      assert.equal(await page.locator('#account-results').isVisible(),true,'account search can reopen normally');
      await page.locator('#account-search').fill('');await page.mouse.click(2,90);
      await page.locator('#nav-toggle').click();await page.keyboard.press('Escape');
      assert.equal(await page.locator('#main-nav').isVisible(),false);
      await page.locator('#nav-toggle').click();await page.locator('.topbar').click({position:{x:2,y:26}});
      assert.equal(await page.locator('#main-nav').isVisible(),false,'header outside the menu also dismisses it');
      await page.locator('#nav-toggle').click();await page.mouse.click(2,90);
      assert.equal(await page.locator('#main-nav').isVisible(),false);
    }else assert.equal(await page.locator('#nav-toggle').isVisible(),false);
    for(const name of ['history','overview','catalog','stock','settings','pos']){
      await navigate(page,name);
      assert.equal(await page.locator('#nav-current-view').textContent(),await page.locator('[data-view="'+name+'"]').textContent());
    }
    assert.equal(JSON.stringify(f.state),beforeNavigation,'navigation must preserve every account and payment');
    console.log(JSON.stringify({width,toolbarHeight,allSixPages:true,menuCloses:true}));
    await page.locator('[data-action="openShift"]').click();await page.locator('[name="opening"]').fill('0');await page.locator('#dialog-submit').click();
    await until(page,()=>!document.querySelector('#dialog').open);assert.equal(f.state.shifts.length,1);
    for(const name of ['Stůl 12','Žaneta']){
      await page.locator('#account-search').fill(name);await page.locator('#account-results [data-action="newOrder"]').click();await page.locator('[name="name"]').fill(name);await page.locator('#dialog-submit').click();
      await until(page,name=>document.querySelector('.receipt-head h2')?.textContent===name,name);
    }
    await page.locator('#account-search').fill('12');await page.locator('#account-results [data-action="account"]').first().click();
    assert.equal(await page.locator('.receipt-head h2').textContent(),'Stůl 12');
    assert.equal(await page.locator('[data-action="customerProfile"]').isVisible(),false,'numbered table has no customer profile');
    await page.locator('#account-search').fill('zaneta');await page.locator('#account-results [data-action="account"]').first().click();
    assert.equal(await page.locator('.receipt-head h2').textContent(),'Žaneta');
    assert.equal(await page.locator('[data-action="customerProfile"]').isVisible(),true,'named customer exposes profile on demand');
    assert.equal(await page.locator('#account-search').inputValue(),'Žaneta');
    await page.locator('#account-search').fill('');
    assert.equal(await page.locator('.receipt-head h2').textContent(),'Rychlý prodej','empty customer means quick sale');
    await page.locator('#account-search').fill('zaneta');await page.locator('#account-results [data-action="account"]').first().click();
    await page.locator('[data-action="entryQuantity"]').click();
    for(const digit of ['1','2'])await page.locator('[data-qty-digit="'+digit+'"]').click();
    await page.locator('[data-qty-confirm]').click();assert.equal(await page.locator('#entry-quantity').textContent(),'12×');
    const markedProduct=await page.locator('.product[data-action="add"]').nth(1).getAttribute('data-id');
    const firstProduct=await page.locator('.product[data-action="add"]').first().getAttribute('data-id');
    await page.locator('.product[data-id="'+markedProduct+'"]').click();await until(page,()=>document.querySelector('.quantity-tap')?.textContent==='12×');
    assert.equal(await page.locator('.product[data-action="add"]').first().getAttribute('data-id'),firstProduct,'unpaid marking keeps product positions');
    await page.locator('[data-action="quantityPad"]').click();await page.locator('[data-qty="5"]').click();
    await until(page,()=>document.querySelector('.quantity-tap')?.textContent==='5×');
    await page.locator('[data-action="paySplit"]:visible').click();
    assert.equal(f.state.orders.find(o=>o.name==='Žaneta').paymentLock,undefined,'opening split must not reserve the account');
    await page.locator('#dialog .close-dialog').first().click();await until(page,()=>!document.querySelector('#dialog').open);
    await page.locator('.line [data-action="add"]').click();await until(page,()=>document.querySelector('.quantity-tap')?.textContent==='6×');
    assert.equal(f.state.orders.find(o=>o.name==='Žaneta').paymentLock,undefined,'account remains markable after abandoning split');
    await page.locator('[data-action="minus"]').click();await until(page,()=>document.querySelector('.quantity-tap')?.textContent==='5×');
    await page.locator('[data-action="paySplit"]:visible').click();await page.locator('.payment-item').first().click();await page.locator('[data-qty="2"]').click();
    assert.equal(await page.locator('#payment-items').isVisible(),true,'returns to item selection');
    await page.locator('[data-payment-mode="card"]').click();await page.locator('#dialog-submit').click();assert.equal(f.state.receipts.length,0,'terminal confirmation required');
    await page.locator('[name="cardConfirmed"]').check();await page.locator('#dialog-submit').click();await until(page,()=>!document.querySelector('#dialog').open);
    assert.equal(f.state.receipts[0].lines[0].quantity,2);assert.ok(f.state.receipts[0].card>0);
    const beforeRename=structuredClone(f.state),customerId=f.state.orders.find(o=>o.name==='Žaneta').id;
    await page.locator('[data-action="renameOrder"]').click();
    assert.equal(await page.locator('[name="name"]').inputValue(),'Žaneta');
    await page.locator('[name="name"]').fill('Žaneta Nová');await page.locator('#dialog-submit').click();
    await until(page,()=>!document.querySelector('#dialog').open);
    assert.equal(await page.locator('#account-search').inputValue(),'Žaneta Nová');
    assert.equal(await page.locator('.receipt-head h2').textContent(),'Žaneta Nová');
    assert.deepEqual(f.state.receipts,beforeRename.receipts);
    assert.deepEqual(f.state.orders.find(o=>o.id===customerId).lines,beforeRename.orders.find(o=>o.id===customerId).lines);
    const insights=require('../../pub_bizz_pos/customer.js');
    assert.equal(insights.profile(f.state,'Žaneta Nová').spend,insights.profile(beforeRename,'Žaneta').spend);
    await page.locator('[data-action="renameOrder"]').click();await page.locator('[name="name"]').fill('Žaneta');await page.locator('#dialog-submit').click();
    await until(page,()=>!document.querySelector('#dialog').open);
    await page.locator('[data-action="customerProfile"]').click();
    assert.equal(await page.locator('#dialog-title').textContent(),'Žaneta · zákazník');
    assert.match(await page.locator('#dialog-body').textContent(),/Věrnostní body/);
    assert.match(await page.locator('#dialog-body').textContent(),/Co nejčastěji bere/);
    assert.match(await page.locator('#dialog-body').textContent(),/Kredit/);
    await page.locator('[data-action="creditTopup"]').click();
    await page.locator('[name="amount"]').fill('5000');await page.locator('#dialog-submit').click();
    await until(page,()=>document.querySelector('#dialog-title')?.textContent==='Žaneta · zákazník');
    assert.equal(f.state.creditLedger.filter(x=>x.type==='topup').length,1);
    assert.equal(f.state.creditLedger.find(x=>x.type==='topup').amount,500000);
    assert.match(await page.locator('#dialog-body').textContent(),/5\s?000/);
    const originalTopup=f.state.creditLedger.find(x=>x.type==='topup');
    await page.locator('.customer-profile details summary').click();await page.locator('[data-action="creditReverse"]').click();
    await page.locator('[name="reason"]').fill('TEST wrong deposit');await page.locator('#dialog-submit').click();
    await until(page,()=>document.querySelector('#dialog-title')?.textContent==='Žaneta · zákazník');
    assert.equal(f.state.creditLedger.filter(x=>x.reversalOf===originalTopup.id).length,1);assert.equal(C.creditBalance(f.state,originalTopup.customerId),0);
    assert.equal(f.state.receipts.length,1,'reversing a deposit must not invent a sale');
    await page.locator('[data-action="creditTopup"]').click();await page.locator('[name="amount"]').fill('5000');await page.locator('#dialog-submit').click();
    await until(page,()=>document.querySelector('#dialog-title')?.textContent==='Žaneta · zákazník');
    await page.locator('#dialog .close-dialog').first().click();
    assert.equal(await page.locator('.product[data-action="add"]').first().getAttribute('data-id'),markedProduct,'confirmed paid pieces move the product to the top');
    const order=f.state.orders.find(o=>o.name==='Žaneta');assert.equal(order.lines[0].quantity,3);
    assert.equal(await page.locator('.receipt-head h2').textContent(),'Žaneta','partial payment preserves the selected customer');
    f.dropResponse();await page.locator('.product[data-action="add"]').first().click();await page.locator('[data-action="retryPending"]').waitFor();
    const pendingId=await page.evaluate(()=>POSCloud.pending.requestId);
    await page.reload();await until(page,()=>window.POSCloud&&!POSCloud.pending&&document.querySelector('.product'));
    assert.equal(await page.locator('.product[data-action="add"]').first().getAttribute('data-id'),markedProduct,'sales ranking survives reload');
    assert.equal(f.state.orders.find(o=>o.name==='Žaneta').lines[0].quantity,4);
    assert.equal(f.calls.filter(c=>c.requestId===pendingId).length,2,'reload replays the same durable ID');
    await page.locator('#account-search').fill('zaneta');await page.locator('#account-results [data-action="account"]').first().click();
    const creditCustomer=f.state.orders.find(o=>o.name==='Žaneta'),creditBefore=C.creditBalance(f.state,creditCustomer.customerId);
    assert.equal(await page.locator('[data-action="payCredit"]').isDisabled(),false,'funded customer can pay with credit');
    await page.locator('[data-action="payCredit"]').click();
    await page.locator('#dialog .close-dialog').first().click();
    await until(page,()=>!document.querySelector('#dialog').open);
    assert.equal(f.state.orders.find(o=>o.name==='Žaneta').paymentLock,undefined,'abandoned credit dialog remains editable');
    await page.locator('[data-action="payCard"]').click();await page.locator('[name="cardConfirmed"]').waitFor();
    await page.reload();await page.locator('.product').first().waitFor();
    await page.locator('#account-search').fill('zaneta');await page.locator('#account-results [data-action="account"]').first().click();
    await until(page,()=>!document.querySelector('#dialog').open&&!!document.querySelector('[data-action="checkPayment"]'));
    assert.ok(f.state.orders.find(o=>o.name==='Žaneta').paymentLock);
    await page.locator('[data-action="checkPayment"]').click();
    assert.equal(await page.locator('[name="operation"] option[value="credit"]').count(),1,'interrupted customer payment can resume as credit');
    await page.locator('[name="operation"]').selectOption('credit');await page.locator('[name="checked"]').check();await page.locator('#dialog-submit').click();
    await until(page,()=>document.querySelector('#dialog-title')?.textContent==='Zaplatit kreditem');
    await page.locator('#dialog-submit').click();await until(page,()=>!document.querySelector('#dialog').open);
    assert.equal(f.state.receipts.length,2);assert.equal(f.state.orders.find(o=>o.name==='Žaneta').lines.length,0);
    assert.ok(f.state.receipts[1].credit>0);assert.equal(f.state.receipts[1].cash,0);assert.equal(f.state.receipts[1].card,0);
    assert.equal(C.creditBalance(f.state,creditCustomer.customerId),creditBefore-f.state.receipts[1].credit);
    assert.equal(await page.locator('.receipt-head h2').textContent(),'Rychlý prodej','full payment returns to quick sale');
    assert.equal(await page.locator('#account-search').inputValue(),'');
    assert.match(await page.locator('#toast').textContent(),/Zaplaceno/);
    await page.locator('.product[data-action="add"]').first().click();await until(page,()=>document.querySelector('.quantity-tap')?.textContent==='1×');
    assert.equal(await page.locator('#dialog').evaluate(el=>el.open),false,'ready to mark immediately after payment');
    assert.equal(f.state.orders.find(o=>o.id==='bar').lines[0].quantity,1,'next guest is marked on quick sale automatically');
    assert.equal(f.state.orders.find(o=>o.name==='Žaneta').lines.length,0);
    const metrics=await page.evaluate(()=>({width:innerWidth,scroll:document.documentElement.scrollWidth,total:document.querySelector('.receipt-total').getBoundingClientRect().bottom,payment:document.querySelector('.payment-buttons').getBoundingClientRect().bottom,height:innerHeight}));
    assert.ok(metrics.scroll<=metrics.width,'no horizontal overflow');
    if(width>=631)assert.ok(metrics.total<=metrics.height&&metrics.payment<=metrics.height,'total and payments remain in view');
    // IndexedDB is used only for the explicitly separate local emergency backup.
    const local=await page.evaluate(async()=>{const s=await POSCloud.localBackup();return {orders:s.orders.length,receipts:s.receipts.length};});
    assert.equal(local.receipts,0);
    await page.locator('[data-action="entryCount"][data-id="2"]').click();await page.locator('.product[data-action="add"]').first().click();
    await until(page,()=>document.querySelector('.quantity-tap')?.textContent==='3×');
    await page.locator('[data-action="payCard"]').click();await page.locator('[data-payment-reset]').click();
    assert.equal(await page.locator('#dialog-submit').isDisabled(),true);
    await page.locator('.payment-item').first().click();await page.locator('[data-qty="1"]').click();
    await page.locator('[name="cardConfirmed"]').check();await page.locator('#dialog-submit').click();await until(page,()=>!document.querySelector('#dialog').open);
    const corrected=f.state.receipts.at(-1);assert.equal(corrected.lines[0].quantity,1);assert.equal(f.state.orders[0].lines[0].quantity,2);
    await page.locator('[data-action="payCash"]').click();await page.locator('#dialog .dialog-actions .close-dialog').click();
    assert.equal(await page.locator('[data-action="paySplit"]:visible').isDisabled(),false);
    await page.locator('[data-action="paySplit"]:visible').click();await page.locator('.payment-item').first().click();await page.locator('[data-qty="1"]').click();
    await page.locator('#dialog-submit').click();await until(page,()=>!document.querySelector('#dialog').open);
    assert.equal(f.state.orders[0].lines[0].quantity,1);
    const receiptsBefore=f.state.receipts.length, target=f.state.orders.find(o=>o.name==='Stůl 12');
    await navigate(page,'history');await page.locator('[data-action="restoreReceipt"][data-id="'+corrected.id+'"]').click();
    assert.equal(f.state.receipts.length,receiptsBefore);
    await page.locator('[name="targetOrderId"]').selectOption(target.id);await page.locator('#dialog-submit').click();await until(page,()=>!document.querySelector('#dialog').open);
    assert.equal(f.state.receipts.length,receiptsBefore);assert.equal(f.state.orders.find(o=>o.id===target.id).lines.length,0);
    await page.locator('[data-action="restoreReceipt"][data-id="'+corrected.id+'"]').click();await page.locator('[name="correction"]').selectOption('restore');
    await page.locator('[name="reason"]').fill('TEST ONLY');await page.locator('#dialog-submit').click();
    assert.equal(f.state.receipts.length,receiptsBefore,'browser validity prevents unverified reversal');
    await page.locator('[name="terminalReference"]').fill('TEST-TERM-123');await page.locator('[name="cardConfirmed"]').check();
    const overflow=await page.evaluate(()=>document.querySelector('#dialog').scrollWidth>document.querySelector('#dialog').clientWidth);assert.equal(overflow,false,'correction dialog fits');
    f.dropResponse();await page.locator('#dialog-submit').click();await page.locator('[data-action="retryPending"]').waitFor();
    const correctionId=await page.evaluate(()=>POSCloud.pending.requestId);await page.reload();
    await until(page,()=>window.POSCloud&&!POSCloud.pending&&document.querySelector('.receipt-head h2')?.textContent==='Stůl 12');
    assert.equal(f.state.receipts.length,receiptsBefore+1);assert.equal(f.state.orders.find(o=>o.id===target.id).lines[0].quantity,1);
    assert.equal(f.calls.filter(c=>c.requestId===correctionId).length,2,'lost correction response survives reload without a second refund');
    assert.equal(await page.locator('#dialog').evaluate(el=>el.open),false);
    assert.deepEqual(errors,[]);
    return {width,passed:true,steps:['password rejection','password login','401 refresh','session reload','open shift','table/customer search','12-piece keypad','quantity correction','partial card confirmation','paid product ranking','stable unpaid buttons','ranking reload','return to marking','durable ID reload/replay','cash payment','IndexedDB backup','layout','local full-to-split switch','back-to-split reservation','neutral assignment','terminal reference and confirmation','financial recovery after reload']};
  }catch(error){
    console.error(JSON.stringify({engine:browser.browserType().name(),width,requests:f.calls.map(c=>c.type),serverShifts:f.state.shifts.length}));
    throw error;
  }finally{await context.close();}
}
async function smallShotFlow(browser,base,width){
 const mobile=browser.browserType().name()==='webkit'&&width<631;
 const context=await contextFor(browser,{width,...(mobile?{isMobile:true,hasTouch:true}:{})}),f=fixture();
 await context.route(api+'/**',f.route);const page=await context.newPage(),errors=[];page.on('pageerror',e=>errors.push(e.message));
 try{
  await page.goto(base+'/pub_bizz_pos/index.html');await page.locator('[name="email"]').fill('owner@example.test');await page.locator('[name="password"]').fill('test-password');await page.locator('#login-form button').click();
  await page.locator('[data-action="openShift"]').click();await page.locator('[name="opening"]').fill('0');await page.locator('#dialog-submit').click();await until(page,()=>!document.querySelector('#dialog').open);
  await page.locator('#account-search').fill('Malé panáky');await page.locator('#account-results [data-action="newOrder"]').click();await page.locator('#dialog-submit').click();await until(page,()=>!document.querySelector('#dialog').open);
  const id=f.state.orders.find(o=>o.name==='Malé panáky').id;
  await page.locator('[data-action="smallShot"]').click();await page.locator('[data-action="entryCount"][data-id="3"]').click();
  assert.equal(await page.locator('[data-action="smallShot"]').getAttribute('aria-pressed'),'true');assert.equal(await page.locator('.product[data-id="agnis-50"]').count(),0);
  const rect=await page.locator('[data-action="smallShot"]').boundingBox();assert.ok(rect.width>=64&&rect.height>=44,'2cl switch is a usable touch target');
  if(process.env.POS_SMALL_SHOT_SCREENSHOTS){fs.mkdirSync(process.env.POS_SMALL_SHOT_SCREENSHOTS,{recursive:true});await page.locator('.order-entry').screenshot({path:path.join(process.env.POS_SMALL_SHOT_SCREENSHOTS,browser.browserType().name()+'-'+width+'-entry.png')});}
  await page.locator('.product[data-id="agnis-2810"]').click();await until(page,()=>document.querySelector('.quantity-tap')?.textContent==='3×');
  const small=f.state.orders.find(o=>o.id===id).lines[0];assert.equal(small.servingMl,20);assert.equal(small.quantity,3);assert.equal(small.price,2750);assert.match(small.name,/2 cl/);
  if(process.env.POS_SMALL_SHOT_SCREENSHOTS)await page.locator('.receipt').screenshot({path:path.join(process.env.POS_SMALL_SHOT_SCREENSHOTS,browser.browserType().name()+'-'+width+'-bill.png')});
  await page.locator('[data-action="smallShot"]').click();await page.locator('.line [data-action="add"]').click();await until(page,()=>document.querySelector('.quantity-tap')?.textContent==='4×');
  await page.locator('.product[data-id="agnis-2810"]').click();await until(page,()=>document.querySelectorAll('.quantity-tap').length===2);
  assert.equal(f.state.orders.find(o=>o.id===id).lines[1].price,5500);
  await page.locator('[data-action="paySplit"]:visible').click();await page.locator('.payment-item').filter({hasText:'2 cl'}).click();await page.locator('[data-qty="2"]').click();
  await page.locator('[data-payment-mode="card"]').click();await page.locator('[name="cardConfirmed"]').check();await page.locator('#dialog-submit').click();await until(page,()=>!document.querySelector('#dialog').open);
  assert.equal(f.state.receipts[0].total,5500);assert.equal(f.state.receipts[0].lines[0].quantity,2);assert.equal(f.state.receipts[0].lines[0].servingMl,20);
  await page.reload();await page.locator('#account-search').fill('Malé panáky');await page.locator('#account-results [data-action="account"]').click();
  await page.locator('.line [data-action="add"]').first().click();await until(page,()=>document.querySelector('.quantity-tap')?.textContent==='3×');
  const remaining=f.state.orders.find(o=>o.id===id).lines;assert.equal(remaining[0].quantity,3);assert.equal(remaining[0].price,2750);assert.equal(remaining[1].quantity,1);
  assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),'2cl controls do not overflow');assert.deepEqual(errors,[]);
  return {width,threeSmallShots:true,plusKeepsSize:true,splitKeepsRemainder:true,reloadKeepsSize:true};
 }finally{await context.close();}
}
async function visitFlow(browser,base,width){
 const context=await contextFor(browser,{width,timezoneId:'Europe/Prague'}),f=fixture(),errors=[];
 // Exercise fractional seconds ending in zero: native datetime inputs canonicalize these.
 const at=minutes=>new Date(Math.floor((Date.now()-minutes*60000)/100)*100).toISOString();
 C.execute(f.state,'openShift',{opening:0});
 const source=C.execute(f.state,'newOrder',{name:'TEST Visitor A'}).id,target=C.execute(f.state,'newOrder',{name:'TEST Visitor B'}).id;
 C.execute(f.state,'addLine',{orderId:source,productId:'agnis-2810'},at(45));
 C.execute(f.state,'addLine',{orderId:source,productId:'agnis-2810'},at(10));
 C.execute(f.state,'addLine',{orderId:target,productId:'agnis-2810',quantity:2},at(30));
 const order=id=>f.state.orders.find(o=>o.id===id),actualActivity=order(source).visitLastActivityAt;
 // Pre-fix saved departure with no cached activity: only the audit proves the later order.
 order(source).visitEndedAt=at(30);delete order(source).visitLastActivityAt;
 for(const e of f.state.audit)delete e.visitActivity;
 const a=structuredClone(order(source)),b=structuredClone(order(target));
 await context.route(api+'/**',f.route);const page=await context.newPage();page.on('pageerror',e=>errors.push(e.message));
 try{
  await page.goto(base+'/pub_bizz_pos/index.html');await page.locator('[name="email"]').fill('owner@example.test');await page.locator('[name="password"]').fill('test-password');await page.locator('#login-form button').click();
  const select=async name=>{await page.locator('#account-search').fill(name);await page.locator('#account-results [data-action="account"]').first().click();};
  await select('TEST Visitor A');await page.locator('[data-action="mergeOrders"]').click();
  assert.match(await page.locator('#dialog-body').textContent(),/Návštěvy a kredit obou hostů zůstávají oddělené/);
  await page.locator('[name="targetOrderId"]').selectOption(target);f.dropResponse();await page.locator('#dialog-submit').click();await page.locator('[data-action="retryPending"]').waitFor();
  const requestId=await page.evaluate(()=>POSCloud.pending.requestId);await page.locator('#dialog .dialog-actions .close-dialog').click();await page.locator('[data-action="retryPending"]').click();
  await until(page,()=>window.POSCloud&&!POSCloud.pending&&!POSCloud.busy&&document.querySelector('.receipt-head h2')?.textContent==='TEST Visitor B');
  assert.equal(f.calls.filter(c=>c.requestId===requestId).length,2);assert.equal(f.state.audit.filter(e=>e.type==='mergeOrders').length,1);
  for(const key of ['visitId','visitStartedAt','visitLastActivityAt','customerId']){assert.equal(order(source)[key],a[key]);assert.equal(order(target)[key],b[key]);}
  await select('TEST Visitor A');await page.locator('[data-action="customerProfile"]').click();await page.locator('[data-action="endVisit"]').click();
  const input=page.locator('[name="endedAt"]'),minimum=await input.getAttribute('min');
  const fillDeparture=async value=>{
   const normalized=await input.evaluate((el,value)=>{const probe=document.createElement('input');probe.type=el.type;probe.value=value;return probe.value;},value);
   await input.fill(normalized);
  };
  assert.equal(await input.evaluate(el=>new Date(el.min).toISOString()),actualActivity);
  assert.equal(await input.evaluate(el=>Date.parse(el.value)===Date.parse(el.min)),true,'invalid saved end is clamped to actual activity');
  const earlier=await input.evaluate(el=>{const d=new Date(new Date(el.min).getTime()-1000);return new Date(d.getTime()-d.getTimezoneOffset()*60000).toISOString().slice(0,23);});
  await fillDeparture(earlier);const count=f.calls.length;await page.locator('#dialog-submit').click();assert.equal(await input.evaluate(el=>el.validity.rangeUnderflow),true);assert.equal(f.calls.length,count,'native min stops a contradictory departure');
  await input.evaluate(el=>el.removeAttribute('min'));await page.locator('#dialog-submit').click();await until(page,()=>document.querySelector('#dialog-error')?.textContent.includes('aktivit'));
  assert.equal(order(source).visitEndedAt,a.visitEndedAt);assert.equal(f.state.receipts.length,0);
  await fillDeparture(minimum);await page.locator('#dialog-submit').click();await until(page,()=>!document.querySelector('#dialog').open);
  assert.equal(order(source).visitEndedAt,actualActivity);assert.equal(order(source).lines.length,0);assert.equal(order(target).lines[0].quantity,4);
  assert.equal(order(target).visitId,b.visitId);assert.deepEqual(errors,[]);
  return {width,independentVisitors:true,mergeReplayOnce:true,localTimeMinimum:true,serverDepartureGuard:true,legacySavedEndCorrected:true};
 }finally{await context.close();}
}
async function cancellationFlow(browser,base,width){
  const context=await contextFor(browser,{width}),f=fixture(),errors=[];
  C.execute(f.state,'openShift',{opening:0});C.execute(f.state,'addLine',{orderId:'bar',productId:'agnis-2810',quantity:2});
  await context.route(api+'/**',f.route);const page=await context.newPage();page.on('pageerror',e=>errors.push(e.message));page.setDefaultTimeout(10000);
  try{
    await page.goto(base+'/pub_bizz_pos/index.html');await page.locator('[name="email"]').fill('owner@example.test');await page.locator('[name="password"]').fill('test-password');await page.locator('#login-form button').click();await page.locator('.product').first().waitFor();
    const lines=structuredClone(f.state.orders[0].lines);
    await page.locator('[data-action="payCash"]').click();await page.locator('[name="received"]').waitFor();await page.keyboard.press('Escape');await until(page,()=>!document.querySelector('#dialog').open);
    assert.equal(f.state.orders[0].paymentLock,undefined);assert.equal(f.calls.filter(c=>c.type==='beginPayment').length,0);
    await page.locator('[data-action="payCard"]').click();await page.locator('[name="cardConfirmed"]').waitFor();
    await page.locator('#dialog .dialog-actions .close-dialog').click();assert.equal(await page.locator('#dialog-title').textContent(),'Zrušit rozpracovanou platbu');
    await page.locator('#dialog-submit').click();assert.ok(f.state.orders[0].paymentLock,'unchecked cancellation is not submitted');assert.equal(f.calls.filter(c=>c.type==='cancelPayment').length,0);
    await page.locator('[name="checked"]').check();await page.locator('#dialog-submit').click();await until(page,()=>!document.querySelector('#dialog').open);
    assert.equal(f.state.orders[0].paymentLock,undefined);assert.deepEqual(f.state.orders[0].lines,lines);assert.equal(f.state.receipts.length,0);
    await page.locator('[data-action="payCard"]').click();await page.locator('[name="cardConfirmed"]').waitFor();await page.reload();await page.locator('[data-action="cancelPayment"]').waitFor();
    await page.locator('[data-action="cancelPayment"]').click();await page.locator('[name="checked"]').check();f.dropResponse();await page.locator('#dialog-submit').click();
    await until(page,()=>POSCloud.pending?.type==='cancelPayment'&&!POSCloud.busy);const id=await page.evaluate(()=>POSCloud.pending.requestId);
    await page.locator('#dialog .dialog-head .close-dialog').click();await page.locator('[data-action="retryPending"]').click();await until(page,()=>!POSCloud.pending&&!document.querySelector('#dialog').open);
    assert.equal(f.calls.filter(c=>c.requestId===id).length,2);assert.equal(f.state.orders[0].paymentLock,undefined);assert.deepEqual(f.state.orders[0].lines,lines);assert.equal(f.state.receipts.length,0);
    await page.locator('.line [data-action="add"]').click();await until(page,()=>document.querySelector('.quantity-tap')?.textContent==='3×');assert.equal(f.state.orders[0].lines[0].quantity,3);assert.deepEqual(errors,[]);
    return {cashDismissed:true,cardCancelled:true,legacyReload:true,lostResponseRecovered:true,itemsPreserved:true};
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
        for(const width of profile.widths){result.flows.push({...await flow(browser,base,width),cancellation:await cancellationFlow(browser,base,width),smallShots:await smallShotFlow(browser,base,width),visits:await visitFlow(browser,base,width)});console.log(profile.name+' '+width+'px: flow passed');}
        result.failures=await failures(browser,base);results.push(result);console.log(JSON.stringify(result));
      }finally{await browser.close();}
    }
    if(process.env.POS_BROWSER_RESULTS)fs.writeFileSync(process.env.POS_BROWSER_RESULTS,JSON.stringify({transport:'mocked Auth and Edge HTTP responses; real committed Supabase SDK',windows7:false,results},null,2)+'\n');
  }finally{await new Promise(r=>server.close(r));}
})().catch(e=>{console.error(e);process.exitCode=1;});
