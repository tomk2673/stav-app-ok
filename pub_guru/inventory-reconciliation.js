'use strict';
(async function(){
 const status=document.querySelector('#status'),content=document.querySelector('#content');
 const esc=s=>String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
 const fmt=n=>n==null?'—':new Intl.NumberFormat('cs-CZ',{maximumFractionDigits:2}).format(Number(n));
 try{
  const ctx=await window.PubGuruBackend.loadContext();
  if(!['owner','manager'].includes(ctx?.role)){location.replace('start.html');return;}
  const {data:sessions,error}=await window.PubGuruBackend.client.from('inventory_sessions').select('id,started_at,closed_at,status').eq('organization_id',ctx.organization.id).eq('venue_id',ctx.venue.id).neq('status','open').order('closed_at',{ascending:false}).limit(20);
  if(error)throw error;
  if(!sessions?.length){status.textContent='Zatím není uzavřená slepá inventura.';return;}
  status.innerHTML='<label class="field">Inventura<select id="session">'+sessions.map(s=>'<option value="'+esc(s.id)+'">'+esc(new Date(s.closed_at||s.started_at).toLocaleString('cs-CZ'))+'</option>').join('')+'</select></label>';
  const load=async()=>{
   content.innerHTML='<section class="panel">Počítám reconciliation…</section>';
   const {data,error}=await window.PubGuruBackend.client.rpc('inventory_reconciliation',{p_session:document.querySelector('#session').value});
   if(error)throw error;
   const items=data?.items||[];
   const period=data?.periodStart?('Od poslední inventury '+new Date(data.periodStart).toLocaleString('cs-CZ')+' do '+new Date(data.periodEnd).toLocaleString('cs-CZ')):'První inventura bez předchozího fyzického snapshotu';
   content.innerHTML='<section class="panel"><h2>Skrytá variance</h2><p>'+esc(period)+'. Expected je ledger. Measured je slepé měření. Rozdíl se nepřičítá do skladu.</p><div class="table-wrap"><table><thead><tr><th>Produkt</th><th>Teorie</th><th>Fyzicky</th><th>Variance</th><th>Kontrola</th></tr></thead><tbody>'+items.map(i=>{
    const counted=i.unitMode==='counted',e=counted?i.expectedUnits:i.expectedMl,m=counted?i.measuredUnits:i.measuredMl,v=counted?i.varianceUnits:i.varianceMl,u=counted?' ks':' ml';
    const hints=[];
    if(i.pendingPosLines) hints.push('DŮKAZ: '+i.pendingPosLines+' čekajících POS odpisů obsahuje tuto skladovou položku');
    if(!i.movementCount) hints.push('DŮKAZ: produkt nemá žádný zaúčtovaný skladový pohyb');
    if(i.periodReceiptMl) hints.push('OBDOBÍ: příjem '+fmt(i.periodReceiptMl)+' ml');
    if(i.periodSaleMl) hints.push('OBDOBÍ: prodejní odpis '+fmt(i.periodSaleMl)+' ml');
    if(i.periodOtherMl) hints.push('OBDOBÍ: ostatní pohyby '+fmt(i.periodOtherMl)+' ml');
    if(i.movementCount && !i.pendingPosLines) hints.push('NEVYSVĚTLENO: ledger neukazuje zjevnou systémovou chybu');
    const verdict=i.pendingPosLines||!i.movementCount?'Vyžaduje kontrolu':'Nevysvětleno';
    return '<tr><td><strong>'+esc(i.name)+'</strong><br><small>'+esc(verdict)+'</small></td><td>'+fmt(e)+u+'</td><td>'+fmt(m)+u+'</td><td><strong>'+((Number(v)||0)>0?'+':'')+fmt(v)+u+'</strong></td><td>'+esc(hints.join(' · '))+'</td></tr>';
   }).join('')+'</tbody></table></div></section>';
  };
  document.querySelector('#session').onchange=()=>load().catch(show); await load();
 }catch(e){show(e);}
 function show(e){console.error(e);status.textContent='Kontrolu inventury se nepodařilo načíst: '+e.message;}
})();