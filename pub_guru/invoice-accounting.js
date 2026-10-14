'use strict';
(function(root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.PubGuruInvoiceAccounting = factory();
})(typeof globalThis !== 'undefined' ? globalThis : this, function() {
  const finite = value => typeof value === 'number' && Number.isFinite(value);
  const mismatch = (a, b) => Math.abs(a - b) > 0.05 + Number.EPSILON * Math.max(Math.abs(a), Math.abs(b));
  const validDate = value => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value) &&
    Number.isFinite(Date.parse(value)) && new Date(value).toISOString().slice(0, 10) === value;

  function validate(invoice) {
    if (!invoice || !Array.isArray(invoice.lines) || !invoice.lines.length) throw new Error('Doklad nemá žádné přečtené položky.');
    const result = JSON.parse(JSON.stringify(invoice));
    const warnings = Array.isArray(result.warnings) ? result.warnings.filter(x => typeof x === 'string') : [];
    if (!finite(result.total_gross)) warnings.push('Chybí přečtená celková částka s DPH.');
    if (Object.hasOwn(result,'currency') && !result.currency) warnings.push('Měna dokladu není bezpečně přečtená.');
    if (result.currency && result.currency !== 'CZK') warnings.push('Doklad je v jiné měně než CZK; nelze jej uložit jako koruny.');
    if (!validDate(result.issue_date)) { result.issue_date = null; warnings.push('Datum vystavení není bezpečně přečtené.'); }
    if (result.document_type === 'credit_note') warnings.push('Dobropis vyžaduje kontrolu vratky; nejde o běžný příjem zboží.');
    result.lines.forEach((line, index) => {
      if (!line || typeof line.raw_name !== 'string' || !line.raw_name.trim()) throw new Error('Položka '+(index+1)+' nemá čitelný název.');
      const issues = line.warning ? [String(line.warning)] : [];
      const numbers = ['quantity','unit_price_net','unit_price_gross','vat_rate','line_total_net','line_total_gross'];
      for (const field of numbers) if (!finite(line[field])) line[field] = null;
      line.computed_fields = Array.isArray(line.computed_fields) ? line.computed_fields.filter(x => x === 'unit_price_net') : [];
      // Gross-to-net conversion is deterministic from two READ values. It is
      // recorded as a calculation, never represented as a printed net price.
      if (line.unit_price_net === null && finite(line.unit_price_gross) && finite(line.vat_rate) && line.vat_rate >= 0 && line.vat_rate <= 100) {
        line.unit_price_net = line.unit_price_gross / (1 + line.vat_rate / 100);
        line.computed_fields.push('unit_price_net');
      }
      if (line.quantity === null || line.quantity === 0) issues.push('Nečitelné nebo nulové množství.');
      if (line.unit_price_net === null) issues.push('Nečitelná jednotková cena bez DPH.');
      if (line.vat_rate === null || line.vat_rate < 0 || line.vat_rate > 100) issues.push('Nečitelná nebo neplatná sazba DPH.');
      if (line.line_total_net === null || line.line_total_gross === null) issues.push('Chybí částka položky bez DPH nebo s DPH.');
      if (finite(line.quantity) && finite(line.unit_price_net) && finite(line.line_total_net) && mismatch(line.quantity * line.unit_price_net, line.line_total_net)) issues.push('Množství × jednotková cena nesedí na částku řádku bez DPH.');
      if (finite(line.line_total_net) && finite(line.vat_rate) && finite(line.line_total_gross) && mismatch(line.line_total_net * (1 + line.vat_rate / 100), line.line_total_gross)) issues.push('Částka řádku s DPH nesedí na základ a sazbu DPH.');
      line.warning = [...new Set(issues)].join(' · ') || null;
      if (line.warning) warnings.push('Položka '+(index+1)+': '+line.warning);
    });
    const total = key => result.lines.every(line => finite(line[key])) ? result.lines.reduce((sum,line) => sum + line[key], 0) : null;
    const net = total('line_total_net'), gross = total('line_total_gross');
    if (finite(net) && finite(result.total_net) && mismatch(net, result.total_net)) warnings.push('Součet položek bez DPH nesedí na vytištěný základ faktury.');
    const rounding = result.lines.some(line => line.line_type === 'rounding') ? 0 : (finite(result.rounding_amount) ? result.rounding_amount : 0);
    if (finite(gross) && finite(result.total_gross) && mismatch(gross + rounding, result.total_gross)) warnings.push('Součet položek s DPH a zaokrouhlení nesedí na celkovou částku faktury.');
    if (finite(result.total_net) && finite(result.total_vat) && finite(result.total_gross) && mismatch(result.total_net + result.total_vat + rounding, result.total_gross)) warnings.push('Základ + DPH + zaokrouhlení nesedí na celkovou částku.');
    result.warnings = [...new Set(warnings)];
    return result;
  }
  return {validate, validDate};
});
