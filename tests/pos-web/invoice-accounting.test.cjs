'use strict';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const {validate}=require('../../pub_guru/invoice-accounting');
const row=()=>({raw_name:'Vodka 0,7 l',quantity:2,unit:'ks',unit_price_net:100,unit_price_gross:121,
  vat_rate:21,line_total_net:200,line_total_gross:242,confidence:1,warning:null});
const invoice=()=>({supplier:'Dodavatel',invoice_number:'00042',issue_date:'2026-10-13',currency:'CZK',
  total_net:200,total_vat:42,total_gross:242,rounding_amount:0,warnings:[],lines:[row()]});

test('valid invoice keeps identifiers, order and repeated legitimate lines',()=>{
  const input=invoice();input.lines.push(row());input.total_net=400;input.total_vat=84;input.total_gross=484;
  const result=validate(input);
  assert.equal(result.invoice_number,'00042');assert.equal(result.lines.length,2);
  assert.deepEqual(result.warnings,[]);assert.deepEqual(input.lines[0],row(),'source is immutable');
});
test('arithmetic overrides a confident model, without changing observed amounts',()=>{
  const input=invoice();input.lines[0].quantity=3;
  const result=validate(input);assert.equal(result.lines[0].quantity,3);
  assert.match(result.warnings.join(' '),/Množství ×/);
});
test('missing and text-shaped numeric fields stay unknown rather than becoming zeros',()=>{
  const input=invoice();input.lines[0].quantity=null;input.lines[0].vat_rate='21';
  const result=validate(input);assert.equal(result.lines[0].quantity,null);assert.equal(result.lines[0].vat_rate,null);
  assert.match(result.warnings.join(' '),/množství/);assert.match(result.warnings.join(' '),/DPH/);
});
test('gross-to-net conversion is traceable across server and browser validation',()=>{
  const input=invoice();input.lines[0].unit_price_net=null;
  const result=validate(validate(input));assert.equal(result.lines[0].unit_price_net,100);
  assert.deepEqual(result.lines[0].computed_fields,['unit_price_net']);assert.deepEqual(result.warnings,[]);
});
test('rounding and signed returns reconcile without dropping zero-price bonuses',()=>{
  const input=invoice();input.lines.push({...row(),raw_name:'Vratný obal',quantity:-1,unit_price_net:10,unit_price_gross:10,vat_rate:0,line_total_net:-10,line_total_gross:-10});
  input.lines.push({...row(),raw_name:'Bonus',quantity:1,unit_price_net:0,unit_price_gross:0,vat_rate:0,line_total_net:0,line_total_gross:0,is_bonus:true});
  input.total_net=190;input.total_gross=232.2;input.rounding_amount=.2;
  const result=validate(input);assert.deepEqual(result.warnings,[]);assert.equal(result.lines.length,3);
});
test('missing item and wrong VAT or total are visible even at confidence 1',()=>{
  for(const mutate of [i=>i.total_gross=300,i=>i.lines[0].line_total_gross=250,i=>i.lines[0].line_total_net=150]){
    const input=invoice();mutate(input);assert.ok(validate(input).warnings.length);
  }
});
test('foreign currency, invalid dates and empty reads cannot look complete',()=>{
  const input=invoice();input.currency='EUR';input.issue_date='2026-02-30';
  const result=validate(input);assert.equal(result.issue_date,null);assert.match(result.warnings.join(' '),/měně/);
  assert.throws(()=>validate({...input,lines:[]}),/žádné/);
  assert.throws(()=>validate({...input,lines:[{...row(),raw_name:''}]}),/název/);
});
