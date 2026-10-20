/* Append-only history transport. Commands and their immutable UUIDs are unchanged. */
(function(root){
  'use strict';
  const tail=a=>a.length?a[a.length-1].id:null;
  const cursor=s=>s?{version:1,venueId:s.venueId,revision:s.revision,audits:s.audit.length,auditTail:tail(s.audit),receipts:s.receipts.length,receiptTail:tail(s.receipts)}:null;
  const valid=c=>c?.version===1&&typeof c.venueId==='string'&&['revision','audits','receipts'].every(k=>Number.isSafeInteger(c[k])&&c[k]>=0);
  const prefix=(s,c)=>valid(c)&&s.venueId===c.venueId&&s.revision>=c.revision&&s.audit.length>=c.audits&&s.receipts.length>=c.receipts
    &&(c.audits?s.audit[c.audits-1].id:null)===c.auditTail&&(c.receipts?s.receipts[c.receipts-1].id:null)===c.receiptTail;
  function encode(s,c){
    if(!prefix(s,c))return {state:s};
    if(s.revision===c.revision&&s.audit.length===c.audits&&s.receipts.length===c.receipts)return {unchanged:true,revision:s.revision,syncFrom:c};
    return {delta:{from:c,head:cursor(s),state:{...s,audit:s.audit.slice(c.audits),receipts:s.receipts.slice(c.receipts)}}};
  }
  function decode(base,data){
    if(data.state)return data.state;
    if(data.unchanged){
      if(!base||base.revision!==data.revision||JSON.stringify(cursor(base))!==JSON.stringify(data.syncFrom))throw new Error('Je potřeba úplné obnovení účtu.');
      return base;
    }
    const d=data.delta;if(!d||!base)throw new Error('Chybí potvrzený základ účtu.');
    if(base.venueId===d.head.venueId&&base.revision>=d.head.revision)return base;
    if(!prefix(base,d.from))throw new Error('Historie účtu se změnila. Je potřeba úplné obnovení.');
    const next={...d.state,audit:[...base.audit.slice(0,d.from.audits),...d.state.audit],receipts:[...base.receipts.slice(0,d.from.receipts),...d.state.receipts]};
    if(JSON.stringify(cursor(next))!==JSON.stringify(d.head))throw new Error('Přenos změn není úplný.');
    return next;
  }
  const api={cursor,valid,encode,decode};
  if(typeof module!=='undefined')module.exports=api;else root.POSSync=api;
})(globalThis);
