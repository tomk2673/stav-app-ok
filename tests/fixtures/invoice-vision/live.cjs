'use strict';
// Explicit, opt-in paid calls. Never runs as part of npm test or CI.
const fs=require('node:fs');
const path=require('node:path');
const assert=require('node:assert/strict');
const cases=require('./cases.cjs');
(async()=>{
 if(!process.argv.includes('--live'))throw new Error('Use --live to explicitly enable up to five paid reads.');
 if(!process.env.OPENAI_API_KEY){console.error('NOT_RUN: OPENAI_API_KEY is not available; no live provider call was made.');process.exitCode=2;return;}
 const {readInvoice}=require('../../../api/invoice-vision');
 const results=[];
 for(const c of cases){
  const input=fs.readFileSync(path.join(__dirname,c.id+'.png'));
  try{
   const r=await readInvoice({mime_type:'image/png',file_name:c.id+'.png',data_url:'data:image/png;base64,'+input.toString('base64')});
   const i=r.invoice,e=c.expected;
   for(const key of ['document_type','supplier_ico','supplier_dic','currency','invoice_number','issue_date','tax_date','due_date'])assert.equal(i[key],e[key],key);
   for(const key of ['total_net','total_vat','total_gross','amount_due','rounding_amount'])assert.ok(typeof i[key]==='number'&&Math.abs(i[key]-e[key])<=.01,key);
   assert.equal(i.lines.length,e.lines.length,'line count');
   i.lines.forEach((l,index)=>{const expected=e.lines[index];
    for(const key of ['quantity','unit','vat_rate','is_bonus'])assert.equal(l[key],expected[key],key+' row '+index);
    for(const key of ['unit_price_net','line_total_net','line_total_gross','discount_percent','discount_amount_net']){
     if(expected[key]==null)assert.equal(l[key],null,key+' row '+index);
     else assert.ok(typeof l[key]==='number'&&Math.abs(l[key]-expected[key])<=.01,key+' row '+index);
    }
    if(expected.source_code)assert.equal(l.source_code,expected.source_code);
   });
   if(c.warningPattern)assert.match(i.warnings.join(' '),new RegExp(c.warningPattern,'i'));
   else assert.deepEqual(i.warnings,[]);
   results.push({case:c.id,status:'PASS',model:r.model});
  }catch(error){
   // Do not serialize SDK errors, request bodies, headers, or document content.
   results.push({case:c.id,status:'FAIL',reason:error instanceof assert.AssertionError?'expected_fields_mismatch':'provider_read_failed'});
  }
 }
 const report={mode:'LIVE_OPENAI',when:new Date().toISOString(),cases:results};
 fs.writeFileSync(path.join(__dirname,'live-results.json'),JSON.stringify(report,null,2));
 console.log(JSON.stringify(report));if(results.some(r=>r.status!=='PASS'))process.exitCode=1;
})().catch(()=>{console.error('NOT_RUN: live evaluation setup failed; no success is asserted.');process.exitCode=2;});
