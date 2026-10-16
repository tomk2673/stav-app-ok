'use strict';
const test=require('node:test'), assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
function redirected(body='APP'){
 const response=new Response(body,{status:200,headers:{'Content-Type':'text/html; charset=utf-8','Content-Security-Policy':"default-src 'self'",'X-Content-Type-Options':'nosniff'}});
 Object.defineProperty(response,'redirected',{value:true});return response;
}
function worker(directory){
 const events={},calls=[],deleted=[],precached=[],saved=[];let hit=null,fallback=null,offline=false;
 const cache={addAll:async urls=>precached.push(...urls),match:async input=>typeof input==='string'?fallback:hit,put:async(key,value)=>saved.push(value)};
 const caches={open:async()=>cache,keys:async()=>['pub-bizz-pos-shell-old','pub-guru-shell-old','unrelated-cache'],delete:async key=>deleted.push(key)};
 const self={location:{origin:'https://pos.test'},addEventListener:(name,fn)=>events[name]=fn,skipWaiting:async()=>{},clients:{claim:async()=>{}},registration:{unregister:async()=>{}}};
 vm.runInNewContext(fs.readFileSync(path.resolve(__dirname,'../',directory,'sw.js'),'utf8'),{self,caches,URL,Response,fetch:async(request,options)=>{calls.push({request,options});if(offline)throw new Error('TEST offline');return redirected();}});
 function dispatch(name,request){let result;events[name]({request,respondWith:p=>result=p,waitUntil:p=>result=p});return result;}
 const request={method:'GET',url:'https://pos.test/'+directory+'/',mode:'navigate',redirect:'manual'};
 return {calls,deleted,precached,saved,request,dispatch,set hit(value){hit=value;},set fallback(value){fallback=value;},set offline(value){offline=value;}};
}
for(const directory of ['pub_bizz_pos','pub_guru']){
 test(directory+': install precaches canonical files without a redirecting directory alias',async()=>{
  const w=worker(directory);await w.dispatch('install');assert.ok(w.precached.length>5);assert.ok(w.precached.every(x=>x!=='./'));
 });
 test(directory+': manual navigation follows network redirects internally and returns final HTML with security headers and no redirect flag',async()=>{
  const w=worker(directory),res=await w.dispatch('fetch',w.request);
  assert.equal(w.calls[0].options.redirect,'follow');assert.equal(res.redirected,false);assert.equal(res.status,200);
  assert.equal(res.headers.get('Content-Security-Policy'),"default-src 'self'");assert.equal(res.headers.get('X-Content-Type-Options'),'nosniff');assert.equal(await res.text(),'APP');
  assert.ok(w.saved.every(x=>!x.redirected));
 });
 test(directory+': an old cached redirected response is safe after network loss',async()=>{
  const w=worker(directory);w.hit=redirected('CACHED');w.offline=true;
  const res=await w.dispatch('fetch',w.request);assert.equal(res.redirected,false);assert.equal(await res.text(),'CACHED');
 });
 test(directory+': offline fallback also clears redirect metadata without weakening its headers',async()=>{
  const w=worker(directory);w.offline=true;w.fallback=redirected('FALLBACK');
  const res=await w.dispatch('fetch',w.request);assert.equal(res.redirected,false);assert.equal(await res.text(),'FALLBACK');assert.equal(res.headers.get('Content-Security-Policy'),"default-src 'self'");
 });
 test(directory+': missing cache and network failure remain a real error; external and POST requests are untouched',async()=>{
  const w=worker(directory);w.offline=true;await assert.rejects(w.dispatch('fetch',w.request),/offline/);
  assert.equal(w.dispatch('fetch',{...w.request,method:'POST'}),undefined);assert.equal(w.dispatch('fetch',{...w.request,url:'https://api.test/endpoint'}),undefined);
 });
 test(directory+': script response URL semantics are preserved; only own shell caches are retired',async()=>{
  const w=worker(directory);const res=await w.dispatch('fetch',{...w.request,url:'https://pos.test/'+directory+'/app.js',mode:'cors',redirect:'follow'});
  assert.equal(res.redirected,true);assert.equal(w.calls[0].options,undefined);
  await w.dispatch('activate');assert.deepEqual(w.deleted,directory==='pub_bizz_pos'?['pub-bizz-pos-shell-old']:['pub-guru-shell-old']);
 });
}
test('POS installed-app start is canonical and root worker retirement does not delete business storage',()=>{
 const root=path.resolve(__dirname,'..'),manifest=JSON.parse(fs.readFileSync(path.join(root,'pub_bizz_pos/manifest.webmanifest'),'utf8'));
 assert.equal(manifest.start_url,'./index.html');
 for(const relative of ['sw.js','pub_bizz_pos/sw.js','pub_guru/sw.js'])assert.doesNotMatch(fs.readFileSync(path.join(root,relative),'utf8'),/indexedDB\s*\.\s*deleteDatabase|localStorage\s*\.\s*clear/);
});
test('invoice API readiness never replays or stores a cached authenticated response',()=>{
 const w=worker('pub_guru');w.hit=new Response('{"configured":true}',{status:200});
 const request={...w.request,url:'https://pos.test/api/invoice-vision?organization_id=test',mode:'cors'};
 assert.equal(w.dispatch('fetch',request),undefined);assert.equal(w.dispatch('fetch',request),undefined);
 assert.equal(w.saved.length,0,'browser handles API requests directly without a service-worker cache');
});
