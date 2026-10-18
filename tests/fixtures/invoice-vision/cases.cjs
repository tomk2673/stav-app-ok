'use strict';
// Every company, identifier and transaction in this file is fictional.
const row=(name,quantity,price,vat,net,gross,extra={})=>({raw_name:name,source_code:null,quantity,unit:'ks',
  unit_price_net:price,unit_price_gross:Math.round(price*(1+vat/100)*100)/100,vat_rate:vat,
  line_total_net:net,line_total_gross:gross,discount_percent:null,discount_amount_net:null,
  is_bonus:false,confidence:1,warning:null,...extra});
const base=(number,lines,net,vat,gross,extra={})=>({document_type:'invoice',supplier:'FIKTIVNÍ GASTRO s.r.o.',
  supplier_ico:'00000001',supplier_dic:'CZ00000001',invoice_number:number,issue_date:'2026-10-15',
  tax_date:'2026-10-15',due_date:'2026-10-29',currency:'CZK',total_net:net,total_vat:vat,total_gross:gross,
  amount_due:gross,rounding_amount:0,confidence:1,warnings:[],lines,...extra});
module.exports=[
 {id:'mixed-vat',title:'Faktura · 21 %, 12 %, 0 %, bonus a český zápis 5.812,-',expected:base('TEST-2026-001',[
  row('Fiktivní vodka 0,7 l',2,1000,21,2000,2420,{source_code:'00012'}),
  row('Fiktivní džus 1 l',3,50,12,150,168),row('Vratná přepravka',1,10,0,10,10),
  row('Bonusový kelímek',1,0,0,0,0,{is_bonus:true}),row('Fiktivní gin 1 l',1,2656.2,21,2656.2,3214)
 ],4816.2,995.8,5812),printedTotal:'5.812,-',warningPattern:null},
 {id:'discount-advance',title:'Faktura · sleva 10 % a zaplacená záloha',expected:base('TEST-2026-002',[
  row('Fiktivní tonik 0,25 l',10,100,21,900,1089,{discount_percent:10,discount_amount_net:100})
 ],900,189,1089,{amount_due:589}),advance:500,warningPattern:null},
 {id:'quantity-units',title:'Faktura · 1.000 ks, 1,5 l a karton',expected:base('TEST-2026-003',[
  row('Fiktivní rum 0,7 l',1,1000,21,1000,1210),
  row('Fiktivní džus volně',1.5,50,12,75,84,{unit:'l'}),
  row('Fiktivní tonik 6 × 0,25 l',1,200,21,200,242,{unit:'kart'})
 ],1275,261,1536),quantityStrings:['1.000','1,500','1,000'],warningPattern:null},
 {id:'credit-note',title:'Dobropis · vrácení dvou lahví',expected:base('TEST-D-2026-004',[
  row('Vrácení fiktivní vodky 0,7 l',-2,100,21,-200,-242)
 ],-200,-42,-242,{document_type:'credit_note'}),warningPattern:'Dobropis'},
 {id:'unreadable',title:'Faktura · nečitelné množství se nesmí dopočítat',expected:base('TEST-2026-005',[
  row('Fiktivní vodka 0,7 l',null,100,21,100,121,{warning:'Množství není čitelné.'})
 ],100,21,121),warningPattern:'množství'}
];
