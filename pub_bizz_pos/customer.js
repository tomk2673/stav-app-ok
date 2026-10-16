/* Customer insights are derived from confirmed receipts; no separate customer ledger can drift out of sync. */
(function(root){
  'use strict';
  const C = typeof module !== 'undefined' ? require('./core.js') : root.POSCore;
  const POINT_VALUE = 1000; // 10 CZK in halere
  const normalize = value => String(value ?? '').toLocaleLowerCase('cs').normalize('NFD').replace(/[\u0300-\u036f]/g, '').trim();
  const accountNumber = name => String(name ?? '').match(/^(?:st[ůu]l\s*#?\s*)?(\d+)\b/i)?.[1] || '';
  const isCustomerName = name => {
    const key = normalize(name);
    return !!key && key !== 'rychly prodej' && !accountNumber(name);
  };
  const refundedIds = state => new Set((state.receipts || []).filter(r => r.kind === 'refund' && r.refundOf).map(r => r.refundOf));
  function validSales(state) {
    const refunded = refundedIds(state);
    return (state.receipts || []).filter(r => r.kind === 'sale' && !refunded.has(r.id));
  }
  function receiptName(state, receipt) {
    const account = C.receiptAccount(state, receipt);
    const assigned=Object.prototype.hasOwnProperty.call(state.receiptAssignments||{},receipt.id);
    const customerId=assigned?account.customerId:receipt.customerId;
    const customer=(state.customers||[]).find(c=>c.id===customerId);
    if(customer)return customer.name;
    return (state.orders || []).find(o => o.id === account.orderId)?.name || account.orderName;
  }
  function activeOrder(state,name) {
    const key=normalize(name);
    return (state.orders||[]).find(o=>o.id!=='bar'&&normalize(o.name)===key)||null;
  }
  function orderAliases(state,order) {
    const aliases=new Set([normalize(order?.name)]);
    if(!order)return aliases;
    for(const event of state.audit||[]) {
      const r=event?.rename;
      if(event?.type==='renameOrder'&&r?.orderId===order.id){aliases.add(normalize(r.previousName));aliases.add(normalize(r.name));}
    }
    return aliases;
  }
  function salesFor(state, name, customerId = null, orderId = null) {
    const order=orderId?(state.orders||[]).find(o=>o.id===orderId):activeOrder(state,name);
    if(!order&&!customerId)return [];
    const id=customerId||order?.customerId||null, aliases=orderAliases(state,order);
    return validSales(state).filter(r => {
      const assigned=Object.prototype.hasOwnProperty.call(state.receiptAssignments||{},r.id), account=C.receiptAccount(state,r);
      const target=(state.orders||[]).find(o=>o.id===account.orderId);
      const owner=assigned?(account.customerId??target?.customerId):r.customerId;
      // An explicit assignment always wins; the original payer still owns any wallet refund.
      if(owner)return !!id&&owner===id;
      return target?target.id===order?.id:aliases.has(normalize(receiptName(state,r)));
    });
  }
  function productCounts(state, name, customerId = null, orderId = null) {
    const counts = new Map();
    for (const receipt of salesFor(state, name, customerId, orderId)) for (const line of receipt.lines || []) {
      counts.set(line.productId, (counts.get(line.productId) || 0) + line.quantity);
    }
    return counts;
  }
  function leaderboard(state) {
    const spend = new Map(), names = new Map();
    for (const receipt of validSales(state)) {
      const name = receiptName(state, receipt);
      if (!isCustomerName(name)) continue;
      const key = normalize(name);
      names.set(key, name);
      spend.set(key, (spend.get(key) || 0) + receipt.total);
    }
    for (const order of state.orders || []) if (order.id !== 'bar' && isCustomerName(order.name)) {
      const key = normalize(order.name);
      names.set(key, order.name);
      if (!spend.has(key)) spend.set(key, 0);
    }
    return [...names].map(([key,name]) => {
      const total = spend.get(key) || 0;
      return {key,name,spend:total,points:Math.floor(total / POINT_VALUE)};
    }).sort((a,b) => b.points-a.points || b.spend-a.spend || a.name.localeCompare(b.name,'cs'));
  }
  function profile(state, name, currentOrder = null, now = new Date().toISOString()) {
    const key = normalize(name), order=currentOrder||activeOrder(state,name), customerId=order?.customerId||null, sales = salesFor(state, name, customerId, order?.id), customer=customerId?(state.customers||[]).find(x=>x.id===customerId):null;
    const spend = sales.reduce((n,r) => n + r.total, 0);
    const itemMap = new Map();
    for (const receipt of sales) for (const line of receipt.lines || []) {
      const id = JSON.stringify([line.productId || normalize(line.name),line.servingMl || 0,line.serving || '']);
      const row = itemMap.get(id) || {productId:line.productId||'',name:line.name,serving:line.serving||'',quantity:0,spend:0};
      row.name=line.name;row.serving=line.serving||row.serving;row.quantity+=line.quantity;row.spend+=line.price*line.quantity;itemMap.set(id,row);
    }
    const items = [...itemMap.values()].sort((a,b) => b.quantity-a.quantity || b.spend-a.spend || a.name.localeCompare(b.name,'cs'));
    const completed = new Map();
    for (const receipt of state.receipts || []) {
      if (receipt.kind !== 'sale' || normalize(receiptName(state, receipt)) !== key || !receipt.visitId || !receipt.visitEndedAt || !Number.isSafeInteger(receipt.visitDurationMinutes)) continue;
      completed.set(receipt.visitId,{id:receipt.visitId,startedAt:receipt.visitStartedAt,endedAt:receipt.visitEndedAt,durationMinutes:receipt.visitDurationMinutes,estimated:receipt.visitEstimated===true});
    }
    for (const event of state.audit || []) for (const visit of event.visits || []) {
      const visitName = (state.orders || []).find(o=>o.id===visit.orderId)?.name || visit.orderName;
      if (normalize(visitName)===key && Number.isSafeInteger(visit.durationMinutes) && visit.durationMinutes>=0) completed.set(visit.id,visit);
    }
    const sessions = currentOrder && normalize(currentOrder.name)===key ? C.visitSessions(state,currentOrder,now) : [];
    for (const visit of sessions.filter(v=>!v.active)) completed.set(visit.id,visit);
    const activeVisit = sessions.find(v=>v.active) || null;
    const visits = [...completed.values()].sort((a,b) => String(b.endedAt).localeCompare(String(a.endedAt)));
    const exactVisits = visits.filter(v=>!v.estimated);
    const visitIds = new Set(exactVisits.map(v=>v.id));
    const timedSpend = sales.filter(r=>visitIds.has(r.visitId)&&r.visitEstimated!==true).reduce((n,r)=>n+r.total,0);
    const totalMinutes = visits.reduce((n,v)=>n+v.durationMinutes,0);
    const exactMinutes = exactVisits.reduce((n,v)=>n+v.durationMinutes,0);
    const currentMinutes = activeVisit?.durationMinutes || 0;
    const board = leaderboard(state), rankIndex = board.findIndex(x=>x.key===key);
    const payments=[...sales].sort((a,b)=>String(b.at).localeCompare(String(a.at))).map(r=>({id:r.id,number:r.number,at:r.at,total:r.total,cash:r.cash||0,card:r.card||0,credit:r.credit||0}));
    const openAmount=order?C.sum(order.lines||[]):0;
    return {
      name, customerId:customer?.id||order?.customerId||null, creditBalance:customer?C.creditBalance(state,customer.id):order?.customerId?C.creditBalance(state,order.customerId):0,
      spend, openAmount, points:Math.floor(spend / POINT_VALUE), pointValueCzk:POINT_VALUE/100,
      rank:rankIndex<0?null:rankIndex+1, competitors:board.length,
      receiptCount:sales.length, itemCount:items.reduce((n,x)=>n+x.quantity,0), items, payments,
      visitCount:visits.length, totalMinutes, averageMinutes:visits.length?Math.round(totalMinutes/visits.length):0,
      spendPerHour:exactMinutes?Math.round(timedSpend*60/exactMinutes):0, timedSpend, exactMinutes,
      estimatedVisitCount:visits.filter(v=>v.estimated).length, activeVisit, lastVisit:sessions[sessions.length-1] || null,
      currentMinutes, visits, lastAt:sales.reduce((latest,r)=>!latest||String(r.at)>String(latest)?r.at:latest,null)
    };
  }
  const api={POINT_VALUE,normalize,accountNumber,isCustomerName,validSales,salesFor,productCounts,leaderboard,profile};
  if(typeof module!=='undefined')module.exports=api;else root.POSCustomerInsights=api;
})(globalThis);
