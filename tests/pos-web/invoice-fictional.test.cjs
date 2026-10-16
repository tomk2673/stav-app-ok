'use strict';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const {validate}=require('../../pub_guru/invoice-accounting');
const cases=require('../fixtures/invoice-vision/cases.cjs');
for(const c of cases)test('SIMULATED structured read: '+c.id,()=>{
 const source=structuredClone(c.expected),result=validate(source);
 assert.deepEqual(source,c.expected,'printed values must not be changed');
 for(const key of ['invoice_number','supplier_ico','total_net','total_vat','total_gross','amount_due'])assert.equal(result[key],source[key]);
 if(c.warningPattern)assert.match(result.warnings.join(' '),new RegExp(c.warningPattern,'i'));else assert.deepEqual(result.warnings,[]);
});
test('discount mismatch cannot be hidden by guessing a discount or overwriting the printed unit price',()=>{
 const c=structuredClone(cases[1].expected);c.lines[0].discount_percent=null;c.lines[0].discount_amount_net=null;
 const r=validate(c);assert.match(r.warnings.join(' '),/Množství ×/);assert.equal(r.lines[0].unit_price_net,100);assert.equal(r.lines[0].line_total_net,900);
 c.lines[0].discount_percent=20;c.lines[0].discount_amount_net=100;assert.match(validate(c).warnings.join(' '),/si odporují/);
});
