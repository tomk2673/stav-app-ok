const {test}=require('node:test');
const assert=require('node:assert/strict');
const I=require('../pub_bizz_pos/customer.js');

function state(){
  return {
    orders:[{id:'bar',name:'Rychlý prodej',lines:[],revision:0},{id:'petr',name:'Petr',lines:[],revision:0},{id:'jana',name:'Jana',lines:[],revision:0},{id:'5',name:'Stůl 5',lines:[],revision:0}],
    receipts:[
      {id:'a',kind:'sale',orderId:'petr',orderName:'Petr',total:25000,at:'2026-10-10T20:00:00Z',lines:[{productId:'beer',name:'Pivo',serving:'0,5',price:5000,quantity:3},{productId:'rum',name:'Rum',serving:'0,04',price:10000,quantity:1}]},
      {id:'b',kind:'sale',orderId:'petr',orderName:'Petr',total:10000,at:'2026-10-11T20:00:00Z',visitId:'v1',visitStartedAt:'2026-10-11T18:00:00Z',visitEndedAt:'2026-10-11T20:00:00Z',visitDurationMinutes:120,lines:[{productId:'beer',name:'Pivo',serving:'0,5',price:5000,quantity:2}]},
      {id:'c',kind:'sale',orderId:'jana',orderName:'Jana',total:50000,at:'2026-10-11T21:00:00Z',lines:[{productId:'wine',name:'Víno',serving:'0,1',price:5000,quantity:10}]},
      {id:'r',kind:'refund',refundOf:'c',orderId:'jana',orderName:'Jana',total:-50000,at:'2026-10-11T22:00:00Z',lines:[{productId:'wine',name:'Víno',serving:'0,1',price:5000,quantity:10}]}
    ],
    receiptAssignments:{}
  };
}
test('customer totals use paid non-refunded receipts only',()=>{
  const s=state(),p=I.profile(s,'Petr',null,'2026-10-12T00:00:00Z');
  assert.equal(p.spend,35000);assert.equal(p.points,35);assert.equal(p.itemCount,6);
  assert.equal(p.items[0].productId,'beer');assert.equal(p.items[0].quantity,5);
  assert.equal(I.profile(s,'Jana').spend,0);
});
test('receipt reassignment moves spend and favorites to the corrected customer',()=>{
  const s=state();s.receiptAssignments.a={orderId:'jana',orderName:'Jana',at:'2026-10-12T00:00:00Z'};
  assert.equal(I.profile(s,'Petr').spend,10000);
  assert.equal(I.profile(s,'Jana').spend,25000);
  assert.equal(I.productCounts(s,'Jana').get('beer'),3);
});
test('ranking excludes tables and quick sale',()=>{
  const s=state();s.receipts.push({id:'d',kind:'sale',orderId:'jana',orderName:'Jana',total:40000,at:'2026-10-12T00:00:00Z',lines:[{productId:'x',name:'X',price:40000,quantity:1}]});
  const board=I.leaderboard(s);assert.deepEqual(board.map(x=>x.name),['Petr','Jana']);assert.equal(I.profile(s,'Petr').rank,1);
});
test('exact visit time drives hours and spend per hour only for timed visits',()=>{
  const s=state(),p=I.profile(s,'Petr',{name:'Petr',visitStartedAt:'2026-10-12T21:00:00Z'},'2026-10-12T22:30:00Z');
  assert.equal(p.visitCount,1);assert.equal(p.totalMinutes,120);assert.equal(p.averageMinutes,120);assert.equal(p.timedSpend,10000);assert.equal(p.spendPerHour,5000);assert.equal(p.currentMinutes,90);
});
