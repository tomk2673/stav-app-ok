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
    return (state.orders || []).find(o => o.id === account.orderId)?.name || account.orderName;
  }
  function salesFor(state, name) {
    const key = normalize(name), customer=C.findCustomer?.(state,name);
    const aliases=new Set([key,...((customer?.aliases)||[]).map(normalize)]);
    return validSales(state).filter(r => (customer&&r.customerId===customer.id) || aliases.has(normalize(receiptName(state, r))));
  }
  function productCounts(state, name) {
    const counts = new Map();
    for (const receipt of salesFor(state, name)) for (const line of receipt.lines || []) {
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
    const key = normalize(name), sales = salesFor(state, name), customer=C.findCustomer?.(state,name);
    const spend = sales.reduce((n,r) => n + r.total, 0);
    const itemMap = new Map();
    for (const receipt of sales) for (const line of receipt.lines || []) {
      const id = line.productId || normalize(line.name+' '+(line.serving||''));
      const row = itemMap.get(id) || {productId:line.productId||'',name:line.name,serving:line.serving||'',quantity:0,spend:0};
      row.name=line.name;row.serving=line.serving||row.serving;row.quantity+=line.quantity;row.spend+=line.price*line.quantity;itemMap.set(id,row);
    }
    const items = [...itemMap.values()].sort((a,b) => b.quantity-a.quantity || b.spend-a.spend || a.name.localeCompare(b.name,'cs'));
    const completed = new Map();
    for (const receipt of state.receipts || []) {
      if (receipt.kind !== 'sale' || normalize(receiptName(state, receipt)) !== key || !receipt.visitId || !receipt.visitEndedAt || !Number.isSafeInteger(receipt.visitDurationMinutes)) continue;
      completed.set(receipt.visitId,{id:receipt.visitId,startedAt:receipt.visitStartedAt,endedAt:receipt.visitEndedAt,durationMinutes:receipt.visitDurationMinutes});
    }
    const visits = [...completed.values()].sort((a,b) => String(b.endedAt).localeCompare(String(a.endedAt)));
    const visitIds = new Set(visits.map(v=>v.id));
    const timedSpend = sales.filter(r=>visitIds.has(r.visitId)).reduce((n,r)=>n+r.total,0);
    const totalMinutes = visits.reduce((n,v)=>n+v.durationMinutes,0);
    const currentMinutes = currentOrder && normalize(currentOrder.name)===key && currentOrder.visitStartedAt
      ? Math.max(0,Math.floor((Date.parse(now)-Date.parse(currentOrder.visitStartedAt))/60000)) : 0;
    const board = leaderboard(state), rankIndex = board.findIndex(x=>x.key===key);
    return {
      name, customerId:customer?.id||currentOrder?.customerId||null, creditBalance:customer?C.creditBalance(state,customer.id):currentOrder?.customerId?C.creditBalance(state,currentOrder.customerId):0,
      spend, points:Math.floor(spend / POINT_VALUE), pointValueCzk:POINT_VALUE/100,
      rank:rankIndex<0?null:rankIndex+1, competitors:board.length,
      receiptCount:sales.length, itemCount:items.reduce((n,x)=>n+x.quantity,0), items,
      visitCount:visits.length, totalMinutes, averageMinutes:visits.length?Math.round(totalMinutes/visits.length):0,
      spendPerHour:totalMinutes?Math.round(timedSpend*60/totalMinutes):0, timedSpend,
      currentMinutes, visits, lastAt:sales.reduce((latest,r)=>!latest||String(r.at)>String(latest)?r.at:latest,null)
    };
  }
  const api={POINT_VALUE,normalize,accountNumber,isCustomerName,validSales,salesFor,productCounts,leaderboard,profile};
  if(typeof module!=='undefined')module.exports=api;else root.POSCustomerInsights=api;
})(globalThis);
