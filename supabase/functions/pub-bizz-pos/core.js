/* PUB-BIZZ POS — money is stored in integer haléře; state changes commit atomically. */
(function (root) {
  'use strict';
  const catalog = typeof module !== 'undefined' ? require('./catalog.js') : root.POSCatalog;
  const uid = () => globalThis.crypto.randomUUID();
  const check = (ok, message) => { if (!ok) throw new Error(message); };
  const integer = (x, max = 100000000) => Number.isSafeInteger(x) && x >= 0 && x <= max;
  const clean = (s, max = 120) => String(s || '').trim().slice(0, max);
  function money(value) {
    const s = String(value).trim().replace(/\s/g, '').replace(',', '.');
    check(/^\d{1,7}(\.\d{1,2})?$/.test(s), 'Zadej platnou částku, nejvýš dvě desetinná místa.');
    return Math.round(Number(s) * 100);
  }
  const sum = (lines) => lines.reduce((n, l) => n + l.price * l.quantity, 0);
  function initial() {
    return { schema: 1, deviceId: uid(), venueId: uid(), revision: 0, sequence: 0, catalogVersion: catalog.version,
      settings: { venue: 'ZTRACENÝ BAR', company: '', address: '', ico: '', dic: '', vat: 'unknown', operator: 'Obsluha' },
      products: structuredClone(catalog.products),
      orders: [{ id: 'bar', name: 'Rychlý prodej', lines: [], revision: 0 }], shifts: [], receipts: [], audit: [], lastBackup: null };
  }
  const activeShift = s => s.shifts.find(x => !x.closedAt);
  function totals(s, shiftId) {
    const sh = s.shifts.find(x => x.id === shiftId);
    const receipts = s.receipts.filter(x => x.shiftId === shiftId);
    const cash = receipts.reduce((n, x) => n + x.cash, 0);
    const card = receipts.reduce((n, x) => n + x.card, 0);
    const movements = (sh?.movements || []).reduce((n, x) => n + x.amount, 0);
    return { cash, card, total: cash + card, count: receipts.filter(x => x.kind === 'sale').length,
      refunds: receipts.filter(x => x.kind === 'refund').length, movements, opening: sh?.opening || 0, expected: (sh?.opening || 0) + cash + movements };
  }
  function selectedLines(order, selected) {
    check(Array.isArray(selected) && selected.length > 0, 'Vyber položky k zaplacení.');
    check(new Set(selected.map(x => x.id)).size === selected.length, 'Položka je ve výběru dvakrát.');
    return selected.map(x => {
      const l = order.lines.find(l => l.id === x.id);
      check(l && integer(x.quantity, 999) && x.quantity > 0 && x.quantity <= l.quantity, 'Účet se změnil. Znovu otevři platbu.');
      return { ...l, quantity: x.quantity };
    });
  }
  function payment(raw, mode, received, splitCash) {
    check(integer(raw) && raw > 0, 'Účet musí mít kladnou hodnotu.');
    check(['cash', 'card', 'split'].includes(mode), 'Vyber způsob platby.');
    const total = mode === 'cash' ? Math.round(raw / 100) * 100 : raw;
    check(total > 0, 'Částka po zaokrouhlení musí být kladná.');
    const cash = mode === 'cash' ? total : mode === 'card' ? 0 : splitCash;
    check(integer(cash) && cash <= total && (mode !== 'split' || cash % 100 === 0), 'Hotovost zadej v celých Kč, nejvýš do výše účtu.');
    const card = total - cash;
    check(integer(received) && received >= cash, 'Přijatá hotovost je nižší než částka k úhradě.');
    return { total, cash, card, received, change: received - cash, rounding: total - raw, mode };
  }
  function execute(s, type, p = {}, now = new Date().toISOString()) {
    let result = null;
    const sh = activeShift(s);
    const needShift = () => { check(sh, 'Nejdřív otevři směnu.'); return sh; };
    const order = () => { const o = s.orders.find(x => x.id === p.orderId); check(o, 'Účet už neexistuje.'); return o; };
    if (type === 'openShift') {
      check(!sh, 'Směna už je otevřená.'); check(integer(p.opening), 'Neplatný počáteční vklad.');
      const next = { id: uid(), openedAt: now, closedAt: null, opening: p.opening, operator: clean(p.operator) || s.settings.operator, movements: [] };
      s.shifts.push(next); result = next;
    } else if (type === 'newOrder') {
      check(clean(p.name), 'Zadej název účtu.');
      check(!s.orders.some(x => x.name.toLocaleLowerCase('cs') === clean(p.name).toLocaleLowerCase('cs')), 'Tento účet už existuje.');
      result = { id: uid(), name: clean(p.name), lines: [], revision: 0 }; s.orders.push(result);
    } else if (type === 'deleteOrder') {
      const o = order(); check(o.id !== 'bar' && !o.lines.length, 'Smazat lze pouze prázdný pojmenovaný účet.'); s.orders = s.orders.filter(x => x.id !== o.id);
    } else if (type === 'loadCatalog') {
      if (s.catalogVersion === catalog.version) return null;
      for (const item of catalog.products) {
        const old = s.products.find(x => x.id === item.id);
        if (!old) s.products.push(structuredClone(item));
        else if (item.sourceCode === '4328' && old.price === 12000) old.price = 13000;
      }
      for (const old of s.products) if (old.price === null) old.active = false;
      s.catalogVersion = catalog.version;
    } else if (type === 'importProducts') {
      check(Array.isArray(p.items) && p.items.length > 0 && p.items.length <= 300, 'Vlož 1 až 300 položek.');
      for (const item of p.items) {
        const matches = s.products.filter(x => x.name.toLocaleLowerCase('cs') === clean(item.name).toLocaleLowerCase('cs') && x.serving === clean(item.serving));
        check(matches.length <= 1, `Položka ${clean(item.name)} má více kódů. Uprav ji jednotlivě v ceníku.`);
        const old = matches[0];
        execute(s, 'product', { ...item, id: old?.id, stockProductId: old?.stockProductId || '' }, now);
      }
    } else if (type === 'product') {
      check(clean(p.name), 'Zadej název položky.');
      check(integer(p.price) && p.price > 0, 'Cena musí být vyšší než nula.');
      check(p.vatRate === null || (Number.isFinite(p.vatRate) && p.vatRate >= 0 && p.vatRate <= 100), 'Neplatná sazba DPH.');
      const old = s.products.find(x => x.id === p.id);
      result = { id: old?.id || uid(), sourceCode: old?.sourceCode || '', priceNote: '', name: clean(p.name), category: clean(p.category, 40) || 'Ostatní', serving: clean(p.serving, 40), price: p.price, vatRate: p.vatRate, active: p.active !== false, stockProductId: clean(p.stockProductId) };
      if (old) Object.assign(old, result); else s.products.push(result);
    } else if (type === 'archiveProduct') {
      const product = s.products.find(x => x.id === p.id); check(product, 'Položka neexistuje.'); product.active = false;
    } else if (type === 'addLine') {
      needShift(); const o = order(); const pr = s.products.find(x => x.id === p.productId && x.active);
      check(pr && integer(pr.price) && pr.price > 0, 'Nejdřív nastav cenu položky.');
      check(s.settings.vat !== 'payer' || pr.vatRate !== null, 'U této položky nejdřív nastav sazbu DPH v ceníku.');
      const line = o.lines.find(x => x.productId === pr.id && x.price === pr.price && x.vatRate === pr.vatRate && x.name === pr.name && x.serving === pr.serving);
      if (line) { check(line.quantity < 999, 'Limit množství je 999.'); line.quantity++; }
      else o.lines.push({ id: uid(), productId: pr.id, sourceCode: pr.sourceCode || '', stockProductId: pr.stockProductId, name: pr.name, serving: pr.serving, price: pr.price, vatRate: pr.vatRate, quantity: 1 });
      check(sum(o.lines) <= 100000000, 'Překročen limit účtu.'); o.revision++;
    } else if (type === 'removeLine') {
      needShift(); const o = order(); const l = o.lines.find(x => x.id === p.lineId); check(l, 'Položka neexistuje.'); check(clean(p.reason), 'Doplň důvod opravy.');
      l.quantity--; o.lines = o.lines.filter(x => x.quantity > 0); o.revision++;
    } else if (type === 'checkout') {
      check(typeof p.operationId === 'string' && p.operationId.length > 10, 'Chybí identifikátor platby.');
      const duplicate = s.receipts.find(x => x.operationId === p.operationId); if (duplicate) return duplicate;
      needShift(); const o = order(); check(o.revision === p.revision, 'Účet se změnil v jiném okně. Znovu otevři platbu.');
      const lines = selectedLines(o, p.selected); const pay = payment(sum(lines), p.mode, p.received, p.splitCash);
      check(!pay.card || p.cardConfirmed === true, 'Nejdřív potvrď úspěšnou platbu na terminálu.');
      if (s.settings.vat === 'payer') check(lines.every(x => x.vatRate !== null), 'Na účtu chybí sazba DPH. Oprav položky před zaplacením.');
      s.sequence++;
      result = { id: uid(), operationId: p.operationId, number: `${s.deviceId.slice(0, 4).toUpperCase()}-${String(s.sequence).padStart(6, '0')}`, kind: 'sale', at: now, shiftId: sh.id, orderId: o.id, orderName: o.name, deviceId: s.deviceId, venueId: s.venueId, operator: sh.operator, settings: { ...s.settings }, lines, ...pay };
      s.receipts.push(result);
      for (const line of lines) o.lines.find(x => x.id === line.id).quantity -= line.quantity;
      o.lines = o.lines.filter(x => x.quantity > 0); o.revision++;
    } else if (type === 'refund') {
      needShift(); const sale = s.receipts.find(x => x.id === p.receiptId && x.kind === 'sale');
      check(sale && sale.shiftId === sh.id, 'Vratku lze provést pouze k prodeji v právě otevřené směně.');
      check(!s.receipts.some(x => x.refundOf === sale.id), 'Tento doklad už má vratku.'); check(clean(p.reason), 'Doplň důvod vratky.');
      check(!sale.card || p.cardConfirmed, 'Potvrď vrácení karetní platby na terminálu.');
      s.sequence++; result = { ...sale, id: uid(), operationId: uid(), number: `${s.deviceId.slice(0, 4).toUpperCase()}-${String(s.sequence).padStart(6, '0')}`, at: now, kind: 'refund', refundOf: sale.id, reason: clean(p.reason), total: -sale.total, cash: -sale.cash, card: -sale.card, rounding: -sale.rounding, received: 0, change: 0 };
      s.receipts.push(result);
    } else if (type === 'cashMovement') {
      needShift(); check(Number.isSafeInteger(p.amount) && Math.abs(p.amount) <= 100000000 && p.amount !== 0, 'Neplatná částka.'); check(clean(p.reason), 'Doplň důvod pohybu hotovosti.');
      sh.movements.push({ id: uid(), at: now, amount: p.amount, reason: clean(p.reason) });
    } else if (type === 'closeShift') {
      needShift(); check(!s.orders.some(x => x.lines.length), 'Zůstaly nezaplacené účty. Nejdřív je vyrovnej.'); check(integer(p.counted), 'Zadej spočítanou hotovost.');
      sh.summary = totals(s, sh.id); sh.counted = p.counted; sh.difference = p.counted - sh.summary.expected; sh.closedAt = now; result = sh;
    } else if (type === 'settings') {
      check(['unknown', 'payer', 'nonpayer'].includes(p.vat), 'Neplatné nastavení DPH.');
      check(clean(p.venue), 'Zadej název podniku.');
      s.settings = { venue: clean(p.venue), company: clean(p.company), address: clean(p.address, 240), ico: clean(p.ico, 30), dic: clean(p.dic, 30), vat: p.vat, operator: clean(p.operator) || 'Obsluha' };
    } else if (type === 'backup') s.lastBackup = now;
    else throw new Error('Neznámá operace.');
    s.revision++;
    s.audit.push({ id: uid(), at: now, type, operator: sh?.operator || s.settings.operator, orderId: p.orderId || null, receiptId: result?.kind ? result.id : null, detail: structuredClone(p) });
    return result;
  }
  function validate(s) {
    check(s && s.schema === 1 && typeof s.deviceId === 'string' && typeof s.venueId === 'string', 'Soubor není záloha PUB-BIZZ.');
    for (const k of ['products', 'orders', 'shifts', 'receipts', 'audit']) check(Array.isArray(s[k]) && s[k].length < 100000, 'Poškozená nebo příliš velká záloha.');
    check(s.settings && typeof s.settings.venue === 'string' && ['unknown', 'payer', 'nonpayer'].includes(s.settings.vat) && integer(s.sequence) && integer(s.revision, 1000000000), 'Poškozená záloha.');
    for (const collection of [s.products, s.orders, s.shifts, s.receipts]) check(collection.every(x => x && typeof x.id === 'string') && new Set(collection.map(x => x.id)).size === collection.length, 'Neplatné identifikátory v záloze.');
    check(s.orders.some(o => o.id === 'bar'), 'Chybí účet rychlého prodeje.');
    for (const p of s.products) check(typeof p.name === 'string' && typeof p.category === 'string' && (p.price === null || integer(p.price)), 'Poškozený ceník.');
    for (const o of s.orders) {
      check(typeof o.name === 'string' && integer(o.revision, 1000000000) && Array.isArray(o.lines), 'Poškozený účet.');
      for (const l of o.lines) check(typeof l.id === 'string' && typeof l.name === 'string' && integer(l.price) && l.price > 0 && integer(l.quantity, 999) && l.quantity > 0, 'Neplatná položka v záloze.');
    }
    check(s.shifts.filter(x => !x.closedAt).length <= 1, 'Záloha obsahuje více otevřených směn.');
    for (const sh of s.shifts) {
      check(integer(sh.opening) && typeof sh.openedAt === 'string' && Array.isArray(sh.movements) && sh.movements.every(x => Number.isSafeInteger(x.amount)), 'Poškozená směna.');
      if (sh.closedAt) check(sh.summary && Number.isSafeInteger(sh.summary.total) && integer(sh.counted) && Number.isSafeInteger(sh.difference), 'Poškozená uzávěrka.');
    }
    for (const r of s.receipts) {
      check(['sale','refund'].includes(r.kind) && Array.isArray(r.lines) && r.lines.length && r.settings && typeof r.settings.venue === 'string' && s.shifts.some(x => x.id === r.shiftId), 'Poškozený doklad.');
      check([r.total,r.cash,r.card,r.rounding].every(Number.isSafeInteger) && r.total === r.cash + r.card, 'Nesedí součet dokladu.');
      for (const l of r.lines) check(integer(l.price) && integer(l.quantity, 999) && l.quantity > 0 && typeof l.name === 'string', 'Poškozená položka dokladu.');
      const sign = r.kind === 'sale' ? 1 : -1;
      check(sign * sum(r.lines) + r.rounding === r.total && sign * r.cash >= 0 && sign * r.card >= 0, 'Nesedí položky dokladu.');
    }
    return s;
  }
  const api = { initial, execute, money, sum, payment, activeShift, totals, validate, selectedLines };
  if (typeof module !== 'undefined') module.exports = api; else root.POSCore = api;
})(globalThis);
