/* Authoritative command validation. Executed by the Edge Function, never trusted from the browser. */
(function (root) {
  'use strict';
  const C = typeof module !== 'undefined' ? require('./core.js') : root.POSCore;
  const manager = new Set(['owner', 'manager']);
  const staffCommands = new Set(['openShift', 'newOrder', 'deleteOrder', 'addLine', 'removeLine', 'beginPayment', 'cancelPayment', 'checkout', 'backup']);
  const managerCommands = new Set(['product', 'archiveProduct', 'importProducts', 'refund', 'cashMovement', 'closeShift', 'settings', 'recipe', 'resolveStock']);
  const check = (ok, message) => { if (!ok) throw new Error(message); };
  function run(state, type, payload, actor, stock, now = new Date().toISOString()) {
    check(actor && ['owner', 'manager', 'staff'].includes(actor.role), 'Nemáš oprávnění měnit pokladnu.');
    check(staffCommands.has(type) || (manager.has(actor.role) && managerCommands.has(type)), 'Tuto operaci může provést vedoucí nebo majitel.');
    const p = structuredClone(payload || {}), s = structuredClone(state);
    s.recipes ||= {};
    let result;
    const order = s.orders.find(o=>o.id===p.orderId);
    if (['addLine','removeLine','deleteOrder'].includes(type)) check(!order?.paymentLock, 'Na tomto účtu právě probíhá platba. Nejdřív ji dokonči nebo zkontroluj rezervaci.');
    if (type === 'checkout') {
      check(order?.paymentLock && order.paymentLock.token===p.paymentToken, 'Účet není rezervovaný pro tuto platbu. Otevři platbu znovu.');
      check(order.paymentLock.actorId===actor.id || manager.has(actor.role), 'Platbu dokončuje jiná obsluha.');
    }
    if (type === 'beginPayment') {
      check(C.activeShift(s) && order?.lines.length, 'Účet nemá položky nebo není otevřená směna.');
      check(order.revision===p.revision, 'Účet se změnil. Otevři platbu znovu.');
      check(!order.paymentLock, 'Účet už je rezervovaný pro platbu. Nejdřív zkontroluj rozpracovanou platbu.');
      result={token:crypto.randomUUID(),actorId:actor.id,at:now};order.paymentLock=result;
    } else if (type === 'cancelPayment') {
      check(order?.paymentLock?.token===p.paymentToken, 'Rezervace už není platná. Obnov účet.');
      check(order.paymentLock.actorId===actor.id || manager.has(actor.role), 'Rezervaci může uvolnit původní obsluha nebo vedoucí.');
      check(p.terminalChecked===true && String(p.reason||'').trim(), 'Nejdřív zkontroluj, že nedošlo k nepotvrzené platbě.');
      delete order.paymentLock;
    } else if (type === 'recipe') {
      check(s.products.some(x => x.id === p.productId && x.active), 'Položka ceníku neexistuje.');
      const old = s.recipes[p.productId];
      check((old?.version || 0) === p.version, 'Recepturu už změnil někdo jiný. Otevři ji znovu.');
      check(['recipe', 'no_stock'].includes(p.mode), 'Vyber způsob odpisu.');
      const reason = String(p.reason || '').trim().slice(0, 240);
      const components = p.mode === 'no_stock' ? [] : p.components;
      check(Array.isArray(components) && components.length <= 30, 'Receptura může mít nejvýš 30 surovin.');
      check(p.mode === 'no_stock' ? reason.length > 0 : components.length > 0, 'Vyplň suroviny nebo důvod bez odpisu.');
      check(new Set(components.map(x => x.productId)).size === components.length, 'Surovina je v receptuře dvakrát.');
      for (const c of components) {
        const product = stock.find(x => x.id === c.productId && !x.archived_at);
        check(product, 'Skladová položka není dostupná.');
        check(c.unit === (product.unit_mode === 'counted' ? 'ks' : 'ml'), 'Jednotka nesouhlasí se skladem.');
        check(Number.isFinite(c.quantity) && c.quantity > 0 && c.quantity <= 1000000 && Math.abs(c.quantity * 1000 - Math.round(c.quantity * 1000)) < 0.000001, 'Zadej kladné množství na jednu porci, nejvýš tři desetinná místa.');
      }
      result = { version: (old?.version || 0) + 1, mode: p.mode, reason, components: components.map(c => ({productId:c.productId, quantity:c.quantity, unit:c.unit})), updatedAt:now, updatedBy:actor.id };
      s.recipes[p.productId] = result;
    } else if (type === 'resolveStock') {
      const receipt = s.receipts.find(r => r.id === p.receiptId && r.kind === 'sale');
      const line = receipt?.lines.find(l => l.id === p.lineId);
      check(line && s.recipes[line.productId], 'Nejdřív nastav recepturu prodané položky.');
      check(!s.receipts.some(r => r.refundOf === receipt.id && r.restock), 'Zboží už bylo vrácené. Případnou opravu proveď v PUB GURU.');
      result = { receiptId: receipt.id, lineId: line.id, recipe: structuredClone(s.recipes[line.productId]) };
    } else {
      result = C.execute(s, type, p, now);
      if (type === 'checkout' && result) {
        delete order.paymentLock;
        result.actorId = actor.id;
        result.lines = result.lines.map(l => ({ ...l, stockRecipe: structuredClone(s.recipes[l.productId] || null) }));
      }
      if (type === 'refund' && result) {
        result.actorId = actor.id;
        result.restock = p.restock === true;
      }
    }
    if (['recipe','resolveStock','beginPayment','cancelPayment'].includes(type)) {
      s.revision++;
      s.audit.push({id:crypto.randomUUID(), at:now, type, actorId:actor.id, detail:p});
    } else if (s.audit.length) s.audit[s.audit.length - 1].actorId = actor.id;
    check(s.revision > state.revision, 'Operace už byla zapsaná. Obnov účet.');
    C.validate(s);
    return {state:s, result};
  }
  const api = {run};
  if (typeof module !== 'undefined') module.exports = api; else root.POSServerDomain = api;
})(globalThis);
