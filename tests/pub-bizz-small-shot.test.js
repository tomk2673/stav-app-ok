const {test}=require('node:test');
const assert=require('node:assert/strict');
const I=require('../pub_bizz_pos/customer.js');
const owner={id:crypto.randomUUID(),role:'owner'},staff={id:crypto.randomUUID(),role:'staff'};
for(const base of ['../pub_bizz_pos/','../supabase/functions/pub-bizz-pos/']){
 const C=require(base+'core.js'),D=require(base+'server-domain.js');
 function fixture(){
  let s=C.initial();const liquid={id:crypto.randomUUID(),unit_mode:'liquid',archived_at:null};
  const run=(type,p,actor=staff,records=[])=>{const n=D.run(s,type,p,actor,[liquid],undefined,records);s=n.state;return n.result;};
  run('openShift',{opening:0});const id=run('newOrder',{name:'Petr'}).id;
  const add=(quantity,servingMl)=>run('addLine',{orderId:id,productId:'agnis-2810',quantity,servingMl});
  const order=()=>s.orders.find(o=>o.id===id);
  const pay=selected=>{const lock=run('beginPayment',{orderId:id,revision:order().revision});return run('checkout',{orderId:id,revision:order().revision,paymentToken:lock.token,operationId:crypto.randomUUID(),selected:selected||order().lines.map(l=>({id:l.id,quantity:l.quantity})),mode:'card',received:0,cardConfirmed:true});};
  return {get s(){return s;},run,add,order,pay,id,liquid};
 }
 test(base+'three small shots remain three units at half price and separate from large shots',()=>{
  const f=fixture();f.add(3,20);f.add(2);
  const small=f.order().lines.find(l=>l.servingMl===20),large=f.order().lines.find(l=>!l.servingMl);
  assert.equal(small.quantity,3);assert.equal(small.price,2750);assert.match(small.name,/2 cl/);assert.equal(small.baseServingMl,40);
  assert.equal(large.quantity,2);assert.equal(large.price,5500);assert.equal(C.sum(f.order().lines),19250);
  const sale=f.pay([{id:small.id,quantity:1}]);assert.equal(sale.total,2750);assert.equal(sale.lines[0].quantity,1);
  assert.equal(f.order().lines.find(l=>l.id===small.id).quantity,2);assert.equal(f.order().lines.find(l=>l.id===large.id).quantity,2);C.validate(f.s);
 });
 test(base+'existing 2cl SKU keeps full listed price; unsafe products and client-defined sizes are rejected',()=>{
  const f=fixture(),before=structuredClone(f.s);
  for(const id of ['agnis-50','agnis-5751','agnis-2825'])assert.throws(()=>f.run('addLine',{orderId:f.id,productId:id,quantity:3,servingMl:20}),/2cl/);
  for(const servingMl of ['20',40,10,0,null])assert.throws(()=>f.run('addLine',{orderId:f.id,productId:'agnis-2810',quantity:1,servingMl}));
  assert.deepEqual(f.s,before);
  f.run('addLine',{orderId:f.id,productId:'agnis-3802',quantity:2,servingMl:20});assert.equal(f.order().lines[0].price,8000);assert.equal(f.order().lines[0].baseServingMl,20);
  const custom=f.run('product',{name:'Dluh',category:'Destiláty',serving:'',price:60000,vatRate:null},owner);
  assert.equal(C.smallShot(custom),null);
  assert.equal(C.shotVolumeMl({...custom,serving:'0,04l'}),40);
  assert.equal(C.smallShot(f.s.products.find(p=>p.id==='agnis-2801')).baseServingMl,40);
 });
 test(base+'only authorized catalog price is used and changing a small price preserves earlier lines',()=>{
  const f=fixture(),p=f.s.products.find(p=>p.id==='agnis-2810');
  f.run('addLine',{orderId:f.id,productId:p.id,quantity:1,servingMl:20,baseServingMl:1000,price:1});assert.equal(f.order().lines[0].price,2750);assert.equal(f.order().lines[0].baseServingMl,40);
  assert.throws(()=>f.run('product',{...p,smallShotPrice:3000}),/vedoucí/);
  f.run('product',{...p,smallShotPrice:3000},owner);f.add(2,20);
  assert.deepEqual(f.order().lines.map(l=>[l.price,l.quantity]),[[2750,1],[3000,2]]);
  f.run('product',{id:p.id,name:p.name,category:p.category,serving:p.serving,price:6000,vatRate:null},owner);
  assert.equal(f.s.products.find(x=>x.id===p.id).smallShotPrice,3000);
  f.run('product',{...f.s.products.find(x=>x.id===p.id),smallShotPrice:null},owner);assert.equal(C.smallShot(f.s.products.find(x=>x.id===p.id)).price,3000);
  for(const smallShotPrice of [0,-1,NaN,'30',0.5])assert.throws(()=>f.run('product',{...p,smallShotPrice},owner));
 });
 test(base+'recipe snapshots consume 20ml per small shot, with no second scaling after restoration',()=>{
  const f=fixture();f.run('recipe',{productId:'agnis-2810',version:0,mode:'recipe',components:[{productId:f.liquid.id,quantity:40,unit:'ml'}]},owner);
  f.add(3,20);const sale=f.pay();assert.equal(sale.lines[0].quantity,3);assert.equal(sale.lines[0].stockRecipe.components[0].quantity,20);
  assert.equal(f.s.recipes['agnis-2810'].components[0].quantity,40);
  f.run('restoreReceipt',{receiptId:sale.id,reason:'TEST',cardConfirmed:true,terminalReference:'TEST-2CL'},owner,[{line_id:sale.lines[0].id,status:'posted',recipe:sale.lines[0].stockRecipe}]);
  f.run('recipe',{productId:'agnis-2810',version:1,mode:'recipe',components:[{productId:f.liquid.id,quantity:40,unit:'ml'}]},owner);
  const resold=f.pay();assert.equal(resold.lines[0].stockRecipe.components[0].quantity,20);assert.equal(resold.lines[0].stockRecipe.version,1);assert.equal(resold.lines[0].price,2750);
 });
 test(base+'missing stock recipe retains the portion for a later exact 20ml resolution',()=>{
  const f=fixture();f.add(2,20);const sale=f.pay();assert.equal(sale.lines[0].stockRecipe,null);
  f.run('recipe',{productId:'agnis-2810',version:0,mode:'recipe',components:[{productId:f.liquid.id,quantity:40,unit:'ml'}]},owner);
  const resolution=f.run('resolveStock',{receiptId:sale.id,lineId:sale.lines[0].id},owner);assert.equal(resolution.recipe.components[0].quantity,20);
  assert.equal(sale.lines[0].stockRecipe,null);assert.equal(sale.lines[0].servingMl,20);
  f.run('recipe',{productId:'agnis-2810',version:1,mode:'recipe',components:[{productId:f.liquid.id,quantity:30,unit:'ml'}]},owner);
  assert.throws(()=>f.run('resolveStock',{receiptId:sale.id,lineId:sale.lines[0].id},owner),/běžné 4cl/);
 });
 test(base+'quantity changes and merges retain sizes; customer profile does not label large shots as small',()=>{
  const f=fixture();f.add(3,20);f.add(1);
  const small=f.order().lines.find(l=>l.servingMl===20);f.run('setLineQuantity',{orderId:f.id,lineId:small.id,quantity:5});
  const target=f.run('newOrder',{name:'Jana'});f.run('mergeOrders',{orderId:f.id,revision:f.order().revision,targetOrderId:target.id,targetRevision:0});
  const order=f.s.orders.find(o=>o.id===target.id);assert.equal(order.lines.length,2);assert.equal(order.lines.find(l=>l.servingMl===20).quantity,5);
  const lock=f.run('beginPayment',{orderId:target.id,revision:order.revision});
  f.run('checkout',{orderId:target.id,revision:order.revision,paymentToken:lock.token,operationId:crypto.randomUUID(),selected:order.lines.map(l=>({id:l.id,quantity:l.quantity})),mode:'card',received:0,cardConfirmed:true});
  const profile=I.profile(f.s,'Jana');assert.equal(profile.items.length,2);assert.equal(profile.itemCount,6);assert.equal(profile.items.find(x=>/2 cl/.test(x.name)).quantity,5);
  const broken=structuredClone(f.s);broken.receipts[0].lines[0].baseServingMl=200;assert.throws(()=>C.validate(broken),/velikost porce/);
 });
}
