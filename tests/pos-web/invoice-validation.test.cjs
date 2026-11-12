'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { cents, validateInvoice } = require('../../pub_guru/invoice-validation.js');
test('CZK decimal', () => assert.equal(cents('123,50'), 12350));
test('reject missing VAT', () => {
 const invoice = { supplier:'A', invoiceNumber:'1', total:'121', lines:[{quantity:1,unitPrice:'100',lineTotal:'121'}] };
 assert.equal(validateInvoice(invoice).ok, false);
});
