/* Versioned marking intent, shared by the optimistic view and authoritative server.
   The browser supplies intent, never a replacement register or a trusted price. */
(function(root) {
  'use strict';
  const C = typeof module !== 'undefined' ? require('./core.js') : root.POSCore;
  const types = new Set(['addLine','removeLine','setLineQuantity']);
  const check = (ok,message) => { if(!ok) throw new Error(message); };
  const uuid = value => typeof value==='string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
  const lineKeys = ['productId','sourceCode','stockProductId','name','serving','price','vatRate','servingMl','baseServingMl','stockRecipe','stockIssue'];
  const signature = line => JSON.stringify(lineKeys.map(k=>line[k]??null));
  function productLine(s,p) {
    const pr=s.products.find(x=>x.id===p.productId&&x.active);
    check(pr,'Nápoj už není v nabídce.');
    const portion=p.servingMl===20?C.smallShot(pr):{name:pr.name,serving:pr.serving,price:pr.price};
    check(portion,'Tento nápoj nemá 2cl porci.');
    return {productId:pr.id,sourceCode:pr.sourceCode||'',stockProductId:pr.stockProductId,vatRate:pr.vatRate,...portion};
  }
  function barrier(s,id) {
    for(let i=s.audit.length-1;i>=0;i--) {
      const a=s.audit[i],p=a.detail||{};
      if(['checkout','renameOrder','endVisit','deleteOrder','beginPayment','cancelPayment','mergeOrders'].includes(a.type)
        && [a.orderId,p.orderId,p.targetOrderId].includes(id)) return a.id;
      if(a.type==='restoreReceipt'&&s.receipts.some(r=>r.id===a.receiptId&&r.restoredToOrderId===id))return a.id;
    }
    return null;
  }
  function lineVersion(s,line,orderId) {
    for(let i=s.audit.length-1;i>=0;i--) {
      const a=s.audit[i],p=a.detail||{};
      if((p.orderId||a.orderId)!==orderId)continue;
      if((['removeLine','setLineQuantity'].includes(a.type)&&(p.lineId===line.id||a.markingResult?.lineId===line.id))
        || (a.type==='addLine'&&p.productId===line.productId&&(p.servingMl||null)===(line.servingMl||null)))
        return p.marking?.operationId||a.id;
    }
    return null;
  }
  function prepare(s,type,payload,id) {
    check(types.has(type)&&uuid(id),'Neplatná operace markování.');
    const p=structuredClone(payload),o=s.orders.find(x=>x.id===p.orderId);
    check(o,'Původní účet už neexistuje.');
    p.marking={version:1,operationId:id,shiftId:C.activeShift(s)?.id,orderName:o.name,customerId:o.customerId||null,barrier:barrier(s,o.id),vat:s.settings.vat};
    if(type==='addLine')Object.assign(p.marking,{lineId:id,product:signature(productLine(s,p))});
    else {
      const line=o.lines.find(x=>x.id===p.lineId);check(line,'Položka už neexistuje.');
      Object.assign(p.marking,{line:signature(line),quantity:line.quantity,lineVersion:lineVersion(s,line,o.id)});
    }
    return p;
  }
  function normalize(s,type,payload) {
    const p=structuredClone(payload),m=p.marking;
    if(!m)return p; // Older clients retain the existing strictly online protocol.
    check(types.has(type)&&m.version===1&&uuid(m.operationId),'Nepodporovaná operace markování.');
    const o=s.orders.find(x=>x.id===p.orderId);
    check(o&&o.name===m.orderName&&(o.customerId||null)===m.customerId,'Účet nebo host se změnil. Zkontroluj čekající položku.');
    check(C.activeShift(s)?.id===m.shiftId&&!!m.shiftId,'Směna se změnila. Zkontroluj čekající položku.');
    check(barrier(s,o.id)===m.barrier,'Účet byl mezitím placený, převedený nebo upravený. Zkontroluj čekající položku.');
    check(!o.paymentLock,'Na tomto účtu právě probíhá platba. Zkontroluj čekající položku.');
    check(s.settings.vat===m.vat,'Změnil se režim DPH. Zkontroluj čekající položku.');
    if(type==='addLine') {
      check(uuid(m.lineId)&&m.lineId===m.operationId,'Neplatný identifikátor položky.');
      check(signature(productLine(s,p))===m.product,'Změnila se cena nebo porce nápoje. Zkontroluj čekající položku.');
    } else {
      // A concurrent add can merge our provisional line into an existing row.
      // Resolve only a server-recorded alias, never another row with a similar name.
      const alias=s.audit.find(a=>a.type==='addLine'&&a.detail?.marking?.lineId===p.lineId)?.markingResult?.lineId;
      if(alias)p.lineId=alias;
      const line=o.lines.find(x=>x.id===p.lineId);
      check(line&&signature(line)===m.line&&line.quantity===m.quantity&&lineVersion(s,line,o.id)===m.lineVersion,
        'Počet nebo položku změnilo jiné zařízení. Zkontroluj čekající úpravu.');
    }
    return p;
  }
  function record(s,type,p) {
    if(!p.marking)return;
    const o=s.orders.find(x=>x.id===p.orderId);
    const line=type==='addLine'?o.lines.find(x=>!x.stockIssue&&!Object.hasOwn(x,'stockRecipe')&&signature(x)===p.marking.product):null;
    s.audit[s.audit.length-1].markingResult={lineId:line?.id||p.lineId};
  }
  function apply(s,type,p,now,actor) {
    const normalized=normalize(s,type,p);
    C.execute(s,type,normalized,now,undefined,actor);record(s,type,normalized);return s;
  }
  const outcome=(s,id)=>s.audit.find(a=>a.detail?.marking?.operationId===id&&(types.has(a.type)||a.type==='markingRejected'));
  const applied=(s,id)=>types.has(outcome(s,id)?.type);
  function reject(state,type,p,message,actor,now=new Date().toISOString()) {
    const s=structuredClone(state),result={type:'markingRejected',requestId:p.marking.operationId,message};
    s.revision++;
    s.audit.push({id:crypto.randomUUID(),type:'markingRejected',at:now,actorId:actor,orderId:p.orderId,detail:structuredClone(p),rejectedType:type,message});
    C.validate(s);
    return {state:s,result};
  }
  const api={types,prepare,normalize,record,apply,applied,outcome,reject};
  if(typeof module!=='undefined')module.exports=api;else root.POSMarking=api;
})(globalThis);
