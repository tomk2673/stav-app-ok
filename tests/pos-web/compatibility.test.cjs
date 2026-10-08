'use strict';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const {webcrypto}=require('node:crypto');
const {JSDOM}=require('jsdom');
const {parse}=require('acorn');
const root=path.resolve(__dirname,'../../pub_bizz_pos');
const read=name=>fs.readFileSync(path.join(root,name),'utf8');
function harness(url='https://pos.test/pub_bizz_pos/index.html'){
  const dom=new JSDOM(read('index.html'),{url,runScripts:'outside-only'}),w=dom.window;
  w.fetch=async()=>{};w.TextEncoder=TextEncoder;
  Object.defineProperty(w,'crypto',{value:webcrypto,configurable:true});
  w.HTMLDialogElement.prototype.showModal=function(){};w.HTMLDialogElement.prototype.close=function(){};
  w.eval(read('compat.js'));return {dom,w};
}
test('all shipped browser scripts parse as ES2021; the startup remedy itself parses as ES5',()=>{
  const scripts=[...read('index.html').matchAll(/<script src="\.\/([^"]+)"/g)].map(m=>m[1]);
  for(const script of scripts)assert.doesNotThrow(()=>parse(read(script),{ecmaVersion:2021}),script);
  parse(read('sw.js'),{ecmaVersion:2021});parse(read('compat.js'),{ecmaVersion:5});
});
test('startup checks support HTTPS and loopback without changing saved sessions or pending operations',()=>{
  for(const url of ['https://pos.test/pub_bizz_pos/index.html','http://127.0.0.1/pub_bizz_pos/index.html']){
    const {dom,w}=harness(url);try{
      w.localStorage.setItem('sb-project-auth-token','saved-session');w.localStorage.setItem('pub-bizz-cloud-pending:test','saved-operation');
      w.POSRuntime.assertReady();
      assert.equal(w.localStorage.length,2);assert.equal(w.localStorage.getItem('sb-project-auth-token'),'saved-session');assert.equal(w.localStorage.getItem('pub-bizz-cloud-pending:test'),'saved-operation');
    }finally{dom.window.close();}
  }
});
test('blocked or full storage stops bootstrap before SDK initialization or opening a local register',()=>{
  for(const errorName of ['SecurityError','QuotaExceededError']){
    const {dom,w}=harness();try{
      Object.defineProperty(w,'localStorage',{get(){throw new w.DOMException('blocked',errorName);}});
      let clients=0,localOpens=0;
      w.POSStore={open:async()=>{localOpens++;}};w.POSCore={};w.POS_CONFIG={url:'https://api.test',publishableKey:'public'};
      w.supabase={createClient:()=>{clients++;}};w.eval(read('cloud.js'));w.eval(read('app.js'));
      assert.equal(clients,0);assert.equal(localOpens,0);assert.equal(w.POSCloud,undefined);
      assert.match(w.document.querySelector('#app').textContent,/Povol data webu/);
    }finally{dom.window.close();}
  }
});
test('missing or throwing SDK stops the online page instead of silently opening local IndexedDB',()=>{
  for(const sdk of [undefined,{createClient(){throw new Error('SDK initialization failed');}}]){
    const {dom,w}=harness();try{
      let localOpens=0;w.POSStore={open:async()=>{localOpens++;}};w.POSCore={};w.POS_CONFIG={url:'https://api.test',publishableKey:'public'};w.supabase=sdk;
      w.eval(read('cloud.js'));w.eval(read('app.js'));
      assert.equal(localOpens,0);assert.equal(w.POSCloud,undefined);
      assert.match(w.document.querySelector('#app').textContent,/Pokladnu nelze otevřít/);
    }finally{dom.window.close();}
  }
});
test('missing modern APIs and insecure production origins get a visible remedy',()=>{
  const {dom,w}=harness();try{
    w.eval('Object.fromEntries=undefined');assert.throws(()=>w.POSRuntime.assertReady(),/příliš starý/);
    w.document.dispatchEvent(new w.Event('DOMContentLoaded'));assert.match(w.document.querySelector('#app').textContent,/Firefox ESR 115/);
  }finally{dom.window.close();}
  const insecure=harness('http://pos.test/pub_bizz_pos/index.html');try{
    assert.throws(()=>insecure.w.POSRuntime.assertReady(),/zabezpečenou adresu/);
  }finally{insecure.dom.window.close();}
});
test('failed script loading renders a remedy even when the application script never executes',()=>{
  const {dom,w}=harness();try{
    w.document.querySelector('script[src="./app.js"]').dispatchEvent(new w.Event('error'));
    assert.match(w.document.querySelector('#app').textContent,/načíst všechny součásti/);
    assert.throws(()=>w.POSRuntime.assertReady(),/načíst všechny součásti/);
  }finally{dom.window.close();}
});
test('the emergency HTML includes its own compatibility guard and has no external scripts',()=>{
  const html=read('PUB-BIZZ-pokladna-offline.html');
  assert.match(html,/data-standalone="true"/);assert.match(html,/root\.POSRuntime=/);
  assert.doesNotMatch(html,/<script[^>]+src=/i);
  const {dom,w}=harness('file:///tmp/PUB-BIZZ-pokladna-offline.html');try{
    w.document.documentElement.setAttribute('data-standalone','true');
    Object.defineProperty(w,'localStorage',{get(){throw new Error('not available on file origin');}});
    assert.doesNotThrow(()=>w.POSRuntime.assertReady());
  }finally{dom.window.close();}
});
