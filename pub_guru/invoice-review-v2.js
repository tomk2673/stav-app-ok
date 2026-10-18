'use strict';
(function(){
let ctx=null,products=[],currentInvoice=null,currentLines=[],posting=false;
const db=()=>PubGuruBackend.client,$=id=>document.getElementById(id);
const esc=v=>String(v??'').replace(/[&<>'"]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;',"'":'&#39;','"':'&quot;'}[c]));
const {parseQuantity,parseMoney}=window.PubGuruInvoiceNumbers;
const n=v=>{const x=parseQuantity(v);return Number.isFinite(x)?x:0};
const round2=v=>Math.sign(v)*Math.round((Math.abs(v)+Number.EPSILON)*100)/100;
const money=v=>new Intl.NumberFormat('cs-CZ',{style:'currency',currency:'CZK',maximumFractionDigits:2}).format(n(v));
const netFromGross=(gross,vat)=>round2(n(gross)/(1+n(vat)/100));
function toast(m,ms=4500){const e=$('toast');e.textContent=m;e.classList.remove('hidden');clearTimeout(toast.t);toast.t=setTimeout(()=>e.classList.add('hidden'),ms)}
function slug(s){return String(s||'produkt').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g,'').replace(/[^a-z0-9]+/g,'_').replace(/^_|_$/g,'').slice(0,48)||'produkt'}
function normalize(s){return String(s||'').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g,'').replace(/[^a-z0-9]+/g,' ').trim()}
function supplierKey(s){const v=normalize(s);if(v.includes('rojal'))return'rojal';return v.replace(/\s+/g,'_').slice(0,80)||'unknown'}
async function role(){ctx=await PubGuruBackend.loadContext();if(!ctx?.user||!ctx?.organization||!ctx?.venue){location.replace('start.html');return false}if(!['owner','manager'].includes(ctx.role)){location.replace('start.html');return false}$('roleBadge').textContent=ctx.role==='owner'?'Majitel':'Vedoucí';return true}
async function loadProducts(){const r=await db().from('products').select('id,client_key,name,ean,volume_ml,unit_mode,current_purchase_price,current_purchase_price_gross,aliases').eq('organization_id',ctx.organization.id).is('archived_at',null).order('name');if(r.error)throw r.error;products=r.data||[]}
function options(selected){return '<option value="">Vyber produkt…</option><option value="__new__">＋ Vytvořit nový produkt z tohoto řádku</option>'+products.map(p=>`<option value="${p.id}" ${p.id===selected?'selected':''}>${esc(p.name)}${p.ean?` · ${esc(p.ean)}`:''}${p.volume_ml?` · ${n(p.volume_ml)} ml`:''}</option>`).join('')}
async function queue(){const r=await db().from('invoices').select('id,supplier_name,invoice_number,issue_date,total_amount,total_amount_gross,status,created_at,payment_status,payment_method').eq('organization_id',ctx.organization.id).eq('venue_id',ctx.venue.id).in('status',['review','approved']).order('created_at',{ascending:false}).limit(100);if(r.error)throw r.error;$('queueCount').textContent=String(r.data?.length||0);$('queue').innerHTML=r.data?.length?r.data.map(i=>`<button class="queue-item" data-id="${i.id}"><strong>${esc(i.supplier_name||'Bez dodavatele')}</strong><small>${esc(i.invoice_number||'bez čísla')} · ${money(i.total_amount_gross??i.total_amount??0)}${i.payment_status==='paid'?` · ${i.payment_method==='card'?'kartou':'hotově'}`:''}</small></button>`).join(''):'<div class="empty">Žádná faktura nečeká.</div>';document.querySelectorAll('.queue-item').forEach(b=>b.onclick=()=>openInvoice(b.dataset.id))}
async function openInvoice(id){
  if(posting)return;
  const[ir,lr]=await Promise.all([
    db().from('invoices').select('id,supplier_name,invoice_number,issue_date,total_amount,total_amount_gross,status,raw_extraction,payment_status,payment_method,paid_at').eq('id',id).eq('organization_id',ctx.organization.id).eq('venue_id',ctx.venue.id).single(),
    db().from('invoice_lines').select('id,raw_name,product_id,quantity,unit_price,unit_price_net,unit_price_gross,vat_rate,line_total,line_total_net,line_total_gross,status,original_values').eq('invoice_id',id).eq('organization_id',ctx.organization.id).order('created_at')
  ]);
  if(ir.error)throw ir.error;if(lr.error)throw lr.error;
  currentInvoice=ir.data;currentLines=lr.data||[];
  $('supplier').value=currentInvoice.supplier_name||'';$('number').value=currentInvoice.invoice_number||'';
  $('date').value=currentInvoice.issue_date||'';$('invoiceStatus').textContent=currentInvoice.status;
  $('rawOcr').textContent=currentInvoice.raw_extraction?.raw_text||'';
  const total=parseMoney(currentInvoice.total_amount_gross??currentInvoice.total_amount);
  $('totalGross').value=Number.isFinite(total)?total:'';
  const pm=currentInvoice.payment_status==='paid'?(currentInvoice.payment_method==='card'?'card':'cash'):(currentInvoice.payment_status==='unpaid'?'unpaid':'unknown');
  $('paymentMode').value=pm;$('paidDate').value=currentInvoice.paid_at?String(currentInvoice.paid_at).slice(0,10):(currentInvoice.issue_date||'');
  syncPaidDate();$('editor').classList.remove('hidden');$('emptyEditor').classList.add('hidden');render();
}
function detectedVolume(text){const ml=String(text||'').match(/(\d{2,4})\s*ml\b/i);if(ml)return n(ml[1]);const l=String(text||'').match(/(\d+(?:[.,]\d+)?)\s*l\b/i);return l?n(l[1])*1000:0}
function vatForLine(l){const v=parseQuantity(l.vat_rate??l.original_values?.ocr_vat_rate);return [0,12,21].includes(v)?v:null}
function grossForLine(l){
  for(const value of [l.unit_price_gross,l.original_values?.ocr_unit_gross]){const x=parseMoney(value);if(Number.isFinite(x))return x;}
  const vat=vatForLine(l),net=parseMoney(l.unit_price_net??l.unit_price);
  return Number.isFinite(net)&&vat!==null?round2(net*(1+vat/100)):NaN;
}
function printedLineGross(l){
  for(const value of [l.line_total_gross,l.original_values?.ocr_line_gross]){const x=parseMoney(value);if(Number.isFinite(x))return x;}
  return NaN;
}
const fieldValue=v=>Number.isFinite(v)?v:'';
function render(){
  $('lines').innerHTML=currentLines.length?currentLines.map((l,i)=>{
    const p=products.find(x=>x.id===l.product_id),vol=p?.volume_ml||detectedVolume(l.raw_name),code=l.original_values?.source_code||'',vat=vatForLine(l),gross=grossForLine(l);
    const warning=l.original_values?.parser_warning||'';
    return `<div class="review-line" data-i="${i}"><label class="raw">Text<input class="rawname" value="${esc(l.raw_name)}" readonly>${code?`<small class="line-note">kód dodavatele ${esc(code)}</small>`:''}${warning?`<small class="line-note">⚠ ${esc(warning)}</small>`:''}</label><label class="product">Produkt<select class="pid">${options(l.product_id)}</select></label><label>Ks<input class="qty" type="text" inputmode="decimal" value="${esc(l.quantity??'')}"></label><label>Cena/ks s DPH<input class="gross" type="text" inputmode="decimal" value="${fieldValue(gross)}"><small class="net-preview"></small></label><label>DPH<select class="vat"><option value="" ${vat===null?'selected':''}>Doplň DPH…</option><option value="0" ${vat===0?'selected':''}>0 %</option><option value="12" ${vat===12?'selected':''}>12 %</option><option value="21" ${vat===21?'selected':''}>21 %</option></select></label><label>Objem ml<input class="vol" type="number" min="1" step="1" value="${vol||''}"></label><label>Akce<select class="status"><option value="approved">Schválit</option><option value="ignored" ${l.status==='ignored'?'selected':''}>Bez skladu (obal/služba/sleva)</option></select></label><label class="line-total">Řádek celkem s DPH<input class="linegross" type="text" inputmode="decimal" value="${fieldValue(printedLineGross(l))}" placeholder="Automaticky ks × cena"><small class="adjustment-preview"></small></label><button class="recalculate" type="button">Přepočítat z ks × ceny</button>`+
      `</div>`;
  }).join(''):'<div class="empty">Faktura nemá žádné řádky.</div>';
  document.querySelectorAll('.review-line').forEach(e=>{
    const update=()=>{
      const row=readRow(e,Number(e.dataset.i));
      e.querySelector('.net-preview').textContent=row.vat===null?'Doplň sazbu DPH':Number.isFinite(row.net)?`bez DPH ${money(row.net)}`:'Doplň cenu';
      e.querySelector('.adjustment-preview').textContent=Number.isFinite(row.lineGross)?
        `Úprava řádku ${money(row.adjustmentGross)}${Number.isFinite(row.costGross)?` · náklad/ks ${money(row.costGross)}`:''}`:'Doplň cenu řádku';
    };
    for(const selector of ['.qty','.gross','.linegross'])e.querySelector(selector).oninput=update;
    e.querySelector('.vat').onchange=update;
    e.querySelector('.recalculate').onclick=()=>{e.querySelector('.linegross').value='';e.querySelector('.linegross').dispatchEvent(new Event('input',{bubbles:true}));};
    update();
  });
}
function readRow(e,i){
  const original=currentLines[i],gross=parseMoney(e.querySelector('.gross').value),vat=vatForLine({vat_rate:e.querySelector('.vat').value}),qty=parseQuantity(e.querySelector('.qty').value);
  const sameVat=vat===vatForLine(original),originalNet=parseMoney(original.unit_price_net??original.unit_price);
  const net=vat===null||!Number.isFinite(gross)?null:
    sameVat&&gross===grossForLine(original)&&Number.isFinite(originalNet)?originalNet:netFromGross(gross,vat);
  const lineText=e.querySelector('.linegross').value.trim(),calculated=round2(qty*gross);
  const lineGross=lineText?parseMoney(lineText):calculated;
  const savedNet=parseMoney(original.line_total_net??original.line_total);
  const lineNet=vat===null||!Number.isFinite(lineGross)?null:
    sameVat&&lineGross===printedLineGross(original)&&Number.isFinite(savedNet)?savedNet:netFromGross(lineGross,vat);
  return {id:original.id,raw:original.raw_name,sourceCode:original.original_values?.source_code||'',pid:e.querySelector('.pid').value,
    qty,gross,vat,net,lineGross,lineNet,adjustmentGross:Number.isFinite(calculated)?round2(lineGross-calculated):lineGross,
    costGross:qty?lineGross/qty:null,costNet:qty&&lineNet!==null?lineNet/qty:null,
    vol:parseQuantity(e.querySelector('.vol').value),status:e.querySelector('.status').value};
}
function readRows(){return currentInvoice?[...document.querySelectorAll('.review-line')].map(readRow):[]}
function reviewCheck(){
  const rs=readRows(),approved=rs.filter(r=>r.status==='approved'),totalGross=parseMoney($('totalGross').value),issues=[];
  const source=currentInvoice?.raw_extraction?.crop?.invoice;
  if(source){
    if(source.currency!=='CZK')issues.push('AI doklad nemá potvrzenou měnu CZK. Cizí nebo neznámou měnu nelze zaúčtovat jako koruny.');
    if(source.document_type==='other')issues.push('Dokument nebyl rozpoznán jako faktura, účtenka nebo dobropis.');
    if(source.document_type==='credit_note'&&(!Number.isFinite(totalGross)||totalGross>=0))issues.push('Dobropis musí mít zápornou celkovou částku a vratky se záporným množstvím.');
  }
  if(!approved.length)issues.push('Schval alespoň jednu položku.');
  if(!$('supplier').value.trim())issues.push('Doplň dodavatele.');
  if(!$('number').value.trim())issues.push('Doplň číslo faktury.');
  if(!$('date').value)issues.push('Doplň datum dokladu.');
  for(const r of approved){
    if(!r.pid)issues.push(`Vyber produkt nebo „Vytvořit nový“: ${r.raw}`);
    if(!Number.isFinite(r.qty)||r.qty===0)issues.push(`Doplň množství: ${r.raw}`);
    if(!Number.isFinite(r.gross)||r.gross<0)issues.push(`Doplň nezápornou jednotkovou cenu s DPH: ${r.raw}`);
    if(Number.isFinite(r.lineGross)&&r.qty*r.lineGross<0)issues.push(`Vratka musí mít záporné množství i cenu řádku: ${r.raw}`);
    if(r.qty<0&&r.pid==='__new__')issues.push(`Vratku přiřaď k existujícímu produktu: ${r.raw}`);
    const product=products.find(p=>p.id===r.pid);
    if(product?.unit_mode!=='counted'&&(!Number.isFinite(r.vol)||r.vol<=0))issues.push(`Doplň objem balení v ml: ${r.raw}. Bez něj nelze bezpečně naskladnit.`);
  }
  for(const r of rs){
    if(!Number.isFinite(r.lineGross))issues.push(`Doplň výslednou cenu řádku: ${r.raw}`);
    if(r.vat===null)issues.push(`Doplň sazbu DPH: ${r.raw}`);
    if(r.lineNet!==null&&Math.abs(round2(r.lineNet*(1+r.vat/100))-r.lineGross)>0.02)issues.push(`Základ a DPH nesedí s cenou řádku: ${r.raw}`);
  }
  if(!Number.isFinite(totalGross))issues.push('Doplň konečnou cenu faktury s DPH.');
  // Ignored deposit/service rows still belong to the financial document total.
  const calculatedGross=round2(rs.reduce((sum,r)=>sum+r.lineGross,0));
  const difference=round2(calculatedGross-totalGross);
  if(Number.isFinite(totalGross)&&Number.isFinite(calculatedGross)&&Math.abs(difference)>Math.max(1,rs.length*0.02))issues.push(`Součet položek ${money(calculatedGross)} nesedí s fakturou ${money(totalGross)}. Rozdíl ${money(Math.abs(difference))}. Zkontroluj výsledné ceny řádků včetně obalů.`);
  const totalNet=round2(rs.reduce((sum,r)=>sum+(r.lineNet??0),0));
  return {rows:rs,approved,totalGross,totalNet,vatTotal:round2(calculatedGross-totalNet),calculatedGross,difference,issues};
}
window.PubGuruInvoiceReview={check:reviewCheck};
async function createProduct(row){const key=`inv_${slug(row.raw)}_${crypto.randomUUID().slice(0,8)}`;const r=await db().from('products').insert({organization_id:ctx.organization.id,client_key:key,name:row.raw.trim()||'Nový produkt',volume_ml:row.vol||null,current_purchase_price:row.costNet,current_purchase_price_gross:row.costGross,calibration_status:'missing',aliases:[row.raw.trim()].filter(Boolean),updated_at:new Date().toISOString()}).select('id,client_key,name,volume_ml,current_purchase_price,current_purchase_price_gross,aliases').single();if(r.error)throw r.error;products.push(r.data);const a=await db().from('audit_events').insert({organization_id:ctx.organization.id,venue_id:ctx.venue.id,actor_user_id:ctx.user.id,event_type:'product.created_from_invoice',entity_type:'product',entity_id:r.data.id,after_data:{name:r.data.name,source_invoice:currentInvoice.id,volume_ml:row.vol}});if(a.error)throw a.error;return r.data.id}
async function history(lineId,productId,row){const q=await db().from('purchase_price_history').select('id').eq('invoice_line_id',lineId).maybeSingle();if(q.error)throw q.error;if(!q.data){const x=await db().from('purchase_price_history').insert({organization_id:ctx.organization.id,venue_id:ctx.venue.id,product_id:productId,invoice_line_id:lineId,unit_price:row.costNet,unit_price_net:row.costNet,unit_price_gross:row.costGross,vat_rate:row.vat});if(x.error)throw x.error}}
async function learnProduct(row){
  const p=products.find(x=>x.id===row.pid);if(!p)return;
  const aliases=[...new Set([...(Array.isArray(p.aliases)?p.aliases:[]),row.raw.trim()].filter(Boolean))];
  const changes={volume_ml:row.vol||p.volume_ml||null,aliases,updated_at:new Date().toISOString()};
  if(row.qty>0){changes.current_purchase_price=row.costNet;changes.current_purchase_price_gross=row.costGross;}
  const u=await db().from('products').update(changes).eq('id',row.pid).eq('organization_id',ctx.organization.id);
  if(u.error)throw u.error;Object.assign(p,changes);
}
async function learnSupplierMapping(row){if(!row.sourceCode||!row.pid||row.pid==='__new__')return false;const supplier=$('supplier').value.trim()||currentInvoice?.supplier_name||'';const payload={organization_id:ctx.organization.id,supplier_key:supplierKey(supplier),supplier_name:supplier||null,source_code:String(row.sourceCode).trim().toUpperCase(),raw_name:row.raw,normalized_raw_name:normalize(row.raw),product_id:row.pid,confidence:1,confirmed_by:ctx.user.id,updated_at:new Date().toISOString()};const r=await db().from('supplier_product_mappings').upsert(payload,{onConflict:'organization_id,supplier_key,source_code'});if(r.error)throw r.error;return true}
function syncPaidDate(){const paid=['cash','card'].includes($('paymentMode').value);$('paidDateWrap').classList.toggle('hidden',!paid);if(paid&&!$('paidDate').value)$('paidDate').value=$('date').value||new Date().toISOString().slice(0,10)}
async function savedInvoiceState(){
  const r=await db().from('invoices').select('id,status').eq('id',currentInvoice.id)
    .eq('organization_id',ctx.organization.id).eq('venue_id',ctx.venue.id).single();
  if(r.error)throw r.error;
  if(!r.data)throw new Error('Faktura není dostupná.');
  return r.data.status;
}
const finiteOrNull=v=>Number.isFinite(v)?v:null;
function auditLine(r){return {id:r.id,product_id:r.status==='approved'?r.pid:null,status:r.status,quantity:finiteOrNull(r.qty),
  unit_price_net:r.net,unit_price_gross:finiteOrNull(r.gross),vat_rate:r.vat,line_total_net:r.lineNet,
  line_total_gross:r.lineGross,adjustment_gross:r.adjustmentGross,volume_ml:finiteOrNull(r.vol),effective_unit_net:finiteOrNull(r.costNet),effective_unit_gross:finiteOrNull(r.costGross)};}
async function post(){
  if(!currentInvoice||posting)return;
  const check=reviewCheck();if(check.issues.length)return toast(check.issues[0],7000);
  const rs=check.rows,approved=check.approved,totalGross=check.totalGross;
  const controls=[...document.querySelectorAll('#editor input,#editor select,#editor button,#queue button')].map(el=>[el,el.disabled]);
  posting=true;for(const [el] of controls)el.disabled=true;$('postBtn').textContent='Zaúčtovávám…';
  const mode=$('paymentMode').value,paid=['cash','card'].includes(mode);
  const paymentStatus=paid?'paid':mode==='unpaid'?'unpaid':'unknown';
  try{
    try{
      const state=await savedInvoiceState();
      if(state!=='posted'){
        if(!['review','approved'].includes(state))throw new Error('Faktura už není ke schválení.');
        let learned=0;
        for(const r of rs){
          if(r.status==='approved'&&r.pid==='__new__')r.pid=await createProduct(r);
          const u=await db().from('invoice_lines').update({
            product_id:r.status==='approved'?r.pid:null,quantity:finiteOrNull(r.qty),
            unit_price:r.net,unit_price_net:r.net,unit_price_gross:finiteOrNull(r.gross),vat_rate:r.vat,
            line_total:r.lineNet,line_total_net:r.lineNet,line_total_gross:r.lineGross,status:r.status,
            match_method:r.status==='approved'?'manager_confirmed':'manager_ignored',match_confidence:r.status==='approved'?1:null
          }).eq('id',r.id).eq('invoice_id',currentInvoice.id).eq('organization_id',ctx.organization.id).select('id').single();
          if(u.error)throw u.error;
          if(r.status==='approved'){
            await learnProduct(r);if(r.qty>0)await history(r.id,r.pid,r);
            if(await learnSupplierMapping(r))learned++;
          }
        }
        const paidAt=paid?`${$('paidDate').value||$('date').value}T12:00:00`:null;
        const iu=await db().from('invoices').update({
          supplier_name:$('supplier').value.trim(),invoice_number:$('number').value.trim(),issue_date:$('date').value||null,
          total_amount:totalGross,total_amount_gross:totalGross,payment_status:paymentStatus,payment_method:paid?mode:null,paid_at:paidAt,status:'approved'
        }).eq('id',currentInvoice.id).eq('organization_id',ctx.organization.id).eq('venue_id',ctx.venue.id).in('status',['review','approved']).select('id').single();
        if(iu.error)throw iu.error;
        // Existing audit trigger commits stock once; original OCR values stay untouched.
        const a=await db().from('audit_events').insert({
          organization_id:ctx.organization.id,venue_id:ctx.venue.id,actor_user_id:ctx.user.id,event_type:'invoice.posted',entity_type:'invoice',entity_id:currentInvoice.id,
          before_data:{total_gross:currentInvoice.total_amount_gross??currentInvoice.total_amount,lines:currentLines},
          after_data:{approved_lines:approved.length,total_gross:totalGross,total_net:check.totalNet,vat_total:check.vatTotal,
            calculated_gross:check.calculatedGross,rounding_difference:check.difference,lines:rs.map(auditLine),
            payment_status:paymentStatus,payment_method:paid?mode:null,learned_supplier_mappings:learned}
        });
        if(a.error)throw a.error;
      }
    }catch(error){
      let state;try{state=await savedInvoiceState()}catch{throw error}
      if(state!=='posted')throw error;
    }
    toast(`Faktura uložena · ${money(totalGross)}${paid?` · ${mode==='card'?'kartou':'hotově'}`:''}.`,6000);
    currentInvoice=null;currentLines=[];$('editor').classList.add('hidden');$('emptyEditor').classList.remove('hidden');
    try{await loadProducts();await queue()}catch(error){console.warn(error);toast('Faktura je uložená. Pro aktualizaci přehledu obnov stránku.',7000);}
  }finally{posting=false;for(const [el,disabled] of controls)el.disabled=disabled;$('postBtn').disabled=false;$('postBtn').textContent='Schválit a naskladnit';}
}
async function init(){if(!await role())return;await loadProducts();await queue();$('paymentMode').onchange=syncPaidDate;$('date').onchange=()=>{if(['cash','card'].includes($('paymentMode').value)&&!$('paidDate').value)$('paidDate').value=$('date').value};$('postBtn').onclick=()=>post().catch(e=>{console.error(e);toast(`Zaúčtování selhalo: ${e.message}`,7000)})}
document.addEventListener('DOMContentLoaded',()=>init().catch(e=>toast(`Nelze načíst frontu: ${e.message}`,7000)));
})();
