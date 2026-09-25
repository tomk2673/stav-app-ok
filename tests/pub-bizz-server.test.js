const test=require('node:test');
const assert=require('node:assert/strict');
const C=require('../pub_bizz_pos/core.js');
const D=require('../pub_bizz_pos/server-domain.js');
const owner={id:crypto.randomUUID(),role:'owner'},staff={id:crypto.randomUUID(),role:'staff'};
const product={id:crypto.randomUUID(),name:'Test rum',unit_mode:'liquid',archived_at:null};
const stock=[product];
function setup(){let s=C.initial();s=D.run(s,'openShift',{opening:10000},owner,stock).state;s=D.run(s,'addLine',{orderId:'bar',productId:'agnis-2810'},staff,stock).state;return s;}
function reserve(s,actor=staff){return D.run(s,'beginPayment',{orderId:'bar',revision:s.orders[0].revision},actor,stock);}
function payment(s,lock,actor=staff){return D.run(s,'checkout',{orderId:'bar',revision:s.orders[0].revision,paymentToken:lock.token,operationId:crypto.randomUUID(),selected:s.orders[0].lines.map(l=>({id:l.id,quantity:l.quantity})),mode:'cash',received:10000,splitCash:0},actor,stock);}
test('staff cannot change prices, recipes or refund; accountant is read only',()=>{
 const s=setup();for(const type of ['product','recipe','refund','settings'])assert.throws(()=>D.run(s,type,{},staff,stock),/vedoucí/);
 assert.throws(()=>D.run(s,'addLine',{}, {...staff,role:'accountant'},stock),/oprávnění/);
});
test('reservation blocks another checkout flow and changes to the bill',()=>{
 const {state:s,result:lock}=reserve(setup());
 assert.throws(()=>reserve(s,owner),/rezervovaný/);
 assert.throws(()=>D.run(s,'addLine',{orderId:'bar',productId:'agnis-2810'},owner,stock),/platba/);
 assert.throws(()=>payment(s,{token:crypto.randomUUID()}),/rezervovaný/);
 assert.throws(()=>payment(s,lock,{id:crypto.randomUUID(),role:'staff'}),/jiná obsluha/);
 const sale=payment(s,lock);assert.equal(sale.state.orders[0].paymentLock,undefined);assert.equal(sale.state.receipts.length,1);
 assert.equal(s.orders[0].lines.length,1,'command must not mutate its input');
});
test('reservation release requires explicit check and authorized actor',()=>{
 const {state:s,result:lock}=reserve(setup());
 assert.throws(()=>D.run(s,'cancelPayment',{orderId:'bar',paymentToken:lock.token},staff,stock),/zkontroluj/);
 assert.throws(()=>D.run(s,'cancelPayment',{orderId:'bar',paymentToken:lock.token,terminalChecked:true,reason:'check'},{...staff,id:crypto.randomUUID()},stock),/původní/);
 assert.equal(D.run(s,'cancelPayment',{orderId:'bar',paymentToken:lock.token,terminalChecked:true,reason:'Nezaplaceno'},owner,stock).state.orders[0].paymentLock,undefined);
});
test('recipe validates units, positive quantities and tenant stock list',()=>{
 const s=setup(),p={productId:'agnis-2810',version:0,mode:'recipe',components:[{productId:product.id,quantity:40,unit:'ml'}]};
 for(const patch of [{unit:'ks'},{quantity:0},{quantity:NaN},{productId:crypto.randomUUID()}])assert.throws(()=>D.run(s,'recipe',{...p,components:[{...p.components[0],...patch}]},owner,stock));
 const r=D.run(s,'recipe',p,owner,stock);assert.equal(r.state.recipes['agnis-2810'].components[0].quantity,40);
 assert.throws(()=>D.run(r.state,'recipe',p,owner,stock),/změnil/);
});
test('sale snapshots recipe, later recipe changes do not rewrite receipt',()=>{
 let s=D.run(setup(),'recipe',{productId:'agnis-2810',version:0,mode:'recipe',components:[{productId:product.id,quantity:40,unit:'ml'}]},owner,stock).state;
 const reserved=reserve(s);s=payment(reserved.state,reserved.result).state;
 s=D.run(s,'recipe',{productId:'agnis-2810',version:1,mode:'recipe',components:[{productId:product.id,quantity:20,unit:'ml'}]},owner,stock).state;
 assert.equal(s.receipts[0].lines[0].stockRecipe.components[0].quantity,40);
});
test('financial refund does not restock unless explicitly selected',()=>{
 const r=reserve(setup()),s=payment(r.state,r.result).state;
 const refund=D.run(s,'refund',{receiptId:s.receipts[0].id,reason:'Chyba'},owner,stock);
 assert.equal(refund.result.restock,false);assert.equal(refund.state.receipts[0].kind,'sale');
 assert.equal(D.run(s,'refund',{receiptId:s.receipts[0].id,reason:'Zboží vráceno',restock:true},owner,stock).result.restock,true);
});
