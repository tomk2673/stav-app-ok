/* Authoritative command validation. Executed by the Edge Function, never trusted from the browser. */
(function (root) {
  'use strict';
  const C = typeof module !== 'undefined' ? require('./core.js') : root.POSCore;
  const L = typeof module !== 'undefined' ? require('./loyalty.js') : root.POSLoyalty;
  const manager = new Set(['owner', 'manager']);
  const staffCommands = new Set(['openShift', 'newOrder', 'renameOrder', 'deleteOrder', 'mergeOrders', 'addLine', 'removeLine', 'setLineQuantity', 'beginPayment', 'cancelPayment', 'checkout', 'reassignReceipt', 'creditTopup', 'backup', 'redeemReward']);
  const managerCommands = new Set(['product', 'archiveProduct', 'importProducts', 'refund', 'restoreReceipt', 'cashMovement', 'closeShift', 'settings', 'recipe', 'resolveStock', 'loyaltyConfig']);
  const check = (ok, message) => { if (!ok) throw new Error(message); };
  function restoredStockLines(sale, records) {
    const result = {};
    for (const line of sale?.lines || []) {
      const record = records.find(x=>x.line_id===line.id);
      const resolved = record?.recipe?.resolvedComponents;
      if (!record?.recipe || !['posted','shortage','no_stock','awaiting_stock'].includes(record.status)) continue;
      // Late resolveStock may have supplied the first real recipe after the sale.
      if (!resolved?.length) {
        result[line.id]=[{quantity:line.quantity,stockRecipe:structuredClone(record.recipe)}];
        continue;
      }
      check(Array.isArray(resolved) && record.recipe.components?.length, 'Poškozená původní skladová receptura.');
      const boundaries = new Set([0,line.quantity]), components=[];
      for (const requested of record.recipe.components) {
        let end=0;
        const ranges=resolved.filter(x=>x.requestedProductId===requested.productId).map(x=>{
          check(Number.isSafeInteger(x.portions) && x.portions>0 && x.unit===requested.unit && Number.isFinite(Number(x.quantity)) && Number(x.quantity)>0, 'Poškozený původní skladový odpis.');
          const start=end;end+=x.portions;boundaries.add(end);
          return {start,end,productId:x.productId,unit:x.unit,quantity:Number(x.quantity)/x.portions};
        });
        check(end===line.quantity, 'Nesedí původní skladový odpis.');components.push(ranges);
      }
      const points=[...boundaries].sort((a,b)=>a-b);
      result[line.id]=points.slice(0,-1).map((start,i)=>({quantity:points[i+1]-start,stockRecipe:{
        version:record.recipe.version,mode:'recipe',components:components.map(ranges=>{
          const range=ranges.find(x=>x.start<=start&&x.end>start);
          return {productId:range.productId,unit:range.unit,quantity:range.quantity};
        })
      }}));
    }
    return result;
  }
  function run(state, type, payload, actor, stock, now = new Date().toISOString(), receiptStock = []) {
    check(actor && ['owner', 'manager', 'staff'].includes(actor.role), 'Nemáš oprávnění měnit pokladnu.');
    check(staffCommands.has(type) || (manager.has(actor.role) && managerCommands.has(type)), 'Tuto operaci může provést vedoucí nebo majitel.');
    const p = structuredClone(payload || {}), s = structuredClone(state);
    s.recipes ||= {};
    s.customers ||= [];
    s.creditLedger ||= [];
    let result = null;
    const order = s.orders.find(o=>o.id===p.orderId);
    if (['addLine','removeLine','setLineQuantity','deleteOrder'].includes(type)) check(!order?.paymentLock, 'Na tomto účtu právě probíhá platba. Nejdřív ji dokonči nebo zkontroluj rezervaci.');
    if (type === 'checkout') {
      check(order?.paymentLock && order.paymentLock.token===p.paymentToken, 'Účet není rezervovaný pro tuto platbu. Otevři platbu znovu.');
      check(order.paymentLock.actorId===actor.id || manager.has(actor.role), 'Platbu dokončuje jiná obsluha.');
    }
    if(type==='creditTopup'){
      check(C.activeShift(s),'Nejdřív otevři směnu.');
      check(order,'Zákaznický účet už neexistuje.');
      check(Number.isSafeInteger(p.amount)&&p.amount>=1000&&p.amount<=100000000,'Dobití musí být od 10 Kč do 1 000 000 Kč.');
      check(['cash','card'].includes(p.method),'Vyber hotovost nebo kartu.');
      if(p.method==='card')check(p.cardConfirmed===true,'Potvrď úspěšné dobití kartou na terminálu.');
      const customer=C.ensureCustomer(s,order,now);
      const entry={id:crypto.randomUUID(),type:'topup',customerId:customer.id,customerName:customer.name,orderId:order.id,shiftId:C.activeShift(s).id,amount:p.amount,method:p.method,at:now,actorId:actor.id};
      s.creditLedger.push(entry);
      result={...entry,balance:C.creditBalance(s,customer.id)};
    } else if(type==='loyaltyConfig'){
      check(typeof p.enabled==='boolean'&&Number.isSafeInteger(p.threshold)&&p.threshold>=10000&&p.threshold<=100000,'Zadej částku od 100 do 1 000 Kč.');
      s.loyalty||=L.initial();s.loyalty.enabled=p.enabled;s.loyalty.threshold=p.threshold;
      result={enabled:p.enabled,threshold:p.threshold};
    } else if(type==='redeemReward'){
      const reward=s.loyalty?.rewards.find(x=>x.id===p.rewardId);
      check(reward&&reward.status==='available'&&!reward.refunded,'Odměna není dostupná nebo už byla vydaná.');
      check(p.fulfilled===true&&String(p.note||'').trim(),'Nejdřív splň odměnu a napiš skladbu nebo poznámku.');
      reward.status='redeemed';reward.redeemedAt=now;reward.redeemedBy=actor.id;reward.note=String(p.note).trim().slice(0,160);result=structuredClone(reward);
    } else if (type === 'beginPayment') {
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
        const alternatives=c.alternatives||[];
        check(Array.isArray(alternatives)&&alternatives.length<=5, 'Lze nastavit nejvýš pět náhrad.');
        check(new Set([c.productId,...alternatives]).size===alternatives.length+1, 'Náhrada se opakuje nebo je shodná se základní surovinou.');
        for(const id of alternatives){const alt=stock.find(x=>x.id===id&&!x.archived_at);check(alt&&(alt.unit_mode==='counted'?'ks':'ml')===c.unit,'Náhrada musí být dostupná surovina se stejnou jednotkou.');}
      }
      result = { version: (old?.version || 0) + 1, mode: p.mode, reason, selection:'available', components: components.map(c => ({productId:c.productId, quantity:c.quantity, unit:c.unit, alternatives:c.alternatives||[]})), updatedAt:now, updatedBy:actor.id };
      s.recipes[p.productId] = result;
    } else if (type === 'resolveStock') {
      const receipt = s.receipts.find(r => r.id === p.receiptId && r.kind === 'sale');
      const line = receipt?.lines.find(l => l.id === p.lineId);
      check(line && s.recipes[line.productId], 'Nejdřív nastav recepturu prodané položky.');
      check(!s.receipts.some(r => r.refundOf === receipt.id && r.restock), 'Zboží už bylo vrácené. Případnou opravu proveď v PUB GURU.');
      result = { receiptId: receipt.id, lineId: line.id, recipe: structuredClone(s.recipes[line.productId]) };
    } else {
      // receiptStock is loaded by the authenticated Edge Function, never from command payload.
      const restored = type==='restoreReceipt' ? restoredStockLines(s.receipts.find(r=>r.id===p.receiptId&&r.kind==='sale'),receiptStock) : undefined;
      if(type==='checkout'&&p.mode==='credit'){
        const customer=C.ensureCustomer(s,order,now);
        const due=C.payment(C.sum(C.selectedLines(order,p.selected)),'credit',0,0).credit;
        check(C.creditBalance(s,customer.id)>=due,`Na kreditu chybí ${((due-C.creditBalance(s,customer.id))/100).toLocaleString('cs-CZ')} Kč.`);
      }
      result = C.execute(s, type, p, now, restored);
      if (type === 'checkout' && result) {
        delete order.paymentLock;
        result.actorId = actor.id;
        result.lines = result.lines.map(l => ({ ...l, stockRecipe: structuredClone(Object.prototype.hasOwnProperty.call(l, 'stockRecipe') ? l.stockRecipe : s.recipes[l.productId] || null) }));
        if(result.credit>0){
          const customerId=result.customerId||order.customerId;
          check(customerId&&C.creditBalance(s,customerId)>=result.credit,'Na kreditu není dostatek prostředků.');
          s.creditLedger.push({id:crypto.randomUUID(),type:'spend',customerId,customerName:result.orderName,orderId:result.orderId,shiftId:result.shiftId,amount:-result.credit,method:'credit',receiptId:result.id,at:now,actorId:actor.id});
        }
        L.award(s,result,now);
      }
      if (type === 'refund' && result) {
        result.actorId = actor.id;
        result.restock = p.restock === true;
        if(result.credit<0){
          const customerId=result.customerId||s.receipts.find(r=>r.id===result.refundOf)?.customerId;
          check(customerId,'K vratce kreditu chybí zákazník.');
          s.creditLedger.push({id:crypto.randomUUID(),type:'refund',customerId,customerName:result.orderName,orderId:result.orderId,shiftId:result.shiftId,amount:-result.credit,method:'credit',receiptId:result.id,refundOf:result.refundOf,at:now,actorId:actor.id});
        }
        L.refund(s,result);
      }
      if (type === 'restoreReceipt' && result) {
        result.actorId = actor.id;
        result.restock = true;
        if(result.credit<0){
          const customerId=result.customerId||s.receipts.find(r=>r.id===result.refundOf)?.customerId;
          check(customerId,'K vratce kreditu chybí zákazník.');
          s.creditLedger.push({id:crypto.randomUUID(),type:'refund',customerId,customerName:result.orderName,orderId:result.orderId,shiftId:result.shiftId,amount:-result.credit,method:'credit',receiptId:result.id,refundOf:result.refundOf,at:now,actorId:actor.id});
        }
        L.refund(s,result);
      }
      if (['refund', 'restoreReceipt'].includes(type) && result?.terminalConfirmation) result.terminalConfirmation.actorId = actor.id;
    }
    if (['recipe','resolveStock','beginPayment','cancelPayment','creditTopup','loyaltyConfig','redeemReward'].includes(type)) {
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
