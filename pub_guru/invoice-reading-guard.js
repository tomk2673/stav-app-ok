'use strict';
(function(){
 const $=id=>document.getElementById(id);
 const val=id=>$(id)?.value||'';
 const money=s=>{const x=String(s||'').match(/celkem\s*(?:\[\s*czk\s*\])?\s*:?\s*(-?\d[\d .]*[,.]\d{2})/ig)||[];if(!x.length)return null;const m=x[x.length-1].match(/(-?\d[\d .]*[,.]\d{2})/);return m?Number(m[1].replace(/\s/g,'').replace(/\.(?=\d{3})/g,'').replace(',','.')):null};
 function check(){
  const text=val('ocrText').trim(), rows=[...document.querySelectorAll('#lines .line')], issues=[];
  if(!text){render(['Doklad ještě nebyl přečten.'],false);return;}
  if(!val('supplier').trim())issues.push('chybí dodavatel');
  if(!val('number').trim())issues.push('chybí číslo dokladu');
  if(!val('date'))issues.push('chybí datum');
  if(!rows.length)issues.push('nebyla bezpečně přečtena žádná položka');
  const total=money(text);
  if(total===null)issues.push('nepodařilo se jednoznačně přečíst CELKEM');
  let uncertain=0;
  rows.forEach(r=>{const q=Number(r.querySelector('.qty')?.value),p=Number(r.querySelector('.price')?.value);if(!Number.isFinite(q)||q===0||!Number.isFinite(p)||p<0)uncertain++;});
  if(uncertain)issues.push(uncertain+' řádků nemá jisté množství/cenu');
  const rojal=/\bROJAL\b/i.test(text);
  if(rojal){
    const printed=(text.match(/\b[A-Z0-9]{2,3}-[A-Z0-9]{1,4}\b/g)||[]).length;
    if(printed>rows.length)issues.push('OCR vidí '+printed+' kódů zboží, ale parser vytvořil jen '+rows.length+' položek');
  }
  render(issues,issues.length===0);
 }
 function render(issues,ok){
  const box=$('invoiceReadGate'),txt=$('invoiceReadGateText'),submit=$('submitBtn');
  if(!box||!txt)return;
  txt.innerHTML=ok?'✓ Povinné údaje a všechny rozpoznané řádky prošly kontrolou. Doklad může pokračovat ke schválení.':'⚠ Doklad není kompletně přečten: '+issues.join('; ')+'. Nic nedoplňuji odhadem.';
  box.style.borderColor=ok?'':'#b36b00';
  if(submit){submit.disabled=!ok;submit.title=ok?'':'Nejdřív musí projít kontrola úplnosti čtení.';}
 }
 document.addEventListener('DOMContentLoaded',()=>{
   const target=$('lines'); if(target)new MutationObserver(check).observe(target,{childList:true,subtree:true,attributes:true});
   ['ocrText','supplier','number','date'].forEach(id=>$(id)?.addEventListener('input',check));
   setInterval(check,1200); check();
 });
})();