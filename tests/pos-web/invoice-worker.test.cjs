'use strict';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const vm=require('node:vm');
const source=fs.readFileSync(path.resolve(__dirname,'../../pub_guru/tesseract-fast-worker.js'),'utf8');
const tick=()=>new Promise(resolve=>setImmediate(resolve));

function harness(factory){
  const timers=new Map();let id=0;
  const window={Tesseract:{createWorker:factory},requestIdleCallback(){}};
  const context={window,requestIdleCallback(){},console:{warn(){}},setTimeout(fn,ms){timers.set(++id,{fn,ms});return id;},clearTimeout(key){timers.delete(key);}};
  vm.runInNewContext(source,context);
  return {window,timers,async fire(ms){
    for(let i=0;i<20;i++){
      const entry=[...timers].find(([,t])=>t.ms===ms);
      if(entry){timers.delete(entry[0]);entry[1].fn();await tick();return;}
      await tick();
    }
    assert.fail('No deadline '+ms);
  }};
}

test('a stalled recognition terminates its worker and the next invoice uses a fresh worker',async()=>{
  let created=0,terminated=0;
  const h=harness(async()=>{
    const current=++created;
    return {setParameters:async()=>{},terminate:async()=>{terminated++;},
      recognize:async()=>current===1?new Promise(()=>{}):{data:{text:'next invoice'}}};
  });
  const blocked=h.window.Tesseract.recognize('first').catch(error=>error);
  await h.fire(90000);
  assert.match((await blocked).message,/časový limit/);assert.equal(terminated,1);
  const next=await h.window.Tesseract.recognize('next');
  assert.equal(next.data.text,'next invoice');assert.equal(created,2);assert.equal(h.timers.size,0);
});

test('a worker initialization timeout cannot keep subsequent invoices stuck behind its promise',async()=>{
  let resolveOld,created=0,terminated=0;
  const worker={setParameters:async()=>{},terminate:async()=>{terminated++;},recognize:async()=>({data:{text:'ready'}})};
  const h=harness(()=>++created===1?new Promise(resolve=>{resolveOld=resolve;}):Promise.resolve(worker));
  const blocked=h.window.Tesseract.recognize('first').catch(error=>error);
  await h.fire(60000);assert.match((await blocked).message,/načíst/);
  assert.equal((await h.window.Tesseract.recognize('second')).data.text,'ready');
  resolveOld(worker);await tick();
  assert.equal(terminated,1,'late worker initialization is cleaned up');
  assert.equal(created,2);
});

test('a stalled parameter update is bounded and releases the queue',async()=>{
  let created=0,parameters=0;
  const h=harness(async()=>({setParameters:async()=>{if(++parameters===2)return new Promise(()=>{});},
    terminate:async()=>{},recognize:async()=>({data:{text:'ok'}}),id:++created}));
  const blocked=h.window.Tesseract.recognize('first','ces+eng',{tessedit_pageseg_mode:'6'}).catch(error=>error);
  await h.fire(30000);assert.match((await blocked).message,/nereaguje/);
  assert.equal((await h.window.Tesseract.recognize('second')).data.text,'ok');assert.equal(created,2);
});

test('a worker that hangs during initial setup is terminated before another is created',async()=>{
  let created=0,terminated=0;
  const h=harness(async()=>{
    const current=++created;
    return {setParameters:async()=>current===1?new Promise(()=>{}):undefined,
      terminate:async()=>{terminated++;},recognize:async()=>({data:{text:'next'}})};
  });
  const blocked=h.window.Tesseract.recognize('first').catch(error=>error);
  await h.fire(60000);assert.match((await blocked).message,/načíst/);assert.equal(terminated,1);
  assert.equal((await h.window.Tesseract.recognize('next')).data.text,'next');assert.equal(created,2);
});
