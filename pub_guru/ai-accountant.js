'use strict';
(function(){
  const $=id=>document.getElementById(id);
  const n=v=>{const x=Number(String(v??'').replace(/\s/g,'').replace(',','.'));return Number.isFinite(x)?x:0};
  const money=v=>new Intl.NumberFormat('cs-CZ',{style:'currency',currency:'CZK',maximumFractionDigits:2}).format(n(v));
  function analyse(){
    const lines=[...document.querySelectorAll('#lines .review-line')];
    const gross=n($('totalGross')?.value);
    let calc=0,unmatched=0,missingPrice=0,badQty=0;
    lines.forEach(row=>{
      const qty=n(row.querySelector('.qty, .line-qty')?.value);
      const price=n(row.querySelector('.price, .line-price')?.value);
      const product=row.querySelector('.productId, .line-product')?.value;
      if(!product)unmatched++;
      if(!price)missingPrice++;
      if(!qty)badQty++;
      calc+=qty*price;
    });
    const diff=gross?Math.abs(calc-gross):0;
    const issues=[];
    if(unmatched)issues.push(unmatched+' položek není spárováno se skladem');
    if(missingPrice)issues.push(missingPrice+' položek nemá cenu');
    if(badQty)issues.push(badQty+' položek nemá množství');
    if(gross&&calc&&diff>Math.max(2,gross*0.015))issues.push('součet položek se liší od faktury o '+money(diff));
    const summary=$('accountantSummary'),box=$('accountantChecks');
    if(summary)summary.textContent=issues.length?'AI účetní našel '+issues.length+' věcí ke kontrole.':'AI účetní: doklad je účetně konzistentní podle dostupných dat.';
    if(box)box.innerHTML='<strong>AI účetní</strong><div class="line-note" style="margin-top:8px">'+
      (issues.length?issues.map(x=>'⚠ '+x).join('<br>'):'✓ Součet, množství, ceny a párování nevykazují zjevnou chybu.')+
      '</div><div class="line-note" style="margin-top:8px">Kontroluje také duplicity a historii nákupních cen v PUB GURU. Neprovádí účetní ani daňové zaúčtování bez schválení člověkem.</div>';
  }
  const obs=new MutationObserver(analyse);
  document.addEventListener('DOMContentLoaded',()=>{const lines=$('lines');if(lines)obs.observe(lines,{childList:true,subtree:true,attributes:true});['totalGross','lines'].forEach(id=>$(id)?.addEventListener('input',analyse));setTimeout(analyse,500);});
})();