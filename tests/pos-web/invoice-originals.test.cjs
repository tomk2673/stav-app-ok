'use strict';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const {webcrypto}=require('node:crypto');
const {JSDOM}=require('jsdom');

function harness({lostInsert=false}={}){
 const dom=new JSDOM('<div id="queueStatus"></div><div id="ocrProgressWrap"></div><div id="ocrStatus"></div><div id="ocrProgress"></div>',{runScripts:'outside-only'});
 const w=dom.window,objects=new Map(),jobs=[],uploads=[];
 const ctx={organization:{id:'org'},venue:{id:'venue'},user:{id:'user'}};
 Object.defineProperty(w,'crypto',{value:webcrypto});w.console={warn(){},error(){}};
 w.PubGuruBackend={loadContext:async()=>ctx,client:{from(table){return {select(){return this},eq(){return this},
  maybeSingle:async()=>({data:table==='invoice_capture_jobs'&&jobs.length?jobs[0]:null,error:null}),
  async insert(data){jobs.push(data);if(lostInsert){lostInsert=false;return {error:new Error('Response lost after commit')};}return {error:null};}};},
  storage:{from(){return {async upload(name,file,options){
   assert.equal(options.upsert,false);uploads.push({name,file,options});
   if(objects.has(name))return {error:{statusCode:'409'}};
   objects.set(name,new Uint8Array(await file.arrayBuffer()));return {error:null};},
   async download(name){return {data:new Blob([objects.get(name)]),error:null};},
   async remove(){assert.fail('a source must not be deleted after a lost insert response');}};}}}};
 w.eval(fs.readFileSync(path.join(__dirname,'../../pub_guru/invoice-fast-capture.js'),'utf8'));
 const bytes=new Uint8Array([0,0,0,24,102,116,121,112,104,101,105,99]);
 const file={name:'fiktivni.heic',type:'image/heic',size:bytes.length,arrayBuffer:async()=>bytes.slice().buffer};
 return {dom,w,objects,jobs,uploads,file,bytes,ctx};
}
test('camera/batch HEIC saves exact original bytes and hashes instead of a recompressed JPEG',async()=>{
 const h=harness();try{
  assert.deepEqual({...await h.w.PubGuruFastCapture.queueFiles([h.file])},{queued:1,duplicates:0,failed:0});
  assert.equal(h.objects.size,1);assert.deepEqual([...h.objects.values()][0],h.bytes);
  assert.equal(h.jobs[0].mime_type,'image/heic');assert.equal(h.uploads[0].file,h.file);
  const hash=Buffer.from(await webcrypto.subtle.digest('SHA-256',h.bytes)).toString('hex');
  assert.equal(h.jobs[0].source_fingerprint,hash);assert.ok(h.jobs[0].source_path.includes(hash));
 }finally{h.dom.window.close();}
});
test('single-document preservation verifies a pre-existing private original on replay',async()=>{
 const h=harness();try{
  const hash=Buffer.from(await webcrypto.subtle.digest('SHA-256',h.bytes)).toString('hex');
  const first=await h.w.PubGuruFastCapture.preserveOriginal(h.file,h.ctx,hash);
  const next=await h.w.PubGuruFastCapture.preserveOriginal(h.file,h.ctx,hash);
  assert.equal(first.path,next.path);assert.equal(h.objects.size,1);
  h.objects.set(first.path,new Uint8Array([1,2,3]));
  await assert.rejects(h.w.PubGuruFastCapture.preserveOriginal(h.file,h.ctx,hash),/neodpovídá/);
 }finally{h.dom.window.close();}
});
test('lost queue insert response preserves committed source and retry discovers the same job',async()=>{
 const h=harness({lostInsert:true});try{
  assert.equal((await h.w.PubGuruFastCapture.queueFiles([h.file])).failed,1);
  assert.equal(h.objects.size,1);assert.equal(h.jobs.length,1);
  assert.equal((await h.w.PubGuruFastCapture.queueFiles([h.file])).duplicates,1);assert.equal(h.jobs.length,1);
 }finally{h.dom.window.close();}
});
