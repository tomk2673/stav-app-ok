const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const {JSDOM}=require('jsdom');
const guru=path.resolve(__dirname,'../../pub_guru');
test('live stock refresh preserves inventory session and unsaved measurement inputs',async()=>{
 const dom=new JSDOM(fs.readFileSync(path.join(guru,'index.html'),'utf8'),{url:'https://app.test/pub_guru/index.html',runScripts:'outside-only',pretendToBeVisual:true});
 const w=dom.window;w.scrollTo=()=>{};
 try {
  w.eval(fs.readFileSync(path.join(guru,'app.js'),'utf8'));
  await new Promise(r=>w.addEventListener('load',r,{once:true}));
  const before=JSON.parse(w.localStorage.getItem('stav_app_v1'));
  w.document.querySelector('#grossWeight').value='512.3';w.document.querySelector('#inventoryNote').value='Rozpracované měření';
  w.document.querySelector('#ocrText').value='Rozpracovaná faktura';
  const movements=[{id:'db_test',productId:before.products[0].id,type:'sale',quantityMl:-40}];
  w.PubGuruApplyStockSnapshot({products:before.products,movements,backend:{syncedAt:new Date().toISOString(),pendingPosCount:1}});
  const after=JSON.parse(w.localStorage.getItem('stav_app_v1'));
  assert.deepEqual(after.currentInventory,before.currentInventory);
  assert.deepEqual(after.movements,movements);
  assert.equal(w.document.querySelector('#grossWeight').value,'512.3');
  assert.equal(w.document.querySelector('#inventoryNote').value,'Rozpracované měření');
  assert.equal(w.document.querySelector('#ocrText').value,'Rozpracovaná faktura');
 }finally{w.close();}
});
