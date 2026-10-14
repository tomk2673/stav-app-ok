/* Rewards attach to paid receipts, never to a name or a reused physical table. */
(function(root){
  'use strict';
  function initial(){return {enabled:false,threshold:30000,rewards:[]};}
  function award(state,receipt,now){
    const l=state.loyalty;if(!l?.enabled||receipt.kind!=='sale')return;
    const count=Math.min(10,Math.floor(receipt.total/l.threshold));
    for(let i=0;i<count;i++){
      const id=receipt.id+':'+i;if(l.rewards.some(r=>r.id===id))continue;
      l.rewards.push({id,receiptId:receipt.id,orderId:receipt.orderId,orderName:receipt.orderName,earnedAt:now,status:'available',type:'next_song',threshold:l.threshold});
    }
  }
  function refund(state,receipt){
    for(const r of state.loyalty?.rewards||[])if(r.receiptId===receipt.refundOf){r.refunded=true;if(r.status==='available')r.status='cancelled';}
  }
  const api={initial,award,refund};if(typeof module!=='undefined')module.exports=api;else root.POSLoyalty=api;
})(globalThis);
