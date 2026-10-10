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

async function harness({invoice:invoicePatch={},lines:linePatches=[{}]}={}){
  const dom=new JSDOM(fs.readFileSync(path.join(root,'invoice-review-v1.html'),'utf8'),{
    url:'https://invoices.test/pub_guru/invoice-review-v1.html',runScripts:'outside-only'
  });
  const w=dom.window,writes=[];
  const invoice={id:'inv',organization_id:'org',venue_id:'venue',status:'review',supplier_name:'Test supplier',
    invoice_number:'123456',issue_date:'2026-10-10',total_amount_gross:121,payment_status:'unpaid',...invoicePatch};
  const tables={invoices:[invoice],invoice_lines:linePatches.map((patch,i)=>({id:'line-'+i,invoice_id:'inv',organization_id:'org',
    raw_name:'Test vodka',product_id:'product',quantity:1,unit_price_net:100,unit_price_gross:121,vat_rate:21,status:'review',...patch})),
    products:[{id:'product',organization_id:'org',name:'Test vodka',volume_ml:700,archived_at:null,aliases:[]}],
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
        if(table==='audit_events'&&payload.event_type==='invoice.posted')invoice.status='posted';
      }
      return {data:single||optional?(rows[0]?structuredClone(rows[0]):null):structuredClone(rows),error:null};
    }
    return query;
  }
  w.PubGuruBackend={loadContext:async()=>({organization:{id:'org'},venue:{id:'venue'},user:{id:'user'},role:'manager'}),client:{from}};
  for(const name of ['invoice-review-v2.js','ai-accountant.js'])w.eval(fs.readFileSync(path.join(root,name),'utf8'));
  await until(()=>w.document.querySelector('.queue-item')&&w.document.getElementById('postBtn').onclick);
  w.document.querySelector('.queue-item').click();
  await until(()=>w.document.querySelector('.review-line')&&w.document.getElementById('accountantChecks').textContent.includes('AI účetní'));
  return {dom,w,tables,invoice,writes,async post(){await w.document.getElementById('postBtn').onclick();}};
}

test('missing VAT stays unselected and cannot write stock, history or approval',async()=>{
  const h=await harness({lines:[{vat_rate:null,unit_price_gross:null,original_values:{ocr_vat_rate:null}}]});
  try{
    assert.equal(h.w.document.querySelector('.vat').value,'');
    assert.equal(h.w.document.querySelector('.gross').value,'','a net price cannot become a gross price without VAT');
    assert.match(h.w.document.getElementById('accountantChecks').textContent,/Doplň sazbu DPH/);
    await h.post();assert.equal(h.writes.length,0);
    assert.equal(h.invoice.status,'review');
  }finally{h.dom.window.close();}
});

test('an explicitly printed zero VAT rate remains valid and the accountant reads actual price/product fields',async()=>{
  const h=await harness({invoice:{total_amount_gross:100},lines:[{vat_rate:0,unit_price_gross:100}]});
  try{
    assert.equal(h.w.document.querySelector('.vat').value,'0');
    assert.doesNotMatch(h.w.document.getElementById('accountantChecks').textContent,/nemá cenu|Vyber produkt|Doplň sazbu|nesedí/);
    await h.post();
    assert.equal(h.tables.audit_events.filter(x=>x.event_type==='invoice.posted').length,1);
    assert.equal(h.tables.invoice_lines[0].vat_rate,0);
    assert.equal(h.tables.invoice_lines[0].unit_price_net,100);
  }finally{h.dom.window.close();}
});

test('screen-reported 1000 gas units and excise-as-total are blocked before any database mutation',async()=>{
  const h=await harness({invoice:{total_amount_gross:629.2},lines:[
    {raw_name:'0361 CO2 15kg',quantity:1000,unit_price_net:570.25,unit_price_gross:570.25,vat_rate:0},
    {raw_name:'0323 Pivoplyn 201 (15kg)',quantity:1000,unit_price_net:599.17,unit_price_gross:599.17,vat_rate:0}
  ]});
  try{
    assert.match(h.w.document.getElementById('accountantChecks').textContent,/Součet položek.*nesedí/);
    await h.post();
    assert.equal(h.writes.length,0,'no price learning, products, history, invoice or audit can be written');
    assert.match(h.w.document.getElementById('toast').textContent,/Součet položek.*nesedí/);
  }finally{h.dom.window.close();}
});

test('correcting an invoice total rechecks the UI and permits a balanced approval',async()=>{
  const h=await harness({invoice:{total_amount_gross:100}});
  try{
    await h.post();assert.equal(h.writes.length,0);
    const total=h.w.document.getElementById('totalGross');total.value='121';total.dispatchEvent(new h.w.Event('input',{bubbles:true}));
    assert.doesNotMatch(h.w.document.getElementById('accountantChecks').textContent,/nesedí/);
    await h.post();
    assert.equal(h.invoice.status,'posted');
    assert.equal(h.tables.purchase_price_history.length,1);
  }finally{h.dom.window.close();}
});

test('ignored deposits and their negative returns count in the total without product mapping or stock approval',async()=>{
  const h=await harness({lines:[{},
    {raw_name:'Záloha obal',product_id:null,quantity:1,unit_price_gross:1000,vat_rate:0,status:'ignored'},
    {raw_name:'Vrácená záloha obal',product_id:null,quantity:-1,unit_price_gross:1000,vat_rate:0,status:'ignored'}
  ]});
  try{
    assert.equal(h.w.PubGuruInvoiceReview.check().issues.length,0);
    await h.post();
    assert.equal(h.tables.purchase_price_history.length,1);
    assert.equal(h.tables.invoice_lines[1].status,'ignored');
    assert.equal(h.tables.invoice_lines[2].status,'ignored');
    assert.equal(h.tables.invoice_lines[1].line_total_gross,1000,'ignored financial amounts remain available for retry or later review');
    assert.equal(h.tables.invoice_lines[2].line_total_gross,-1000);
    assert.equal(h.tables.audit_events.at(-1).after_data.approved_lines,1);
  }finally{h.dom.window.close();}
});

test('missing document number prevents approval even when prices and totals match',async()=>{
  const h=await harness({invoice:{invoice_number:''}});
  try{
    assert.match(h.w.document.getElementById('accountantChecks').textContent,/Doplň číslo faktury/);
    await h.post();assert.equal(h.writes.length,0);
  }finally{h.dom.window.close();}
});

test('OCR names and warnings are displayed as text inside accountant checks',async()=>{
  const name='<img src=x onerror="window.injected=true">';
  const h=await harness({lines:[{raw_name:name,product_id:null,original_values:{parser_warning:name}}]});
  try{
    const box=h.w.document.getElementById('accountantChecks');
    assert.ok(box.textContent.includes(name));
    assert.equal(box.querySelector('img'),null);
    assert.equal(h.w.document.querySelector('#lines img'),null);
    await h.post();assert.equal(h.writes.length,0);
  }finally{h.dom.window.close();}
});
