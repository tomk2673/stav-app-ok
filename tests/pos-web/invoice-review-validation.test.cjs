'use strict';
const {test}=require('node:test');
const assert=require('node:assert/strict');

const {harness}=require('./helpers/invoice-review.cjs');

function input(h,selector,value){const e=h.w.document.querySelector(selector);e.value=value;e.dispatchEvent(new h.w.Event('input',{bubbles:true}));}

for(const currency of ['EUR',null])test('queued AI invoice cannot post foreign/unknown currency as CZK: '+currency,async()=>{
  const h=await harness({invoice:{raw_extraction:{crop:{vision:true,invoice:{currency,document_type:'invoice'}}}}});
  try{await h.post();assert.equal(h.writes.length,0);assert.match(h.w.PubGuruInvoiceReview.check().issues.join(' '),/měnu CZK/);}
  finally{h.dom.window.close();}
});

test('printed discount survives approval without overwriting the unit price and learns effective purchase cost',async()=>{
  const original={ocr_unit_gross:100,ocr_line_gross:900,parser_warning:'Sleva na řádku'};
  const h=await harness({invoice:{total_amount_gross:900},lines:[{quantity:10,unit_price_net:100,unit_price_gross:100,
    vat_rate:0,line_total_net:900,line_total_gross:900,original_values:original}]});
  try{
    assert.equal(h.w.document.querySelector('.linegross').value,'900');
    assert.equal(h.w.PubGuruInvoiceReview.check().issues.length,0);
    await h.post();
    const line=h.tables.invoice_lines[0],audit=h.tables.audit_events.at(-1);
    assert.equal(line.unit_price_gross,100);assert.equal(line.unit_price_net,100);assert.equal(line.line_total_gross,900);
    assert.equal(h.tables.products[0].current_purchase_price_gross,90);
    assert.equal(h.tables.purchase_price_history[0].unit_price_gross,90);
    assert.deepEqual(line.original_values,original);
    assert.equal(audit.before_data.lines[0].unit_price_gross,100);
    assert.equal(audit.after_data.lines[0].adjustment_gross,-100);
    assert.equal(audit.after_data.lines[0].effective_unit_gross,90);
  }finally{h.dom.window.close();}
});

test('an edited discounted line total changes cost and totals while printed unit price remains intact',async()=>{
  const h=await harness({invoice:{total_amount_gross:1089},lines:[{quantity:10,unit_price_net:100,unit_price_gross:121,
    vat_rate:21,line_total_net:1000,line_total_gross:1210}]});
  try{
    input(h,'.linegross','1 089,00');
    const c=h.w.PubGuruInvoiceReview.check();
    assert.equal(c.issues.length,0);assert.equal(c.totalNet,900);assert.equal(c.vatTotal,189);
    await h.post();
    const l=h.tables.invoice_lines[0];assert.equal(l.unit_price_net,100);assert.equal(l.unit_price_gross,121);
    assert.equal(l.line_total_net,900);assert.equal(l.line_total_gross,1089);
    assert.equal(h.tables.purchase_price_history[0].unit_price_net,90);
    assert.equal(h.tables.purchase_price_history[0].unit_price_gross,108.9);
  }finally{h.dom.window.close();}
});

test('stored zero line totals are a full discount rather than a missing amount',async()=>{
  const h=await harness({invoice:{total_amount_gross:0},lines:[{quantity:10,unit_price_gross:100,unit_price_net:100,
    vat_rate:0,line_total_net:0,line_total_gross:0}]});
  try{
    assert.equal(h.w.document.querySelector('.linegross').value,'0');
    assert.equal(h.w.document.getElementById('totalGross').value,'0');
    await h.post();
    assert.equal(h.invoice.status,'posted');assert.equal(h.tables.invoice_lines[0].unit_price_gross,100);
    assert.equal(h.tables.invoice_lines[0].line_total_gross,0);assert.equal(h.tables.products[0].current_purchase_price_gross,0);
  }finally{h.dom.window.close();}
});

test('stored net rounding is preserved and recalculation is an explicit action',async()=>{
  const h=await harness({invoice:{total_amount_gross:1.03},lines:[{quantity:3,unit_price_net:0.29,unit_price_gross:0.34,
    vat_rate:21,line_total_net:0.85,line_total_gross:1.03}]});
  try{
    assert.equal(h.w.PubGuruInvoiceReview.check().rows[0].lineNet,0.85);
    input(h,'.qty','4');
    assert.equal(h.w.PubGuruInvoiceReview.check().rows[0].lineGross,1.03,'editing qty cannot silently erase a printed total');
    h.w.document.querySelector('.recalculate').click();
    assert.equal(h.w.PubGuruInvoiceReview.check().rows[0].lineGross,1.36);
    input(h,'#totalGross','1,36');await h.post();
    assert.equal(h.tables.invoice_lines[0].line_total_gross,1.36);assert.equal(h.tables.invoice_lines[0].unit_price_net,0.29);
  }finally{h.dom.window.close();}
});

test('a negative credit note posts signed amounts and leaves current purchase prices unchanged',async()=>{
  const h=await harness({invoice:{total_amount_gross:-108.9},lines:[{quantity:-1,unit_price_net:100,unit_price_gross:121,
    vat_rate:21,line_total_net:-90,line_total_gross:-108.9}]});
  try{
    assert.equal(h.w.PubGuruInvoiceReview.check().issues.length,0);
    await h.post();
    assert.equal(h.invoice.status,'posted');assert.equal(h.tables.invoice_lines[0].quantity,-1);
    assert.equal(h.tables.invoice_lines[0].line_total_net,-90);assert.equal(h.tables.invoice_lines[0].line_total_gross,-108.9);
    assert.equal(h.tables.purchase_price_history.length,0);
    assert.ok(h.writes.filter(x=>x.table==='products').every(x=>!Object.hasOwn(x.payload,'current_purchase_price')&&!Object.hasOwn(x.payload,'current_purchase_price_gross')));
  }finally{h.dom.window.close();}
});

test('monetary dash input and fractional quantities use separate parsers in review',async()=>{
  const h=await harness({invoice:{total_amount_gross:1500},lines:[{quantity:1.5,unit_price_net:1000,unit_price_gross:1000,vat_rate:0}]});
  try{
    input(h,'.gross','1.000,-');input(h,'.qty','1,5');input(h,'#totalGross','1 500,00');
    assert.equal(h.w.PubGuruInvoiceReview.check().issues.length,0);
    await h.post();assert.equal(h.tables.invoice_lines[0].quantity,1.5);assert.equal(h.tables.invoice_lines[0].unit_price_gross,1000);
  }finally{h.dom.window.close();}
});

for(const [label,selector,value] of [['missing document amount','#totalGross',''],['invalid money','.gross','--100'],
  ['currency as quantity','.qty','1.000,-'],['invalid printed total','.linegross','?'],['negative unit price','.gross','-121'],
  ['return amount with positive qty','.linegross','-121'],['invalid package volume','.vol','0']]){
  test(label+' blocks all mutations before posting',async()=>{
    const h=await harness();try{input(h,selector,value);await h.post();assert.equal(h.writes.length,0);}finally{h.dom.window.close();}
  });
}

test('ignored standalone discount and rounding amounts count without quantity or stock',async()=>{
  const h=await harness({invoice:{total_amount_gross:100},lines:[{},
    {raw_name:'Sleva dokladu',product_id:null,quantity:null,unit_price_net:null,unit_price_gross:null,vat_rate:0,line_total_net:-21.05,line_total_gross:-21.05,status:'ignored'},
    {raw_name:'Zaokrouhlení',product_id:null,quantity:null,unit_price_net:null,unit_price_gross:null,vat_rate:0,line_total_net:0.05,line_total_gross:0.05,status:'ignored'}
  ]});
  try{
    assert.equal(h.w.PubGuruInvoiceReview.check().issues.length,0);await h.post();
    assert.equal(h.tables.invoice_lines[1].line_total_gross,-21.05);assert.equal(h.tables.invoice_lines[2].line_total_gross,0.05);
    assert.equal(h.tables.purchase_price_history.length,1);
  }finally{h.dom.window.close();}
});

test('missing VAT on an ignored financial line is not silently zero-rated',async()=>{
  const h=await harness({lines:[{status:'ignored',vat_rate:null,line_total_gross:0}]});
  try{await h.post();assert.equal(h.writes.length,0);assert.match(h.w.PubGuruInvoiceReview.check().issues.join(' '),/Doplň sazbu DPH/);}finally{h.dom.window.close();}
});

test('a zero-volume counted product can be received without inventing milliliters',async()=>{
  const h=await harness({products:[{id:'product',organization_id:'org',name:'Přepravka',volume_ml:null,unit_mode:'counted',archived_at:null,aliases:[]}]});
  try{await h.post();assert.equal(h.invoice.status,'posted');}finally{h.dom.window.close();}
});

test('repeated clicks and a stale already-posted invoice never learn prices or write a second audit',async()=>{
  const h=await harness();
  try{await Promise.all([h.post(),h.post()]);assert.equal(h.tables.purchase_price_history.length,1);assert.equal(h.tables.audit_events.length,1);}
  finally{h.dom.window.close();}
  const stale=await harness();
  try{stale.invoice.status='posted';await stale.post();assert.equal(stale.writes.length,0);}finally{stale.dom.window.close();}
});

test('a captured net/gross VAT conflict is blocked rather than silently rewriting printed line amounts',async()=>{
  const h=await harness({lines:[{line_total_net:90,line_total_gross:121}]});
  try{await h.post();assert.equal(h.writes.length,0);assert.match(h.w.PubGuruInvoiceReview.check().issues.join(' '),/Základ a DPH nesedí/);}
  finally{h.dom.window.close();}
});

test('a lost audit response reconciles posted status without another audit, price history or stock attempt',async()=>{
  const h=await harness({writeHook:async({table,payload,invoice})=>{
    if(table==='audit_events'&&payload.event_type==='invoice.posted'){invoice.status='posted';throw new Error('Lost response');}
  }});
  try{await h.post();await h.post();assert.equal(h.tables.audit_events.length,1);assert.equal(h.tables.purchase_price_history.length,1);}
  finally{h.dom.window.close();}
});

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
