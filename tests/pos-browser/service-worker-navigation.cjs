'use strict';
// Real service workers, browser navigation, redirects and Cache/IndexedDB APIs.
// Only local static test pages are served; no account, payment or remote API is used.
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),http=require('node:http');
const root=path.resolve(__dirname,'../..'),pw=require('pwmodern');
let app,updated=false,port;
const server=http.createServer((req,res)=>{
 const url=new URL(req.url,'http://localhost'),pathname=url.pathname;
 if(pathname==='/'+app+'/'){res.writeHead(308,{Location:'/'+app});res.end();return;}
 if(pathname==='/'+app){res.writeHead(307,{Location:'/'+app+'/'+(app==='pub_bizz_pos'?'index.html':'start.html')});res.end();return;}
 if(pathname==='/'+app+'/sw.js'){
  res.writeHead(200,{'Content-Type':'text/javascript','Cache-Control':'no-cache'});
  res.end(fs.readFileSync(updated?path.join(root,app,'sw.js'):path.join(root,'tests/fixtures',app+'-redirect-worker.js')));return;
 }
 if(pathname.endsWith('.html')){res.writeHead(200,{'Content-Type':'text/html'});res.end('<!doctype html><html><meta name="viewport" content="width=device-width"><body><h1>APP READY</h1></body></html>');return;}
 const file=path.resolve(root,'.'+pathname);
 if(!file.startsWith(root+path.sep)||!fs.existsSync(file)||!fs.statSync(file).isFile()){res.writeHead(404);res.end();return;}
 const type=pathname.endsWith('.js')?'text/javascript':pathname.endsWith('.css')?'text/css':pathname.endsWith('.svg')?'image/svg+xml':pathname.endsWith('.webmanifest')?'application/manifest+json':'application/octet-stream';
 res.writeHead(200,{'Content-Type':type});res.end(fs.readFileSync(file));
});
async function stopOrigin(){await new Promise(resolve=>{server.close(resolve);server.closeAllConnections();});}
async function startOrigin(){await new Promise(resolve=>server.listen(port,'127.0.0.1',resolve));}
async function check(browser,base,directory){
 app=directory;updated=false;
 const context=await browser.newContext({viewport:{width:390,height:844},serviceWorkers:'allow'});
 await context.route('**/*',route=>new URL(route.request().url()).hostname==='127.0.0.1'?route.continue():route.abort());
 const page=await context.newPage(),probe=await context.newPage();
 try{
  await page.goto(base+'/'+app+'/'+(app==='pub_bizz_pos'?'index.html':'start.html'));
  await page.evaluate(async()=>{await navigator.serviceWorker.register('./sw.js');await navigator.serviceWorker.ready;});
  await page.waitForFunction(()=>!!navigator.serviceWorker.controller);
  await page.evaluate(async()=>{
   localStorage.setItem('pub-bizz-cloud-pending:TEST_ONLY','TEST durable request');
   const db=await new Promise((resolve,reject)=>{const r=indexedDB.open('TEST-navigation-data',1);r.onupgradeneeded=()=>r.result.createObjectStore('test');r.onsuccess=()=>resolve(r.result);r.onerror=()=>reject(r.error);});
   await new Promise((resolve,reject)=>{const tx=db.transaction('test','readwrite');tx.objectStore('test').put('TEST saved data','sample');tx.oncomplete=resolve;tx.onerror=()=>reject(tx.error);});db.close();
  });
  // Guru is network-first: its unsafe precached directory is used on outage.
  if(app==='pub_guru')await stopOrigin();
  let originalError='';try{await probe.goto(base+'/'+app+'/');}catch(e){originalError=e.message;}
  assert.match(originalError,/redirections|ERR_FAILED/,'the old cached redirect must reproduce the actual navigation failure');
  if(app==='pub_guru')await startOrigin();
  updated=true;
  await page.evaluate(async()=>{
   const registration=await navigator.serviceWorker.getRegistration();
   const changed=new Promise(resolve=>navigator.serviceWorker.addEventListener('controllerchange',resolve,{once:true}));
   await registration.update();await changed;
  });
  const response=await probe.goto(base+'/'+app+'/');assert.ok(response.ok());assert.equal(response.fromServiceWorker(),true);
  await probe.locator('h1').waitFor();assert.equal(await probe.locator('h1').textContent(),'APP READY');
  // Stop the real origin: Playwright's WebKit setOffline also blocks
  // literal SW responses (https://github.com/microsoft/playwright/issues/42775).
  await stopOrigin();
  assert.equal(server.listening,false);
  assert.equal(await page.evaluate(()=>fetch('./TEST-connection-lost.json',{cache:'no-store'}).then(()=>false,()=>true)),true,'an uncached network fetch must really fail');
  const offline=await probe.goto(base+'/'+app+'/not-cached.html');assert.ok(offline.ok());assert.equal(offline.fromServiceWorker(),true);
  assert.equal(await probe.locator('h1').textContent(),'APP READY');
  const data=await probe.evaluate(async()=>{
   const db=await new Promise(resolve=>{const r=indexedDB.open('TEST-navigation-data',1);r.onsuccess=()=>resolve(r.result);});
   const value=await new Promise(resolve=>{const tx=db.transaction('test','readonly');const r=tx.objectStore('test').get('sample');r.onsuccess=()=>resolve(r.result);});db.close();
   return {journal:localStorage.getItem('pub-bizz-cloud-pending:TEST_ONLY'),value};
  });
  assert.deepEqual(data,{journal:'TEST durable request',value:'TEST saved data'});
  await startOrigin();
  const reconnected=await probe.goto(base+'/'+app+'/');assert.ok(reconnected.ok());assert.equal(await probe.locator('h1').textContent(),'APP READY');
  return {app,originalFailure:originalError.split('\n')[0],cachedRedirectFixed:true,connectionLossFallback:true,reconnected:true,journalPreserved:true,indexedDBPreserved:true};
 }finally{await context.close();}
}
(async()=>{
 port=0;await startOrigin();port=server.address().port;const base='http://127.0.0.1:'+port,results=[];
 try{
  for(const engine of (process.env.SW_NAV_BROWSERS||'chromium,webkit').split(',')){
   const browser=await pw[engine].launch({headless:true});
   try{for(const directory of ['pub_bizz_pos','pub_guru']){const result=await check(browser,base,directory);results.push({browser:engine,version:browser.version(),...result});console.log(JSON.stringify(results.at(-1)));}}finally{await browser.close();}
  }
  if(process.env.SW_NAV_RESULTS)fs.writeFileSync(process.env.SW_NAV_RESULTS,JSON.stringify(results,null,2)+'\n');
 }finally{await new Promise(resolve=>server.close(resolve));}
})().catch(e=>{console.error(e);process.exitCode=1;});
