'use strict';
(async function(){
 const chat=document.querySelector('#chat'),form=document.querySelector('#ask'),q=document.querySelector('#question');
 const esc=s=>String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
 const norm=s=>String(s||'').toLocaleLowerCase('cs').normalize('NFD').replace(/[\u0300-\u036f]/g,'');
 const fmt=n=>new Intl.NumberFormat('cs-CZ',{maximumFractionDigits:2}).format(Number(n)||0);
 let ctx,snapshot=null;
 try{ctx=await PubGuruBackend.loadContext();if(!['owner','manager'].includes(ctx?.role)){location.replace('start.html');return;}
  const {data:sessions,error}=await PubGuruBackend.client.from('inventory_sessions').select('id,closed_at').eq('organization_id',ctx.organization.id).eq('venue_id',ctx.venue.id).neq('status','open').order('closed_at',{ascending:false}).limit(1);if(error)throw error;
  if(sessions?.[0]){const r=await PubGuruBackend.client.rpc('inventory_reconciliation',{p_session:sessions[0].id});if(r.error)throw r.error;snapshot=r.data;}
  chat.innerHTML='<div class="panel"><strong>Připraveno.</strong> Můžu vysvětlit poslední uzavřenou inventuru podle ledgeru, POS a fyzického měření.</div>';
 }catch(e){chat.textContent='AI účetní nemůže načíst podklady: '+e.message;form.hidden=true;return;}
 form.onsubmit=e=>{e.preventDefault();const question=q.value.trim();if(!question)return;answer(question);};
 function answer(question){
  const items=snapshot?.items||[],needle=norm(question),named=items.filter(i=>needle.includes(norm(i.name))||norm(i.name).split(/\s+/).some(w=>w.length>4&&needle.includes(w)));
  let pool=named.length?named:items.filter(i=>Math.abs(Number(i.varianceMl||i.varianceUnits||0))>0);
  if(!snapshot){render(question,'Nemám ještě uzavřenou slepou inventuru, takže bych odpověď musel hádat.');return;}
  if(!pool.length){render(question,'V poslední inventuře jsem nenašel odpovídající rozdíl. Nechci si příčinu domýšlet.');return;}
  const lines=pool.slice(0,8).map(i=>{const counted=i.unitMode==='counted',v=counted?i.varianceUnits:i.varianceMl,u=counted?' ks':' ml';const evidence=[];if(i.pendingPosLines)evidence.push(i.pendingPosLines+' čekajících POS odpisů');if(!i.movementCount)evidence.push('žádný skladový pohyb');if(i.periodReceiptMl)evidence.push('příjem '+fmt(i.periodReceiptMl)+' ml');if(i.periodSaleMl)evidence.push('prodejní odpis '+fmt(i.periodSaleMl)+' ml');return i.name+': variance '+(Number(v)>0?'+':'')+fmt(v)+u+'. '+(evidence.length?'Důkazy: '+evidence.join(', ')+'.':'Příčina zatím není doložená.');});
  render(question,lines.join('\n'));
 }
 function render(question,answer){chat.insertAdjacentHTML('beforeend','<div class="panel"><strong>Ty:</strong> '+esc(question)+'</div><div class="panel"><strong>AI účetní:</strong><pre style="white-space:pre-wrap">'+esc(answer)+'</pre><small>Read-only · žádná skladová korekce nebyla provedena.</small></div>');q.value='';}
})();