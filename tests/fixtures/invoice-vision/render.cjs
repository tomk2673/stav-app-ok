'use strict';
const fs=require('node:fs');
const path=require('node:path');
const {chromium}=require('../../pos-browser/node_modules/pwmodern');
const cases=require('./cases.cjs');
const escape=value=>String(value??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const money=value=>value==null?'NEČITELNÉ':value.toLocaleString('cs-CZ',{minimumFractionDigits:2,maximumFractionDigits:2});
(async()=>{
 const browser=await chromium.launch({headless:true});
 try{
  const page=await browser.newPage({viewport:{width:1400,height:1200},deviceScaleFactor:1});
  for(const c of cases){
   const i=c.expected;
   const html=`<!doctype html><html lang="cs"><meta charset="utf-8"><style>
   *{box-sizing:border-box}body{margin:0;padding:40px;color:#111;background:#fff;font:19px Arial,sans-serif}h1{font-size:32px}
   .test{border:3px solid #111;padding:14px;font-weight:bold}.parties{display:flex;justify-content:space-between;margin:28px 0;line-height:1.6}
   table{width:100%;border-collapse:collapse;margin:26px 0}th,td{border-bottom:1px solid #888;padding:14px 8px;text-align:right}td:first-child,th:first-child{text-align:left}
   .totals{margin-left:auto;width:440px;line-height:1.8}.total{font-size:26px;border-top:3px solid #111;font-weight:bold}footer{margin-top:30px;font-size:16px}
   </style><div class="test">FIKTIVNÍ ZKUŠEBNÍ DOKLAD · NENÍ DAŇOVÝ DOKLAD · NIC NEPLATIT</div>
   <h1>${i.document_type==='credit_note'?'DOBROPIS':'FAKTURA'} ${escape(i.invoice_number)}</h1>
   <div class="parties"><div><b>Dodavatel: ${escape(i.supplier)}</b><br>Zkušební ulice 1, 000 00 Testov<br>IČO: ${i.supplier_ico}, DIČ: ${i.supplier_dic}</div>
   <div><b>Odběratel: FIKTIVNÍ BAR</b><br>Fiktivní ulice 2, 000 00 Testov<br>IČO: 00000002</div></div>
   <p>Datum vystavení: 15. 10. 2026 · DUZP: 15. 10. 2026 · Splatnost: 29. 10. 2026 · Měna: CZK</p>
   <table><thead><tr><th>Položka / kód</th><th>Množství</th><th>MJ</th><th>Cena/MJ bez DPH</th><th>Sleva %</th><th>Sleva bez DPH</th><th>Základ řádku</th><th>DPH %</th><th>Řádek s DPH</th></tr></thead><tbody>${i.lines.map((l,index)=>`<tr><td>${escape(l.raw_name)}${l.source_code?'<br>kód '+escape(l.source_code):''}${l.is_bonus?'<br>BONUS ZDARMA':''}</td><td>${l.quantity==null?'[NEČITELNÉ]':c.quantityStrings?.[index]||money(l.quantity)}</td><td>${escape(l.unit)}</td><td>${money(l.unit_price_net)}</td><td>${l.discount_percent==null?'—':money(l.discount_percent)}</td><td>${l.discount_amount_net==null?'—':money(l.discount_amount_net)}</td><td>${money(l.line_total_net)}</td><td>${l.vat_rate}</td><td>${money(l.line_total_gross)}</td></tr>`).join('')}</tbody></table>
   <div class="totals">Základ celkem: ${money(i.total_net)} Kč<br>DPH celkem: ${money(i.total_vat)} Kč<br>Zaokrouhlení: ${money(i.rounding_amount)} Kč
   <div class="total">Celkem s DPH: ${c.printedTotal||money(i.total_gross)} Kč</div>${c.advance?'Uhrazená záloha: '+money(c.advance)+' Kč<br>':''}<b>K úhradě: ${money(i.amount_due)} Kč</b></div>
   <footer>Všechny názvy, identifikátory a transakce jsou smyšlené. ${escape(c.title)}</footer></html>`;
   await page.setContent(html);await page.screenshot({path:path.join(__dirname,c.id+'.png'),fullPage:true});
  }
 }finally{await browser.close();}
})().catch(()=>{console.error('Fixture rendering failed.');process.exitCode=1;});
