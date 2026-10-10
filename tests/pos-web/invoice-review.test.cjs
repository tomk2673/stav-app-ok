'use strict';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const {JSDOM}=require('jsdom');
const root=path.resolve(__dirname,'../../pub_guru');

async function until(predicate){
  for(let i=0;i<200;i++){
    if(predicate())return;
    await new Promise(resolve=>setTimeout(resolve,5));
  }
  throw new Error('Invoice review did not initialize');
}

async function harness({invoiceError=false,auditError=false,lostResponse=false,alreadyPosted=false}={}){
  const dom=new JSDOM(fs.readFileSync(path.join(root,'invoice-review-v1.html'),'utf8'),{
    url:'https://invoices.test/pub_guru/invoice-review-v1.html',runScripts:'outside-only'
  });
  const w=dom.window,writes=[],calls=[];
  const invoice={id:'inv',organization_id:'org',venue_id:'venue',status:'review',supplier_name:'Test',
    invoice_number:'1',issue_date:'2026-10-10',total_amount_gross:121,payment_status:'unpaid'};
  const tables={invoices:[invoice],invoice_lines:[{id:'line',invoice_id:'inv',organization_id:'org',
    raw_name:'Vodka',product_id:'product',quantity:1,unit_price_net:100,unit_price_gross:121,vat_rate:21,status:'review'}],
    products:[{id:'product',organization_id:'org',name:'Vodka',volume_ml:700,archived_at:null,aliases:[]}],
    purchase_price_history:[],supplier_product_mappings:[],audit_events:[]};
  const job={status:'review',invoice_id:'inv'};
  w.console={error(){},warn(){}};
  function from(table){
    let action='select',payload,filters=[];
    const query={
      select(){return this;},eq(key,value){filters.push(row=>row[key]===value);return this;},
      is(key,value){return this.eq(key,value);},in(key,values){filters.push(row=>values.includes(row[key]));return this;},
      order(){return this;},limit(){return this;},
      update(data){action='update';payload=data;return this;},
      insert(data){action='insert';payload=data;return this;},upsert(data){return this.insert(data);},
      single(){return execute(true);},maybeSingle(){return execute(false,true);},
      then(resolve,reject){return execute().then(resolve,reject);}
    };
    async function execute(single=false,optional=false){
      calls.push({table,action});
      let rows=tables[table].filter(row=>filters.every(filter=>filter(row)));
      if(action==='update'){
        if(table==='invoices'&&invoiceError)return {data:null,error:new Error('Invoice save rejected')};
        for(const row of rows)Object.assign(row,payload);
        writes.push({table,action,payload});
      }
      if(action==='insert'){
        if(table==='audit_events'&&auditError)return {data:null,error:new Error('Posting rejected')};
        const row={id:'new-'+writes.length,...payload};tables[table].push(row);rows=[row];
        writes.push({table,action,payload});
        if(table==='audit_events'&&payload.event_type==='invoice.posted'){
          invoice.status='posted';job.status='done';
          if(lostResponse){lostResponse=false;throw new Error('Posting response was lost');}
        }
      }
      if(single&&rows.length!==1)return {data:null,error:new Error('No authorized row was saved')};
      return {data:single||optional?(rows[0]?structuredClone(rows[0]):null):structuredClone(rows),error:null};
    }
    return query;
  }
  w.PubGuruBackend={loadContext:async()=>({organization:{id:'org'},venue:{id:'venue'},user:{id:'user'},role:'manager'}),
    client:{from}};
  w.eval(fs.readFileSync(path.join(root,'invoice-review-v2.js'),'utf8'));
  await until(()=>w.document.querySelector('.queue-item')&&w.document.getElementById('postBtn').onclick);
  w.document.querySelector('.queue-item').click();
  await until(()=>w.document.querySelector('.review-line'));
  if(alreadyPosted){invoice.status='posted';job.status='done';}
  return {dom,w,tables,job,invoice,writes,calls,setAuditError(value){auditError=value;},
    async post(){await w.document.getElementById('postBtn').onclick();}};
}

test('review posts once, removes the pending invoice and ignores repeated concurrent clicks',async()=>{
  const h=await harness();
  try{
    await Promise.all([h.post(),h.post()]);
    assert.equal(h.invoice.status,'posted');assert.equal(h.job.status,'done');
    assert.equal(h.tables.audit_events.filter(x=>x.event_type==='invoice.posted').length,1);
    assert.equal(h.tables.purchase_price_history.length,1);
    assert.equal(h.w.document.getElementById('queueCount').textContent,'0');
    assert.equal(h.w.document.getElementById('postBtn').disabled,false);
    assert.equal(h.w.document.getElementById('editor').classList.contains('hidden'),true);
    await h.post();assert.equal(h.tables.audit_events.length,1);
  }finally{h.dom.window.close();}
});

test('failed invoice save cannot insert a posting audit or remove the pending document',async()=>{
  const h=await harness({invoiceError:true});
  try{
    await h.post();
    assert.equal(h.invoice.status,'review');assert.equal(h.job.status,'review');
    assert.equal(h.tables.audit_events.length,0);
    assert.equal(h.w.document.getElementById('editor').classList.contains('hidden'),false);
    assert.equal(h.w.document.getElementById('postBtn').disabled,false);
    assert.match(h.w.document.getElementById('toast').textContent,/selhalo/);
  }finally{h.dom.window.close();}
});

test('failed posting stays in review; retry finishes and reuses purchase price history',async()=>{
  const h=await harness({auditError:true});
  try{
    await h.post();
    assert.equal(h.invoice.status,'approved');assert.equal(h.job.status,'review');
    assert.equal(h.tables.audit_events.length,0);
    assert.equal(h.w.document.getElementById('editor').classList.contains('hidden'),false);
    h.setAuditError(false);await h.post();
    assert.equal(h.job.status,'done');assert.equal(h.tables.audit_events.length,1);
    assert.equal(h.tables.purchase_price_history.length,1);
    assert.equal(h.w.document.getElementById('queueCount').textContent,'0');
  }finally{h.dom.window.close();}
});

test('lost audit response is reconciled against posted state and does not repeat approval',async()=>{
  const h=await harness({lostResponse:true});
  try{
    await h.post();
    assert.equal(h.invoice.status,'posted');assert.equal(h.job.status,'done');
    assert.equal(h.tables.audit_events.length,1);
    assert.equal(h.w.document.getElementById('queueCount').textContent,'0');
    assert.match(h.w.document.getElementById('toast').textContent,/uložena/);
    await h.post();assert.equal(h.tables.audit_events.length,1);
  }finally{h.dom.window.close();}
});

test('a stale editor after another device posts is closed without rewriting invoice, lines or prices',async()=>{
  const h=await harness({alreadyPosted:true});
  try{
    await h.post();assert.equal(h.writes.length,0);
    assert.equal(h.w.document.getElementById('queueCount').textContent,'0');
    assert.equal(h.w.document.getElementById('editor').classList.contains('hidden'),true);
  }finally{h.dom.window.close();}
});

test('an inaccessible invoice cannot be posted using a stale editor',async()=>{
  const h=await harness();
  try{
    h.invoice.organization_id='other';await h.post();
    assert.equal(h.writes.length,0);assert.equal(h.job.status,'review');
    assert.equal(h.w.document.getElementById('editor').classList.contains('hidden'),false);
    assert.match(h.w.document.getElementById('toast').textContent,/selhalo/);
  }finally{h.dom.window.close();}
});
