'use strict';

(function (root) {
  function parse(value, monetary) {
    if (typeof value === 'number') return Number.isFinite(value) ? value : NaN;
    let s = String(value ?? '').trim().replace(/\s/g, '').replace(/\u2212/g, '-');
    if (monetary) s = s.replace(/(?:Kč|CZK)$/i, '');
    const wholeMoney = monetary && /[.,]-$/.test(s);
    if (wholeMoney) s = s.slice(0, -2);
    if (!/^-?\d+(?:[.,]\d+)*$/.test(s)) return NaN;
    if (wholeMoney) {
      // In Czech whole-crown notation the dots group thousands, never quantities.
      if (/^-?\d{1,3}(?:\.\d{3})+$/.test(s)) s = s.replace(/\./g, '');
      else if (/[.,]/.test(s)) return NaN;
    } else {
      const comma = s.lastIndexOf(','), dot = s.lastIndexOf('.');
      if (comma >= 0 && dot >= 0) {
        const decimal = comma > dot ? ',' : '.', grouping = decimal === ',' ? '.' : ',';
        const parts = s.split(decimal);
        const grouped = grouping === '.' ? /^-?\d{1,3}(?:\.\d{3})+$/ : /^-?\d{1,3}(?:,\d{3})+$/;
        if (parts.length !== 2 || !grouped.test(parts[0])) return NaN;
        s = parts[0].split(grouping).join('') + '.' + parts[1];
      } else if (/^-?\d{1,3}(?:\.\d{3}){2,}$/.test(s)) {
        s = s.replace(/\./g, '');
      } else if (comma >= 0) {
        s = s.replace(',', '.');
      }
      // Single separators are decimals (1,000 / 1.000 = 1), including unit prices.
    }
    const number = Number(s);
    return Number.isFinite(number) ? number : NaN;
  }

  const api = Object.freeze({parseQuantity: value => parse(value, false), parseMoney: value => parse(value, true)});
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.PubGuruInvoiceNumbers = api;
})(typeof window !== 'undefined' ? window : globalThis);
