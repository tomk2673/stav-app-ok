'use strict';
(function(){
  const $=id=>document.getElementById(id);
  const REQUIRED={
    supplier_name:'Dodavatel',invoice_number:'Číslo faktury',issue_date:'Datum vystavení',
    taxable_date:'Datum zdanitelného plnění',due_date:'Splatnost',variable_symbol:'Variabilní symbol',
    payment_method:'Způsob úhrady',currency:'Měna',total_net:'Celkem bez DPH',
    total_vat:'DPH celkem',total_gross:'Celkem s DPH',items_region:'Oblast položek'
  };
  const LINE={
    source_code:'Kód položky',item_name:'Název položky',quantity:'Množství',unit:'Jednotka',
    vat_rate:'Sazba DPH',unit_price_net:'Cena/ks bez DPH',unit_price_gross:'Cena/ks s DPH',
    line_total_net:'Řádek bez DPH',line_total_gross:'Řádek s DPH'
  };
  let ctx=null,profiles=[],active=null,sampleFile=null,annotations=[],baseCanvas=null,drag=null;

  const db=()=>window.PubGuruBackend.client;
  const toast=(m,ms=4200)=>{const e=$('toast');e.textContent=m;e.classList.remove('hidden');clearTimeout(toast.t);toast.t=setTimeout(()=>e.classList.add('hidden'),ms)};
  const esc=v=>String(v??'').replace(/[&<>'"]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;',"'":'&#39;','"':'&quot;'}[c]));
  const key=v=>String(v||'').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g,'').replace(/[^a-z0-9]+/g,'-').replace(/^-|-$/g,'').slice(0,80);

  function checks(el,map,selected){
    const set=new Set(selected||[]);
    el.innerHTML=Object.entries(map).map(([k,label])=>`<label class="check"><input type="checkbox" value="${k}" ${set.has(k)?'checked':''}> ${esc(label)}</label>`).join('');
  }
  function selected(id){return [...$(id).querySelectorAll('input:checked')].map(x=>x.value)}
  function annotationOptions(){
    $('annotationField').innerHTML=Object.entries(REQUIRED).map(([k,v])=>`<option value="${k}">${esc(v)}</option>`).join('');
  }

  async function loadProfiles(){
    const q=await db().from('supplier_document_profiles').select('*').eq('organization_id',ctx.organization.id).order('supplier_name');
    if(q.error)throw q.error; profiles=q.data||[]; renderProfiles();
  }
  function renderProfiles(){
    $('profileList').innerHTML=profiles.length?profiles.map(p=>`<button class="profile-btn ${active?.id===p.id?'active':''}" data-id="${p.id}"><strong>${esc(p.supplier_name)}</strong><small>${esc(p.supplier_key)}</small></button>`).join(''):'<div class="empty-state">Zatím žádný profil.</div>';
    $('profileList').querySelectorAll('.profile-btn').forEach(b=>b.onclick=()=>openProfile(profiles.find(p=>p.id===b.dataset.id)));
  }
  async function openProfile(profile){
    active=profile;$('emptyState').classList.add('hidden');$('editor').classList.remove('hidden');
    $('supplierName').value=profile.supplier_name||'';$('supplierKey').value=profile.supplier_key||'';
    $('profileTitle').textContent=profile.supplier_name||'Profil dodavatele';
    checks($('requiredFields'),REQUIRED,profile.required_fields);
    checks($('lineFields'),LINE,profile.line_fields);
    sampleFile=null;annotations=[];$('annotationTools').classList.add('hidden');
    await loadSamples();renderProfiles();
  }
  function newProfile(){
    active={id:null,supplier_name:'',supplier_key:'',required_fields:['supplier_name','invoice_number','issue_date','total_gross','items_region'],line_fields:['source_code','item_name','quantity','unit','vat_rate','unit_price_gross','line_total_gross']};
    $('emptyState').classList.add('hidden');$('editor').classList.remove('hidden');$('supplierName').value='';$('supplierKey').value='';
    $('profileTitle').textContent='Nový dodavatel';checks($('requiredFields'),REQUIRED,active.required_fields);checks($('lineFields'),LINE,active.line_fields);
    $('sampleList').innerHTML='';$('sampleCount').textContent='0 vzorů';renderProfiles();
  }
  async function saveProfile(){
    const name=$('supplierName').value.trim();if(!name)return toast('Doplň název dodavatele.');
    const supplierKey=active?.supplier_key||key(name);if(!supplierKey)return toast('Název dodavatele nejde použít jako klíč.');
    const payload={organization_id:ctx.organization.id,supplier_key:supplierKey,supplier_name:name,required_fields:selected('requiredFields'),line_fields:selected('lineFields'),updated_at:new Date().toISOString()};
    let result;
    if(active?.id) result=await db().from('supplier_document_profiles').update(payload).eq('id',active.id).select('*').single();
    else result=await db().from('supplier_document_profiles').insert({...payload,created_by:ctx.user.id}).select('*').single();
    if(result.error)throw result.error;
    active=result.data;$('supplierKey').value=active.supplier_key;$('profileTitle').textContent=active.supplier_name;
    await loadProfiles();toast('Profil dodavatele uložen.');
  }

  async function loadSamples(){
    if(!active?.id)return;
    const q=await db().from('supplier_document_samples').select('id,source_file_name,annotations,created_at').eq('profile_id',active.id).order('created_at',{ascending:false});
    if(q.error)throw q.error;
    $('sampleCount').textContent=`${q.data?.length||0} vzorů`;
    $('sampleList').innerHTML=q.data?.length?q.data.map(s=>`<div class="item-row"><div><strong>${esc(s.source_file_name||'Vzor')}</strong><div class="meta">${new Date(s.created_at).toLocaleString('cs-CZ')} · ${Array.isArray(s.annotations)?s.annotations.length:0} značek</div></div></div>`).join(''):'<div class="empty-state">Žádný vzor. Pro stabilní profil použij 2–3 různé faktury stejného dodavatele.</div>';
  }

  async function sha256(file){const h=await crypto.subtle.digest('SHA-256',await file.arrayBuffer());return [...new Uint8Array(h)].map(b=>b.toString(16).padStart(2,'0')).join('')}
  function safeName(name){return String(name||'sample').replace(/[^a-zA-Z0-9._-]+/g,'_').slice(-100)}

  async function renderFile(file){
    sampleFile=file;annotations=[];baseCanvas=document.createElement('canvas');
    if(file.type==='application/pdf'){
      pdfjsLib.GlobalWorkerOptions.workerSrc='https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js';
      const pdf=await pdfjsLib.getDocument({data:await file.arrayBuffer()}).promise;
      const page=await pdf.getPage(1),vp=page.getViewport({scale:2});
      baseCanvas.width=vp.width;baseCanvas.height=vp.height;
      await page.render({canvasContext:baseCanvas.getContext('2d'),viewport:vp}).promise;
    }else{
      const img=new Image(),url=URL.createObjectURL(file);img.src=url;await img.decode();
      const scale=Math.min(1,1800/img.naturalWidth);
      baseCanvas.width=Math.max(1,Math.round(img.naturalWidth*scale));baseCanvas.height=Math.max(1,Math.round(img.naturalHeight*scale));
      baseCanvas.getContext('2d').drawImage(img,0,0,baseCanvas.width,baseCanvas.height);URL.revokeObjectURL(url);
    }
    const c=$('sampleCanvas');c.width=baseCanvas.width;c.height=baseCanvas.height;
    $('annotationTools').classList.remove('hidden');redraw();renderAnnotations();
  }
  function redraw(temp=null){
    const c=$('sampleCanvas');if(!baseCanvas||!c)return;
    const g=c.getContext('2d');g.clearRect(0,0,c.width,c.height);g.drawImage(baseCanvas,0,0);
    const draw=a=>{g.lineWidth=Math.max(3,c.width/500);g.strokeStyle='#ffb400';g.fillStyle='rgba(255,180,0,.12)';g.strokeRect(a.x*c.width,a.y*c.height,a.w*c.width,a.h*c.height);g.fillRect(a.x*c.width,a.y*c.height,a.w*c.width,a.h*c.height)};
    annotations.forEach(draw);if(temp)draw(temp);
  }
  function point(e){const c=$('sampleCanvas'),r=c.getBoundingClientRect();return{x:Math.max(0,Math.min(1,(e.clientX-r.left)/r.width)),y:Math.max(0,Math.min(1,(e.clientY-r.top)/r.height))}}
  function start(e){if(!baseCanvas)return;const p=point(e);drag={x:p.x,y:p.y};$('sampleCanvas').setPointerCapture?.(e.pointerId)}
  function move(e){if(!drag)return;const p=point(e),a={x:Math.min(drag.x,p.x),y:Math.min(drag.y,p.y),w:Math.abs(p.x-drag.x),h:Math.abs(p.y-drag.y)};redraw(a)}
  function end(e){
    if(!drag)return;const p=point(e),a={field:$('annotationField').value,page:1,x:Math.min(drag.x,p.x),y:Math.min(drag.y,p.y),w:Math.abs(p.x-drag.x),h:Math.abs(p.y-drag.y)};drag=null;
    if(a.w>.01&&a.h>.005)annotations.push(a);redraw();renderAnnotations();
  }
  function renderAnnotations(){
    $('annotationList').innerHTML=annotations.length?annotations.map((a,i)=>`<div class="annotation-row"><span><strong>${esc(REQUIRED[a.field]||a.field)}</strong> · oblast ${i+1}</span><button class="icon-btn" data-i="${i}">×</button></div>`).join(''):'<div class="hint">Zatím žádné značky. Označení není pevná šablona souřadnic, jen učící nápověda pro rozložení tohoto dodavatele.</div>';
    $('annotationList').querySelectorAll('button[data-i]').forEach(b=>b.onclick=()=>{annotations.splice(Number(b.dataset.i),1);redraw();renderAnnotations()});
  }
  async function saveSample(){
    if(!active?.id)return toast('Nejdřív ulož profil dodavatele.');
    if(!sampleFile)return toast('Vyber vzorovou fakturu.');
    if(!annotations.length)return toast('Označ alespoň jednu důležitou oblast.');
    const fingerprint=await sha256(sampleFile);
    const dupe=await db().from('supplier_document_samples').select('id').eq('organization_id',ctx.organization.id).eq('source_fingerprint',fingerprint).maybeSingle();
    if(dupe.error)throw dupe.error;if(dupe.data)return toast('Tento vzor už je uložen.');
    const path=`${ctx.organization.id}/${ctx.venue.id}/${ctx.user.id}/supplier-training/${active.id}/${Date.now()}-${safeName(sampleFile.name)}`;
    const up=await db().storage.from('invoice-sources').upload(path,sampleFile,{contentType:sampleFile.type||'application/octet-stream',upsert:false});
    if(up.error)throw up.error;
    const ins=await db().from('supplier_document_samples').insert({
      profile_id:active.id,organization_id:ctx.organization.id,venue_id:ctx.venue.id,source_path:path,
      source_file_name:sampleFile.name||'sample',source_fingerprint:fingerprint,mime_type:sampleFile.type||null,
      page_count:sampleFile.type==='application/pdf'?null:1,annotations,confirmed:true,created_by:ctx.user.id
    });
    if(ins.error)throw ins.error;
    sampleFile=null;annotations=[];$('sampleFile').value='';$('annotationTools').classList.add('hidden');await loadSamples();toast('Vzor uložen do učící sady.');
  }

  async function init(){
    ctx=await window.PubGuruBackend.loadContext();
    if(!ctx?.user||!ctx?.organization||!ctx?.venue){location.replace('start.html');return}
    if(!['owner','manager'].includes(ctx.role)){location.replace('start.html');return}
    annotationOptions();checks($('requiredFields'),REQUIRED,[]);checks($('lineFields'),LINE,[]);
    $('newProfileBtn').onclick=newProfile;
    $('supplierName').oninput=e=>{if(active&&!active.id){active.supplier_key=key(e.target.value);$('supplierKey').value=active.supplier_key}};
    $('saveProfileBtn').onclick=()=>saveProfile().catch(e=>{console.error(e);toast(`Uložení profilu selhalo: ${e.message}`,6500)});
    $('sampleFile').onchange=e=>{const f=e.target.files?.[0];if(f)renderFile(f).catch(err=>{console.error(err);toast(`Náhled selhal: ${err.message}`,6500)})};
    const c=$('sampleCanvas');c.addEventListener('pointerdown',start);c.addEventListener('pointermove',move);c.addEventListener('pointerup',end);c.addEventListener('pointercancel',()=>{drag=null;redraw()});
    $('clearAnnotationsBtn').onclick=()=>{annotations=[];redraw();renderAnnotations()};
    $('saveSampleBtn').onclick=()=>saveSample().catch(e=>{console.error(e);toast(`Uložení vzoru selhalo: ${e.message}`,7000)});
    await loadProfiles();
  }
  document.addEventListener('DOMContentLoaded',()=>init().catch(e=>{console.error(e);toast(`Modul dodavatelů nelze spustit: ${e.message}`,7000)}));
})();