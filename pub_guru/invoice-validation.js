'use strict';
// Pure, dependency-free invoice gate. Monetary values are decimal CZK amounts.
// This module does not approve invoices or write stock movements.
const VAT_RATES = new Set([0, 12, 21]);
function cents(value) {
  if (typeof value !== 'string' && typeof value !== 'number') return null;
  const raw = String(value).trim().replace(/\s|\u00a0/g, '').replace(',', '.');
  if (!/^-?\d+(?:\.\d{1,2})?$/.test(raw)) return null;
  const negative = raw.startsWith('-');
  const [whole, fraction = ''] = raw.replace('-', '').split('.');
  const amount = Number(whole) * 100 + Number(fraction.padEnd(2, '0'));
  return Number.isSafeInteger(amount) ? (negative ? -amount : amount) : null;
}
function validateInvoice(input) {
  const errors = [];
  if (!input || typeof input !== 'object') return { ok: false, errors: ['invalid_invoice'] };
  if (!String(input.supplier || '').trim()) errors.push('missing_supplier');
  if (!String(input.invoiceNumber || '').trim()) errors.push('missing_invoice_number');
  const expected = cents(input.total);
  if (expected === null || expected < 0) errors.push('invalid_invoice_total');
  if (!Array.isArray(input.lines) || input.lines.length === 0) errors.push('missing_lines');
  let sum = 0;
  for (const [index, line] of (Array.isArray(input.lines) ? input.lines : []).entries()) {
    if (!line || typeof line !== 'object') { errors.push('invalid_line_' + index); continue; }
    const qty = Number(line.quantity);
    const unit = cents(line.unitPrice);
    const total = cents(line.lineTotal);
    const vat = line.vatRate;
    if (!Number.isFinite(qty) || qty <= 0 || !Number.isInteger(qty * 1000)) errors.push('invalid_quantity_' + index);
    if (unit === null || unit < 0 || total === null || total < 0) errors.push('invalid_money_' + index);
    if (vat === '' || vat === null || vat === undefined || !VAT_RATES.has(Number(vat))) errors.push('unknown_vat_' + index);
    if (Number.isFinite(qty) && qty > 0 && unit !== null && total !== null && VAT_RATES.has(Number(vat)) && vat !== '' && vat != null) {
      const base = Math.round(unit * qty);
      const calculated = Math.round(base * (100 + Number(vat)) / 100);
      if (Math.abs(calculated - total) > 1) errors.push('line_total_mismatch_' + index);
    }
    if (total !== null) sum += total;
  }
  if (expected !== null && Math.abs(sum - expected) > 1) errors.push('invoice_total_mismatch');
  return { ok: errors.length === 0, errors, computedTotalCents: sum, expectedTotalCents: expected };
}
function normalizeDocumentKey(orgId, supplierId, invoiceNumber) {
  const values = [orgId, supplierId, invoiceNumber].map(v => String(v || '').normalize('NFKC').trim().toLocaleLowerCase('cs'));
  if (values.some(v => !v)) return null;
  return JSON.stringify(values);
}
module.exports = { cents, validateInvoice, normalizeDocumentKey };
