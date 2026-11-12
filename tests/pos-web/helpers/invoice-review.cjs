'use strict';
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const {JSDOM,VirtualConsole}=require('jsdom');
const root=path.resolve(__dirname,'../../../pub_guru');

async function until(predicate){
  for(let i=0;i<200;i++){
    if(predicate())return;
    await new Promise(resolve=>setTimeout(resolve,5));
  }
  throw new Error('Invoice review did not initialize');
}

async function harness({invoice:invoicePatch={},lines:linePatches=[{}],products:productPatches,client,writeHook,context}={}){
  const errors=[],virtualConsole=new VirtualConsole();virtualConsole.on('jsdomError',error=>errors.push(error.message));
  const dom=new JSDOM(fs.readFileSync(path.join(root,'invoice-review-v1.html'),'utf8'),{
    url:'https://invoices.test/pub_guru/invoice-review-v1.html',runScripts:'outside-only',virtualConsole
  });
  const w=dom.window,writes=[];
  const invoice={id:'inv',organization_id:'org',venue_id:'venue',status:'review',supplier_name:'Test supplier',
    invoice_number:'123456',issue_date:'2026-10-10',total_amount_gross:121,payment_status:'unpaid',...invoicePatch};
  const tables={invoices:[invoice],invoice_lines:linePatches.map((patch,i)=>({id:'line-'+i,invoice_id:'inv',organization_id:'org',
    raw_name:'Test vodka',product_id:'product',quantity:1,unit_price_net:100,unit_price_gross:121,vat_rate:21,status:'review',...patch})),
    products:productPatches||[{id:'product',organization_id:'org',name:'Test vodka',volume_ml:700,archived_at:null,aliases:[]}],
    purchase_price_history:[],supplier_product_mappings:[],audit_events:[]};
  w.console={error:assert.fail,warn(){}};
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
      let rows=tables[table].filter(row=>filters.every(filter=>filter(row)));
      if(action==='update'){
        for(const row of rows)Object.assign(row,payload);
        writes.push({table,action,payload});
      }
      if(action==='insert'){
        const row={id:'new-'+writes.length,...payload};tables[table].push(row);rows=[row];
        writes.push({table,action,payload});
        if(writeHook)await writeHook({table,action,payload,invoice,tables});
        if(table==='audit_events'&&payload.event_type==='invoice.posted')invoice.status='posted';
      }
      return {data:single||optional?(rows[0]?structuredClone(rows[0]):null):structuredClone(rows),error:null};
    }
    return query;
  }
  w.PubGuruBackend={loadContext:async()=>context||({organization:{id:'org'},venue:{id:'venue'},user:{id:'user'},role:'manager'}),client:client||{from}};
  for(const name of ['invoice-numbers.js','invoice-review-v2.js','ai-accountant.js'])w.eval(fs.readFileSync(path.join(root,name),'utf8'));
  try{
    await until(()=>w.document.querySelector('.queue-item')&&w.document.getElementById('postBtn').onclick);
    w.document.querySelector('.queue-item').click();
    await until(()=>w.document.querySelector('.review-line')&&w.document.getElementById('accountantChecks').textContent.includes('AI účetní'));
  }catch(error){dom.window.close();throw error;}
  return {dom,w,tables,invoice,writes,async post(){await w.document.getElementById('postBtn').onclick();await Promise.resolve();assert.deepEqual(errors,[],'review must not emit browser errors');}};
}

module.exports={harness,until};
