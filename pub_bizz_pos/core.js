/* PUB-BIZZ POS — money is stored in integer haléře; state changes commit atomically. */
(function (root) {
  'use strict';
  const catalog = typeof module !== 'undefined' ? require('./catalog.js') : root.POSCatalog;
  const uid = () => globalThis.crypto.randomUUID();
  const check = (ok, message) => { if (!ok) throw new Error(message); };
  const integer = (x, max = 100000000) => Number.isSafeInteger(x) && x >= 0 && x <= max;
  const clean = (s, max = 120) => String(s || '').trim().slice(0, max);
  const own = (o, key) => Object.prototype.hasOwnProperty.call(o, key);
  const normalizeCustomerName = value => String(value || '').toLocaleLowerCase('cs').normalize('NFD').replace(/[\u0300-\u036f]/g, '').trim();
  const accountNumber = name => String(name || '').match(/^(?:st[ůu]l\s*#?\s*)?(\d+)\b/i)?.[1] || '';
  const customerLike = name => { const key=normalizeCustomerName(name); return !!key && key!=='rychly prodej' && !accountNumber(name); };
  function findCustomer(s, name) {
    const key=normalizeCustomerName(name);
    return (s.customers||[]).find(x=>normalizeCustomerName(x.name)===key||(x.aliases||[]).some(a=>normalizeCustomerName(a)===key))||null;
  }
  function ensureCustomer(s, o, now = new Date().toISOString()) {
    check(o && o.id !== 'bar' && customerLike(o.name), 'Kredit lze použít jen u pojmenovaného zákazníka.');
    s.customers ||= [];
    let customer=o.customerId?s.customers.find(x=>x.id===o.customerId):null;
    if(!customer) customer=findCustomer(s,o.name);
    check(!customer || !s.orders.some(x=>x.id!==o.id&&x.customerId===customer.id), 'Tento zákazník už má otevřený účet pod jiným jménem.');
    if(!customer){customer={id:uid(),name:o.name,aliases:[o.name],createdAt:now};s.customers.push(customer);}
    customer.aliases ||= [];
    if(!customer.aliases.some(a=>normalizeCustomerName(a)===normalizeCustomerName(o.name)))customer.aliases.push(o.name);
    customer.name=o.name;o.customerId=customer.id;
    return customer;
  }
  const creditBalance = (s, customerId) => (s.creditLedger||[]).filter(x=>x.customerId===customerId).reduce((n,x)=>n+x.amount,0);
  const sameLine = (a, b) => ['productId', 'sourceCode', 'stockProductId', 'name', 'serving', 'price', 'vatRate', 'servingMl', 'baseServingMl'].every(k => a[k] === b[k])
    && own(a, 'stockRecipe') === own(b, 'stockRecipe') && JSON.stringify(a.stockRecipe) === JSON.stringify(b.stockRecipe)
    && !a.stockIssue && !b.stockIssue;
  const receiptAccount = (s, r) => own(s.receiptAssignments || {}, r.id) ? s.receiptAssignments[r.id] : { orderId: r.orderId, orderName: r.orderName };
  const shotCategories = new Set(['Destiláty','Likéry','Rumy','Whisky','Brandy']);
  function shotVolumeMl(product) {
    if (!product || (!shotCategories.has(product.category) && product.category !== 'Koktejly')) return null;
    if (/(?:lahev|láhev|bottle|s\s+(?:colou|kolou|džusem|dzusem|tonikem|tonicem|limonádou))/i.test(product.name)) return null;
    const serving = String(product.serving || '').trim();
    const parse = text => {
      const m = text.match(/^(?:0[.,]0([24])\s*l?|([24])\s*cl|([24])0\s*ml)$/i);
      return m ? Number(m[1] || m[2] || m[3]) * 10 : null;
    };
    if (serving) return parse(serving);
    const suffix = String(product.name).match(/(?:0[.,]0[24]\s*l?|\b[24]\s*cl|\b[24]0\s*ml)\s*$/i);
    if (suffix) return parse(suffix[0].trim());
    // The supplied Agnis spirits list uses a standard 4cl shot, including old
    // labels ending in OCR "0,041" and named promotions without a portion.
    // Never infer a portion for a custom item (e.g. a debt in this category).
    const imported = catalog.products.find(p => p.id === product.id);
    return imported && shotCategories.has(product.category) && imported.name === product.name && imported.category === product.category ? 40 : null;
  }
  function smallShot(product) {
    const baseServingMl = shotVolumeMl(product);
    if (!baseServingMl) return null;
    const baseName = product.name.replace(/(?:0\.)?0[.,]0[24](?:\s*l|1)?\s*$|\s*\b[24]\s*cl\s*$|\s*\b[24]0\s*ml\s*$/i, '').trim();
    return {name:baseName + ' · 2 cl', serving:'', servingMl:20, baseServingMl,
      price:baseServingMl === 20 ? product.price : product.smallShotPrice ?? (product.price === null ? null : Math.round(product.price / 2))};
  }
  function recipeForLine(line, recipe) {
    const result = structuredClone(recipe);
    if (line.servingMl !== 20 || !result || result.mode === 'no_stock') return result;
    check([20,40].includes(line.baseServingMl), 'Chybí původní velikost panáku.');
    check(result.mode === 'recipe' && Array.isArray(result.components) && result.components.length > 0
      && result.components.every(c => c.unit === 'ml' && Number.isFinite(c.quantity) && c.quantity > 0)
      && Math.abs(result.components.reduce((n,c) => n + c.quantity, 0) - line.baseServingMl) < 0.000001,
      `Pro 2cl panák nastav recepturu běžné ${line.baseServingMl / 10}cl porce v mililitrech.`);
    result.components = result.components.map(c => ({...c,quantity:Math.round(c.quantity * 20 / line.baseServingMl * 1000000) / 1000000}));
    return result;
  }
  function validatePortion(line) {
    if (line.servingMl !== undefined || line.baseServingMl !== undefined) check(line.servingMl === 20 && [20,40].includes(line.baseServingMl), 'Poškozená velikost porce.');
  }
  function refundVerification(sale, p, now) {
    check(clean(p.reason), 'Doplň důvod vratky.');
    if (!sale.card) return null;
    check(p.cardConfirmed === true, 'Potvrď vrácení karetní platby na terminálu.');
    check(typeof p.terminalReference === 'string' && p.terminalReference.trim().length > 0 && p.terminalReference.length <= 120, 'Doplň číslo storna nebo vratky z terminálu.');
    return { method: 'manual', confirmed: true, reference: p.terminalReference.trim(), at: now };
  }
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
      orders: [{ id: 'bar', name: 'Rychlý prodej', lines: [], revision: 0 }], shifts: [], receipts: [], receiptAssignments: {}, customers: [], creditLedger: [], stockIssues: [], audit: [], lastBackup: null };
  }
  const activeShift = s => s.shifts.find(x => !x.closedAt);
  function totals(s, shiftId) {
    const sh = s.shifts.find(x => x.id === shiftId);
    const receipts = s.receipts.filter(x => x.shiftId === shiftId);
    const cash = receipts.reduce((n, x) => n + x.cash, 0);
    const card = receipts.reduce((n, x) => n + x.card, 0);
    const credit = receipts.reduce((n, x) => n + (x.credit || 0), 0);
    const topups=(s.creditLedger||[]).filter(x=>x.shiftId===shiftId&&['topup','reversal'].includes(x.type));
    const creditTopupCash=topups.filter(x=>x.method==='cash').reduce((n,x)=>n+x.amount,0);
    const creditTopupCard=topups.filter(x=>x.method==='card').reduce((n,x)=>n+x.amount,0);
    const movements = (sh?.movements || []).reduce((n, x) => n + x.amount, 0);
    return { cash, card, credit, total: cash + card + credit, count: receipts.filter(x => x.kind === 'sale').length,
      refunds: receipts.filter(x => x.kind === 'refund').length, movements, opening: sh?.opening || 0,
      creditTopupCash, creditTopupCard, creditTopups:creditTopupCash+creditTopupCard,
      expected: (sh?.opening || 0) + cash + creditTopupCash + movements, terminal:card+creditTopupCard };
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
    check(['cash', 'card', 'split', 'credit'].includes(mode), 'Vyber způsob platby.');
    const total = mode === 'cash' ? Math.round(raw / 100) * 100 : raw;
    check(total > 0, 'Částka po zaokrouhlení musí být kladná.');
    const cash = mode === 'cash' ? total : mode === 'split' ? splitCash : 0;
    check(integer(cash) && cash <= total && (mode !== 'split' || cash % 100 === 0), 'Hotovost zadej v celých Kč, nejvýš do výše účtu.');
    const credit = mode === 'credit' ? total : 0;
    const card = mode === 'card' ? total : mode === 'split' ? total - cash : 0;
    check(integer(received) && received >= cash, 'Přijatá hotovost je nižší než částka k úhradě.');
    return { total, cash, card, credit, received, change: received - cash, rounding: total - raw, mode };
  }
  const VISIT_IDLE_MINUTES = 120;
  const visitFields = ['visitId','visitStartedAt','visitLastActivityAt','visitEndedAt','visitEndEstimated','visitHasCarriedBalance'];
  function clearVisit(order) { for (const field of visitFields) delete order[field]; }
  function visitSessions(state, order, now = new Date().toISOString()) {
    const start = Date.parse(order?.visitStartedAt), clock = Date.parse(now);
    if (!Number.isFinite(start) || !Number.isFinite(clock) || start > clock) return [];
    const manualEnd = Date.parse(order.visitEndedAt), limit = Number.isFinite(manualEnd) ? Math.min(clock,manualEnd) : clock;
    const times = new Set([start]);
    for (const event of state.audit || []) {
      if (own(event,'visitActivity')) {
        if (event.visitActivity?.orderId !== order.id) continue;
      } else {
        if (!['addLine','checkout'].includes(event.type) || (event.detail?.orderId || event.orderId) !== order.id) continue;
        // Paying an already ended visit is debt settlement, not evidence of presence.
        const receipt = event.type==='checkout' && (state.receipts || []).find(r=>r.id===event.receiptId);
        if (receipt?.visitEndedAt && Date.parse(receipt.visitEndedAt)<Date.parse(receipt.at)) continue;
      }
      const at = Date.parse(event.at); if (at >= start && at <= limit) times.add(at);
    }
    const last = Date.parse(order.visitLastActivityAt); if (last >= start && last <= limit) times.add(last);
    const idle = VISIT_IDLE_MINUTES * 60000, sessions = []; let began = start, activity = start;
    const row = (end, estimated, active = false) => ({id:began===start?(order.visitId || 'visit:'+order.id+':'+start):(order.visitId || 'visit:'+order.id)+'@'+began,
      orderId:order.id,orderName:order.name,customerId:order.customerId || null,startedAt:new Date(began).toISOString(),endedAt:end===null?null:new Date(end).toISOString(),
      durationMinutes:Math.max(0,Math.floor(((end===null?clock:end)-began)/60000)),lastActivityAt:new Date(activity).toISOString(),estimated,active,
      reason:active?'active':estimated?'idle':'manual'});
    for (const at of [...times].sort((a,b)=>a-b)) {
      if (at-activity >= idle) { sessions.push(row(activity+idle,true)); began=at; }
      activity=at;
    }
    if (Number.isFinite(manualEnd)) sessions.push(row(Math.max(began,limit),order.visitEndEstimated===true));
    else if (clock-activity >= idle) sessions.push(row(activity+idle,true));
    else sessions.push(row(null,false,true));
    return sessions;
  }
  function execute(s, type, p = {}, now = new Date().toISOString(), restoredLines, actorId = s.deviceId) {
    let result = null;
    const closedVisits = [];
    let visitActivity = null;
    const sh = activeShift(s);
    const needShift = () => { check(sh, 'Nejdřív otevři směnu.'); return sh; };
    const order = () => { const o = s.orders.find(x => x.id === p.orderId); check(o, 'Účet už neexistuje.'); return o; };
    const touchVisit = o => {
      if (o.id === 'bar') return;
      const sessions = visitSessions(s,o,now), active = sessions.find(v=>v.active);
      closedVisits.push(...sessions.filter(v=>!v.active));
      if (!o.visitId || !active) {
        const carried = o.lines.length > 0; clearVisit(o); o.visitId = uid(); o.visitStartedAt = now;
        if (carried) o.visitHasCarriedBalance = true;
      } else if (active.startedAt !== new Date(o.visitStartedAt).toISOString()) {
        o.visitId = active.id; o.visitStartedAt = active.startedAt; o.visitHasCarriedBalance = true;
      }
      o.visitLastActivityAt = now;
      visitActivity = {orderId:o.id,visitId:o.visitId,at:now};
    };
    if (type === 'openShift') {
      check(!sh, 'Směna už je otevřená.'); check(integer(p.opening), 'Neplatný počáteční vklad.');
      const next = { id: uid(), openedAt: now, closedAt: null, opening: p.opening, operator: clean(p.operator) || s.settings.operator, movements: [] };
      s.shifts.push(next); result = next;
    } else if (type === 'newOrder') {
      check(clean(p.name), 'Zadej název účtu.');
      check(!s.orders.some(x => x.name.toLocaleLowerCase('cs') === clean(p.name).toLocaleLowerCase('cs')), 'Tento účet už existuje.');
      result = { id: uid(), name: clean(p.name), lines: [], revision: 0 }; s.orders.push(result);
      if(customerLike(result.name))ensureCustomer(s,result,now);
    } else if (type === 'renameOrder') {
      const o = order();
      check(o.id !== 'bar', 'Rychlý prodej nelze přejmenovat.');
      check(!o.paymentLock, 'Nejdřív dokonči nebo uvolni rozpracovanou platbu.');
      check(o.revision === p.revision, 'Účet se změnil. Znovu otevři přejmenování.');
      check(typeof p.name === 'string' && p.name.trim().length > 0 && p.name.trim().length <= 120, 'Zadej název účtu do 120 znaků.');
      const name = p.name.trim();
      check(!s.orders.some(x => x.id !== o.id && x.name.toLocaleLowerCase('cs') === name.toLocaleLowerCase('cs')), 'Tento účet už existuje.');
      result = { type, orderId: o.id, previousName: o.name, name, at: now };
      if(o.customerId&&!customerLike(name))check(creditBalance(s,o.customerId)===0,'Zákazníka s kreditem nelze změnit na stůl. Nejdřív kredit vyčerpej nebo vrať.');
      const customer=(s.customers||[]).find(x=>x.id===o.customerId), collision=customerLike(name)?findCustomer(s,name):null;
      check(!collision || collision.id===o.customerId,'Toto jméno patří jinému zákazníkovi. Kredit nelze sloučit přejmenováním.');
      if(customer&&customerLike(name)){
        customer.aliases ||= [];
        for(const alias of [o.name,name])if(!customer.aliases.some(x=>normalizeCustomerName(x)===normalizeCustomerName(alias)))customer.aliases.push(alias);
        customer.name=name;
      } else if(!customerLike(name)) delete o.customerId;
      o.name = name; o.revision++;
    } else if (type === 'endVisit') {
      const o = order();
      check(o.id !== 'bar' && o.visitStartedAt, 'Na tomto účtu není návštěva k ukončení.');
      check(!o.paymentLock, 'Nejdřív dokonči nebo uvolni rozpracovanou platbu.');
      check(o.revision === p.revision, 'Účet se změnil. Znovu otevři profil.');
      const ended = Date.parse(p.endedAt || now), began = Date.parse(o.visitStartedAt);
      check(Number.isFinite(ended) && ended >= began && ended <= Date.parse(now), 'Odchod musí být mezi začátkem návštěvy a současností.');
      // Resolve the current session BEFORE applying the requested end; using that
      // end as a filter would hide the very orders/payments we must validate.
      const latest = visitSessions(s,o,now).slice(-1)[0];
      const lastActivity = Math.max(began,Date.parse(latest?.lastActivityAt) || began,Date.parse(o.visitLastActivityAt) || began);
      check(ended >= lastActivity, 'Odchod nesmí být před poslední evidovanou aktivitou návštěvy (objednávkou nebo průběžnou platbou).');
      o.visitEndedAt = new Date(ended).toISOString(); o.visitEndEstimated = false;
      const sessions = visitSessions(s,o,now); closedVisits.push(...sessions.filter(v=>!v.active));
      result = {...sessions[sessions.length-1],type,at:now}; o.revision++;
    } else if (type === 'deleteOrder') {
      const o = order(); check(o.id !== 'bar' && !o.lines.length, 'Smazat lze pouze prázdný pojmenovaný účet.');
      // Removing an empty account must not erase a visit retained after a merge.
      // Account removal is not a confirmed departure, so label that end as an estimate.
      closedVisits.push(...visitSessions(s,o,now).map(v=>v.active?{...v,active:false,endedAt:now,estimated:true,reason:'account_deleted'}:v));
      s.orders = s.orders.filter(x => x.id !== o.id);
    } else if (type === 'mergeOrders') {
      needShift();
      const source = order(), target = s.orders.find(x => x.id === p.targetOrderId);
      check(target, 'Cílový účet už neexistuje. Znovu otevři spojení účtů.');
      check(source.id !== target.id, 'Vyber jiný účet pro spojení.');
      check(!source.paymentLock && !target.paymentLock, 'Na jednom z účtů právě probíhá platba. Nejdřív ji dokonči nebo zkontroluj rezervaci.');
      check(source.revision === p.revision && target.revision === p.targetRevision, 'Jeden z účtů se změnil. Znovu otevři spojení účtů a zkontroluj částku.');
      check(source.lines.length > 0, 'Tento účet je prázdný.');
      const sourceTotal = sum(source.lines), total = sourceTotal + sum(target.lines);
      check(integer(total) && total > 0, 'Spojený účet překračuje limit.');
      const merged = structuredClone(target.lines);
      for (const line of source.lines) {
        const same = merged.find(x => sameLine(x, line) && x.quantity + line.quantity <= 999);
        if (same) same.quantity += line.quantity;
        else merged.push({ ...structuredClone(line), id: merged.some(x => x.id === line.id) ? uid() : line.id });
      }
      result = { type, orderId: target.id, name: target.name, sourceOrderId: source.id, sourceName: source.name,
        movedQuantity: source.lines.reduce((n, l) => n + l.quantity, 0), sourceTotal, total,
        visitSnapshots: {source:visitSessions(s,source,now),target:visitSessions(s,target,now)} };
      closedVisits.push(...result.visitSnapshots.source.filter(v=>!v.active),...result.visitSnapshots.target.filter(v=>!v.active));
      // A transfer of a bill says nothing about either person's presence or identity.
      // Keep both visits on their original accounts, even when the source is now empty.
      // Imported spend cannot be attributed precisely to the target's physical visit.
      if (target.visitId) target.visitHasCarriedBalance = true;
      target.lines = merged; target.revision++;
      source.lines = []; source.revision++;
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
      const smallShotPrice = own(p, 'smallShotPrice') ? p.smallShotPrice : old?.smallShotPrice ?? null;
      check(smallShotPrice === null || (integer(smallShotPrice) && smallShotPrice > 0), 'Cena 2cl panáku musí být kladná částka.');
      result = { id: old?.id || uid(), sourceCode: old?.sourceCode || '', priceNote: '', name: clean(p.name), category: clean(p.category, 40) || 'Ostatní', serving: clean(p.serving, 40), price: p.price, vatRate: p.vatRate, active: p.active !== false, stockProductId: clean(p.stockProductId), smallShotPrice };
      if (old) Object.assign(old, result); else s.products.push(result);
    } else if (type === 'archiveProduct') {
      const product = s.products.find(x => x.id === p.id); check(product, 'Položka neexistuje.'); product.active = false;
    } else if (type === 'addLine') {
      needShift(); const o = order(); const pr = s.products.find(x => x.id === p.productId && x.active);
      check(pr && integer(pr.price) && pr.price > 0, 'Nejdřív nastav cenu položky.');
      check(s.settings.vat !== 'payer' || pr.vatRate !== null, 'U této položky nejdřív nastav sazbu DPH v ceníku.');
      const quantity = p.quantity === undefined ? 1 : p.quantity;
      check(integer(quantity, 999) && quantity > 0, 'Vyber množství 1 až 999.');
      check(p.servingMl === undefined || p.servingMl === 20, 'Vyber běžnou porci nebo 2 cl.');
      const portion = p.servingMl === 20 ? smallShot(pr) : {name:pr.name,serving:pr.serving,price:pr.price};
      check(portion && integer(portion.price) && portion.price > 0, 'Tuto položku nelze prodat jako 2cl panák. Doplň skutečnou porci a cenu.');
      const nextLine = {productId:pr.id,sourceCode:pr.sourceCode || '',stockProductId:pr.stockProductId,vatRate:pr.vatRate,...portion};
      const line = o.lines.find(x => sameLine(x,nextLine));
      check(!line || line.quantity + quantity <= 999, 'Limit množství je 999.');
      check(sum(o.lines) + portion.price * quantity <= 100000000, 'Překročen limit účtu.');
      touchVisit(o);
      if (line) line.quantity += quantity;
      else o.lines.push({id:uid(),...nextLine,quantity});
      check(sum(o.lines) <= 100000000, 'Překročen limit účtu.'); o.revision++;
    } else if (type === 'removeLine') {
      needShift(); const o = order(); const l = o.lines.find(x => x.id === p.lineId); check(l, 'Položka neexistuje.'); check(clean(p.reason), 'Doplň důvod opravy.');
      check(!l.stockIssue, 'Tato porce už byla vydaná do skladu. Oprava spotřeby vyžaduje skladovou korekci vedoucího.');
      l.quantity--; o.lines = o.lines.filter(x => x.quantity > 0);
      if (!o.lines.length) { clearVisit(o); }
      o.revision++;
    } else if (type === 'setLineQuantity') {
      needShift(); const o = order(); const l = o.lines.find(x => x.id === p.lineId); check(l, 'Položka neexistuje.');
      check(integer(p.quantity, 999) && p.quantity > 0, 'Vyber množství 1 až 999.');
      check(!l.stockIssue || p.quantity===l.quantity, 'Počet již vydaných porcí nelze přepsat. Další porce přidej z nabídky.');
      if (p.quantity > l.quantity) touchVisit(o);
      l.quantity = p.quantity; check(sum(o.lines) <= 100000000, 'Překročen limit účtu.'); o.revision++;
    } else if (type === 'checkout') {
      check(typeof p.operationId === 'string' && p.operationId.length > 10, 'Chybí identifikátor platby.');
      const duplicate = s.receipts.find(x => x.operationId === p.operationId); if (duplicate) return duplicate;
      needShift(); const o = order(); check(o.revision === p.revision, 'Účet se změnil v jiném okně. Znovu otevři platbu.');
      const lines = selectedLines(o, p.selected); const pay = payment(sum(lines), p.mode, p.received, p.splitCash);
      check(!pay.card || p.cardConfirmed === true, 'Nejdřív potvrď úspěšnou platbu na terminálu.');
      if(pay.credit){const customer=ensureCustomer(s,o,now);check(creditBalance(s,customer.id)>=pay.credit,'Na kreditu není dostatek prostředků.');}
      if (s.settings.vat === 'payer') check(lines.every(x => x.vatRate !== null), 'Na účtu chybí sazba DPH. Oprav položky před zaplacením.');
      const sessions = visitSessions(s,o,now), activeVisit = sessions.find(v=>v.active), latestVisit = sessions[sessions.length-1];
      if (activeVisit) visitActivity = {orderId:o.id,visitId:activeVisit.id,at:now};
      closedVisits.push(...sessions.filter(v=>!v.active));
      const visitId = latestVisit?.id || o.visitId, visitStartedAt = latestVisit?.startedAt || o.visitStartedAt;
      s.sequence++;
      result = { id: uid(), operationId: p.operationId, number: `${s.deviceId.slice(0, 4).toUpperCase()}-${String(s.sequence).padStart(6, '0')}`, kind: 'sale', at: now, shiftId: sh.id, orderId: o.id, orderName: o.name, customerId:o.customerId||null, deviceId: s.deviceId, venueId: s.venueId, operator: sh.operator, settings: { ...s.settings }, lines, ...pay, ...(visitId && visitStartedAt ? { visitId, visitStartedAt } : {}) };
      for (const line of lines) {
        const original=o.lines.find(x=>x.id===line.id);
        // Copy the source range: later partial payments must consume distinct portions.
        if(original.stockIssue){line.stockIssue=structuredClone(original.stockIssue);original.stockIssue={...original.stockIssue,offset:original.stockIssue.offset+line.quantity};}
        original.quantity-=line.quantity;
      }
      o.lines = o.lines.filter(x => x.quantity > 0);
      if (visitId && visitStartedAt) {
        if (latestVisit?.estimated || o.visitHasCarriedBalance || sessions.length > 1) result.visitEstimated = true;
        if (!activeVisit || !o.lines.length) {
          result.visitEndedAt = latestVisit?.endedAt || now;
          result.visitDurationMinutes = Math.max(0,Math.floor((Date.parse(result.visitEndedAt)-Date.parse(visitStartedAt))/60000));
          if (activeVisit) closedVisits.push({...activeVisit,active:false,endedAt:now,durationMinutes:result.visitDurationMinutes,estimated:result.visitEstimated===true,reason:'paid'});
        }
        if (!o.lines.length) clearVisit(o);
        else if (activeVisit) o.visitLastActivityAt = now;
        else if (latestVisit?.endedAt) { o.visitEndedAt=latestVisit.endedAt; o.visitEndEstimated=latestVisit.estimated===true; }
      }
      s.receipts.push(result); o.revision++;
      if(pay.credit)(s.creditLedger||=[]).push({id:uid(),type:'spend',customerId:result.customerId,customerName:result.orderName,orderId:o.id,shiftId:sh.id,amount:-pay.credit,method:'credit',receiptId:result.id,at:now,actorId});
    } else if (type === 'refund') {
      needShift(); const sale = s.receipts.find(x => x.id === p.receiptId && x.kind === 'sale');
      check(sale && sale.shiftId === sh.id, 'Vratku lze provést pouze k prodeji v právě otevřené směně.');
      check(!s.receipts.some(x => x.refundOf === sale.id), 'Tento doklad už má vratku.');
      const terminalConfirmation = refundVerification(sale, p, now);
      s.sequence++; result = { ...sale, ...receiptAccount(s, sale), customerId:sale.customerId||null, id: uid(), operationId: uid(), number: `${s.deviceId.slice(0, 4).toUpperCase()}-${String(s.sequence).padStart(6, '0')}`, at: now, kind: 'refund', refundOf: sale.id, reason: clean(p.reason), terminalConfirmation, total: -sale.total, cash: -sale.cash, card: -sale.card, credit: -(sale.credit||0), rounding: -sale.rounding, received: 0, change: 0 };
      s.receipts.push(result);
      if(result.credit<0)(s.creditLedger||=[]).push({id:uid(),type:'refund',customerId:sale.customerId,customerName:result.orderName,orderId:result.orderId,shiftId:sh.id,amount:-result.credit,method:'credit',receiptId:result.id,refundOf:sale.id,at:now,actorId});
    } else if (type === 'restoreReceipt') {
      needShift(); const sale = s.receipts.find(x => x.id === p.receiptId && x.kind === 'sale');
      check(sale && sale.shiftId === sh.id, 'Na stůl lze vrátit pouze doklad z právě otevřené směny.');
      check(!s.receipts.some(x => x.refundOf === sale.id), 'Tento doklad už byl stornovaný nebo vrácený.');
      const terminalConfirmation = refundVerification(sale, p, now), account = receiptAccount(s, sale);
      const target = s.orders.find(x => x.id === account.orderId); check(target, 'Původní stůl už neexistuje.');
      check(!target.paymentLock, 'Na původním stole právě probíhá platba.');
      const merged = structuredClone(target.lines);
      for (const item of sale.lines) {
        // The server may split a historically substituted line into its actual stock recipes.
        const parts = item.stockIssue ? [item] : restoredLines?.[item.id] || [item];
        check(parts.reduce((n,x) => n+x.quantity,0) === item.quantity, 'Nesedí původní skladový odpis.');
        for (const part of parts) {
          const restored = { ...structuredClone(item), ...structuredClone(part) };
          const line = merged.find(x => sameLine(x, restored));
          if (line) { check(line.quantity + restored.quantity <= 999, 'Po vrácení by množství položky překročilo limit.'); line.quantity += restored.quantity; }
          else merged.push({ ...restored, id: uid() });
        }
      }
      check(sum(merged) <= 100000000, 'Po vrácení by účet překročil limit.');
      // Restoring an old bill changes the balance, not the customer's presence.
      target.lines = merged; target.revision++;
      s.sequence++; result = { ...sale, ...account, customerId:sale.customerId||null, id: uid(), operationId: uid(), number: `${s.deviceId.slice(0, 4).toUpperCase()}-${String(s.sequence).padStart(6, '0')}`, at: now, kind: 'refund', refundOf: sale.id, reason: clean(p.reason), terminalConfirmation, total: -sale.total, cash: -sale.cash, card: -sale.card, credit: -(sale.credit||0), rounding: -sale.rounding, received: 0, change: 0, restoredToOrderId: target.id, restoredToOrderName: target.name };
      s.receipts.push(result);
      if(result.credit<0)(s.creditLedger||=[]).push({id:uid(),type:'refund',customerId:sale.customerId,customerName:result.orderName,orderId:result.orderId,shiftId:sh.id,amount:-result.credit,method:'credit',receiptId:result.id,refundOf:sale.id,at:now,actorId});
    } else if (type === 'reassignReceipt') {
      needShift(); const sale = s.receipts.find(x => x.id === p.receiptId && x.kind === 'sale');
      check(sale && sale.shiftId === sh.id && !s.receipts.some(x => x.refundOf === sale.id), 'Přiřadit lze pouze platný prodej z právě otevřené směny.');
      const target = s.orders.find(x => x.id === p.targetOrderId), previous = receiptAccount(s, sale);
      check(target, 'Cílový stůl už neexistuje.');
      check(previous.orderId === p.previousOrderId, 'Přiřazení dokladu se změnilo. Otevři opravu znovu.');
      check(target.id !== previous.orderId, 'Doklad už je přiřazený k tomuto stolu.');
      check(clean(p.reason), 'Doplň důvod opravy.');
      result = { type, receiptId: sale.id, orderId: target.id, orderName: target.name, customerId:target.customerId||null, previousOrderId: previous.orderId, previousOrderName: previous.orderName, reason: clean(p.reason), at: now };
      s.receiptAssignments = { ...s.receiptAssignments, [sale.id]: { orderId: target.id, orderName: target.name, customerId:target.customerId||null, at: now } };
    } else if(type==='creditTopup' || type==='creditReverse') {
      const duplicate=p.operationId&&(s.creditLedger||[]).find(x=>x.operationId===p.operationId);
      if(duplicate)return {...duplicate,balance:creditBalance(s,duplicate.customerId)};
      needShift();s.creditLedger||=[];
      if(type==='creditTopup'){
        const o=order();
        check(integer(p.amount)&&p.amount>=1000,'Dobití musí být od 10 Kč do 1 000 000 Kč.');
        check(['cash','card'].includes(p.method),'Vyber hotovost nebo kartu.');
        check(p.method!=='cash'||p.amount%100===0,'Hotovostní dobití zadej v celých Kč.');
        check(p.method!=='card'||p.cardConfirmed===true,'Potvrď úspěšné dobití kartou na terminálu.');
        if(o.paymentLock)check(o.paymentLock.purpose==='creditTopup'&&o.paymentLock.token===p.paymentToken&&o.paymentLock.method===p.method&&o.paymentLock.amount===p.amount&&o.paymentLock.shiftId===sh.id,'Dobití nesouhlasí s připravenou platbou.');
        const customer=ensureCustomer(s,o,now);
        result={id:uid(),type:'topup',customerId:customer.id,customerName:customer.name,orderId:o.id,shiftId:sh.id,amount:p.amount,method:p.method,cardConfirmed:p.method==='card',at:now,actorId};
        delete o.paymentLock;
      }else{
        const original=s.creditLedger.find(x=>x.id===p.entryId&&x.type==='topup');
        check(original,'Původní dobití neexistuje.');
        check(!s.creditLedger.some(x=>x.reversalOf===original.id),'Toto dobití už bylo stornované.');
        check(creditBalance(s,original.customerId)>=original.amount,'Kredit už byl čerpán. Nejdřív ověř a vyřeš chybně uhrazené doklady.');
        const terminalConfirmation=refundVerification({card:original.method==='card'?original.amount:0},p,now);
        result={id:uid(),type:'reversal',customerId:original.customerId,customerName:original.customerName,orderId:original.orderId,shiftId:sh.id,amount:-original.amount,method:original.method,reversalOf:original.id,reason:clean(p.reason),terminalConfirmation,at:now,actorId};
        if(terminalConfirmation)terminalConfirmation.actorId=actorId;
      }
      if(p.operationId)result.operationId=p.operationId;
      s.creditLedger.push(result);result={...result,balance:creditBalance(s,result.customerId)};
    } else if (type === 'cashMovement') {
      needShift(); check(Number.isSafeInteger(p.amount) && Math.abs(p.amount) <= 100000000 && p.amount !== 0, 'Neplatná částka.'); check(clean(p.reason), 'Doplň důvod pohybu hotovosti.');
      sh.movements.push({ id: uid(), at: now, amount: p.amount, reason: clean(p.reason) });
    } else if (type === 'closeShift') {
      needShift();
      check(!s.orders.some(x=>x.paymentLock),'Nejdřív dokonči nebo uvolni všechny rozpracované platby.');
      check(!s.orders.some(x => x.lines.length && !customerLike(x.name)), 'Před uzávěrkou doplať rychlý prodej a běžné stoly. Nezaplacený pojmenovaný zákazník může zůstat otevřený.');
      check(integer(p.counted), 'Zadej spočítanou hotovost.');
      const issues=[];s.stockIssues||=[];
      for(const o of s.orders)for(const line of o.lines)if(!line.stockIssue){
        const issue={id:uid(),kind:'issue',number:'VÝDEJ · '+o.name,at:now,shiftId:sh.id,orderId:o.id,orderName:o.name,venueId:s.venueId,actorId,
          lines:[{...structuredClone(line),stockRecipe:own(line,'stockRecipe')?structuredClone(line.stockRecipe):recipeForLine(line,s.recipes?.[line.productId]||null)}]};
        line.stockRecipe=structuredClone(issue.lines[0].stockRecipe);line.stockIssue={id:issue.id,offset:0};
        s.stockIssues.push(issue);issues.push(issue);o.revision++;
      }
      const unpaidAccounts=s.orders.filter(x=>x.lines.length&&customerLike(x.name)).map(x=>({orderId:x.id,name:x.name,amount:sum(x.lines),itemCount:x.lines.reduce((n,l)=>n+l.quantity,0)}));
      const unpaidTotal=unpaidAccounts.reduce((n,x)=>n+x.amount,0);
      sh.summary = {...totals(s, sh.id),unpaidAccounts,unpaidTotal}; sh.counted = p.counted; sh.difference = p.counted - sh.summary.expected; sh.closedAt = now; sh.stockIssueIds=issues.map(x=>x.id);result = sh;
    } else if (type === 'settings') {
      check(['unknown', 'payer', 'nonpayer'].includes(p.vat), 'Neplatné nastavení DPH.');
      check(clean(p.venue), 'Zadej název podniku.');
      s.settings = { venue: clean(p.venue), company: clean(p.company), address: clean(p.address, 240), ico: clean(p.ico, 30), dic: clean(p.dic, 30), vat: p.vat, operator: clean(p.operator) || 'Obsluha' };
    } else if (type === 'backup') s.lastBackup = now;
    else throw new Error('Neznámá operace.');
    s.revision++;
    s.audit.push({ id: uid(), at: now, type, operator: sh?.operator || s.settings.operator, orderId: p.orderId || null, receiptId: result?.kind ? result.id : result?.receiptId || null, detail: structuredClone(p), ...(['addLine','setLineQuantity','checkout'].includes(type)?{visitActivity}:{}), ...(closedVisits.length ? { visits: structuredClone(closedVisits) } : {}), ...(type === 'endVisit' ? { visit: structuredClone(result) } : {}), ...(type === 'renameOrder' ? { rename: structuredClone(result) } : {}), ...(type === 'mergeOrders' ? { merge: structuredClone(result) } : {}), ...(type === 'reassignReceipt' ? { assignment: structuredClone(result) } : {}) });
    return result;
  }
  function validate(s) {
    check(s && s.schema === 1 && typeof s.deviceId === 'string' && typeof s.venueId === 'string', 'Soubor není záloha PUB-BIZZ.');
    for (const k of ['products', 'orders', 'shifts', 'receipts', 'audit']) check(Array.isArray(s[k]) && s[k].length < 100000, 'Poškozená nebo příliš velká záloha.');
    check(s.settings && typeof s.settings.venue === 'string' && ['unknown', 'payer', 'nonpayer'].includes(s.settings.vat) && integer(s.sequence) && integer(s.revision, 1000000000), 'Poškozená záloha.');
    for (const collection of [s.products, s.orders, s.shifts, s.receipts]) check(collection.every(x => x && typeof x.id === 'string') && new Set(collection.map(x => x.id)).size === collection.length, 'Neplatné identifikátory v záloze.');
    check(s.orders.some(o => o.id === 'bar'), 'Chybí účet rychlého prodeje.');
    for (const p of s.products) check(typeof p.name === 'string' && typeof p.category === 'string' && (p.price === null || integer(p.price)) && (p.smallShotPrice == null || (integer(p.smallShotPrice) && p.smallShotPrice > 0)), 'Poškozený ceník.');
    for (const o of s.orders) {
      check(typeof o.name === 'string' && integer(o.revision, 1000000000) && Array.isArray(o.lines), 'Poškozený účet.');
      if (o.visitId !== undefined || o.visitStartedAt !== undefined) check(typeof o.visitId === 'string' && typeof o.visitStartedAt === 'string' && !Number.isNaN(Date.parse(o.visitStartedAt)), 'Poškozený čas návštěvy na účtu.');
      if (o.visitLastActivityAt !== undefined) check(Number.isFinite(Date.parse(o.visitLastActivityAt)) && Date.parse(o.visitLastActivityAt)>=Date.parse(o.visitStartedAt), 'Poškozená aktivita návštěvy.');
      if (o.visitEndedAt !== undefined) check(Number.isFinite(Date.parse(o.visitEndedAt)) && Date.parse(o.visitEndedAt)>=Date.parse(o.visitStartedAt), 'Poškozený konec návštěvy.');
      for (const l of o.lines) { check(typeof l.id === 'string' && typeof l.name === 'string' && integer(l.price) && l.price > 0 && integer(l.quantity, 999) && l.quantity > 0, 'Neplatná položka v záloze.'); validatePortion(l); }
    }
    check(s.shifts.filter(x => !x.closedAt).length <= 1, 'Záloha obsahuje více otevřených směn.');
    for (const sh of s.shifts) {
      check(integer(sh.opening) && typeof sh.openedAt === 'string' && Array.isArray(sh.movements) && sh.movements.every(x => Number.isSafeInteger(x.amount)), 'Poškozená směna.');
      if (sh.closedAt) check(sh.summary && Number.isSafeInteger(sh.summary.total) && integer(sh.counted) && Number.isSafeInteger(sh.difference), 'Poškozená uzávěrka.');
    }
    for (const r of s.receipts) {
      check(['sale','refund'].includes(r.kind) && Array.isArray(r.lines) && r.lines.length && r.settings && typeof r.settings.venue === 'string' && s.shifts.some(x => x.id === r.shiftId), 'Poškozený doklad.');
      const credit=r.credit||0;
      check([r.total,r.cash,r.card,credit,r.rounding].every(Number.isSafeInteger) && r.total === r.cash + r.card + credit, 'Nesedí součet dokladu.');
      if (r.visitId !== undefined || r.visitStartedAt !== undefined) check(typeof r.visitId === 'string' && typeof r.visitStartedAt === 'string' && !Number.isNaN(Date.parse(r.visitStartedAt)), 'Poškozený začátek návštěvy na dokladu.');
      if (r.visitEndedAt !== undefined || r.visitDurationMinutes !== undefined) check(typeof r.visitEndedAt === 'string' && !Number.isNaN(Date.parse(r.visitEndedAt)) && integer(r.visitDurationMinutes, 10000000), 'Poškozený konec návštěvy na dokladu.');
      for (const l of r.lines) { check(integer(l.price) && integer(l.quantity, 999) && l.quantity > 0 && typeof l.name === 'string', 'Poškozená položka dokladu.'); validatePortion(l); }
      const sign = r.kind === 'sale' ? 1 : -1;
      check(sign * sum(r.lines) + r.rounding === r.total && sign * r.cash >= 0 && sign * r.card >= 0 && sign * credit >= 0, 'Nesedí položky dokladu.');
    }
    if(s.customers!==undefined){
      check(Array.isArray(s.customers)&&s.customers.length<100000&&s.customers.every(x=>x&&typeof x.id==='string'&&typeof x.name==='string'&&Array.isArray(x.aliases||[])), 'Poškozené zákaznické profily.');
      check(new Set(s.customers.map(x=>x.id)).size===s.customers.length,'Duplicitní zákaznické profily.');
    }
    if(s.creditLedger!==undefined){
      check(Array.isArray(s.creditLedger)&&s.creditLedger.length<100000,'Poškozená historie kreditu.');
      check(new Set(s.creditLedger.map(x=>x.id)).size===s.creditLedger.length,'Duplicitní záznam kreditu.');
      for(const x of s.creditLedger){
        check(x&&typeof x.id==='string'&&(s.customers||[]).some(c=>c.id===x.customerId)&&Number.isSafeInteger(x.amount)&&x.amount!==0&&['topup','spend','refund','reversal'].includes(x.type)&&['cash','card','credit'].includes(x.method)&&typeof x.at==='string','Poškozený záznam kreditu.');
        check(['topup','refund'].includes(x.type)?x.amount>0:x.amount<0,'Nesprávné znaménko pohybu kreditu.');
        if(x.type==='reversal'){
          const original=s.creditLedger.find(o=>o.id===x.reversalOf&&o.type==='topup');
          check(original&&original.customerId===x.customerId&&original.method===x.method&&original.amount===-x.amount&&clean(x.reason),'Poškozené storno dobití.');
          check(s.creditLedger.filter(o=>o.reversalOf===x.reversalOf).length===1,'Duplicitní storno dobití.');
        }
      }
      for(const customer of s.customers||[])check(creditBalance(s,customer.id)>=0,'Kredit zákazníka nesmí být záporný.');
    }
    if(s.stockIssues!==undefined){
      check(Array.isArray(s.stockIssues)&&s.stockIssues.length<100000&&new Set(s.stockIssues.map(x=>x.id)).size===s.stockIssues.length,'Poškozené skladové výdeje.');
      for(const issue of s.stockIssues)check(typeof issue.id==='string'&&issue.kind==='issue'&&issue.lines?.length===1&&integer(issue.lines[0].quantity,999)&&issue.lines[0].quantity>0,'Poškozený skladový výdej.');
    }
    for(const line of [...s.orders.flatMap(o=>o.lines),...s.receipts.flatMap(r=>r.lines)])if(line.stockIssue){
      const issue=(s.stockIssues||[]).find(x=>x.id===line.stockIssue.id);
      check(issue&&integer(line.stockIssue.offset,999)&&line.stockIssue.offset+line.quantity<=issue.lines[0].quantity,'Poškozený odkaz na vydanou porci.');
    }
    if (s.receiptAssignments !== undefined) {
      check(s.receiptAssignments && typeof s.receiptAssignments === 'object' && !Array.isArray(s.receiptAssignments), 'Poškozené přiřazení dokladů.');
      for (const [id, a] of Object.entries(s.receiptAssignments)) check(s.receipts.some(r => r.id === id && r.kind === 'sale') && a && typeof a.orderId === 'string' && typeof a.orderName === 'string' && typeof a.at === 'string', 'Poškozené přiřazení dokladu.');
    }
    return s;
  }
  const api = { VISIT_IDLE_MINUTES, visitSessions, initial, execute, money, sum, payment, activeShift, totals, validate, selectedLines, receiptAccount, shotVolumeMl, smallShot, recipeForLine, normalizeCustomerName, customerLike, findCustomer, ensureCustomer, creditBalance };
  if (typeof module !== 'undefined') module.exports = api; else root.POSCore = api;
})(globalThis);

