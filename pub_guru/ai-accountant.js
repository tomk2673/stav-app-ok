'use strict';
(function(){
  const $=id=>document.getElementById(id);
  const esc=v=>String(v??'').replace(/[&<>'"]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;',"'":'&#39;','"':'&quot;'}[c]));
  const n=v=>{const x=Number(String(v??'').replace(/\s/g,'').replace(',','.'));return Number.isFinite(x)?x:0};
  const money=v=>new Intl.NumberFormat('cs-CZ',{style:'currency',currency:'CZK',maximumFractionDigits:2}).format(n(v));
  function analyse(){
    const lines=[...document.querySelectorAll('#lines .review-line')];
    const gross=n($('totalGross')?.value);
    const review=window.PubGuruInvoiceReview?.check?.();
    let calc=0,unmatched=0,missingPrice=0,badQty=0;
    lines.forEach(row=>{
      const qty=n(row.querySelector('.qty, .line-qty')?.value);
      const price=n(row.querySelector('.gross, .price, .line-price')?.value);
      const product=row.querySelector('.pid, .productId, .line-product')?.value;
      const ignored=row.querySelector('.status')?.value==='ignored';
      calc+=qty*price;
      if(ignored)return;
      if(!product)unmatched++;
      if(!price)missingPrice++;
      if(!qty)badQty++;
    });
    const diff=gross?Math.abs(calc-gross):0;
    const issues=review?[...review.issues]:[];
    if(!review){
    if(unmatched)issues.push(unmatched+' položek není spárováno se skladem');
    if(missingPrice)issues.push(missingPrice+' položek nemá cenu');
    if(badQty)issues.push(badQty+' položek nemá množství');
    if(gross&&calc&&diff>Math.max(2,gross*0.015))issues.push('součet položek se liší od faktury o '+money(diff));
    }
    const summary=$('accountantSummary'),box=$('accountantChecks');
    if(summary)summary.textContent=issues.length?'AI účetní našel '+issues.length+' věcí ke kontrole.':'AI účetní: doklad je účetně konzistentní podle dostupných dat.';
    if(box)box.innerHTML='<strong>AI účetní</strong><div class="line-note" style="margin-top:8px">'+
      (issues.length?issues.map(x=>'⚠ '+esc(x)).join('<br>'):'✓ Součet, množství, ceny a párování nevykazují zjevnou chybu.')+
      '</div><div class="line-note" style="margin-top:8px">Kontroluje také duplicity a historii nákupních cen v PUB GURU. Neprovádí účetní ani daňové zaúčtování bez schválení člověkem.</div>';
  }
  const obs=new MutationObserver(analyse);
  document.addEventListener('DOMContentLoaded',()=>{const lines=$('lines');if(lines)obs.observe(lines,{childList:true,subtree:true,attributes:true});['totalGross','lines','supplier','number','date'].forEach(id=>{const el=$(id);el?.addEventListener('input',analyse);el?.addEventListener('change',analyse)});setTimeout(analyse,500);});
})();
