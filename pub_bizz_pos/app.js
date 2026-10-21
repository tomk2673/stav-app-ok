/* Shared online register; standalone HTML keeps the separate local emergency mode. */
'use strict';
const C = window.POSCore, Customer = window.POSCustomerInsights, Store = window.POSStore;
const $ = s => document.querySelector(s);
const escapeHTML = value => String(value ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const E = escapeHTML;
const fmt = n => new Intl.NumberFormat('cs-CZ', { style:'currency', currency:'CZK', maximumFractionDigits:n % 100 ? 2 : 0 }).format(n / 100);
const inputMoney = n => String(n / 100).replace('.', ',');
const date = d => new Date(d).toLocaleString('cs-CZ', {timeZone:'Europe/Prague', day:'2-digit',month:'2-digit',hour:'2-digit',minute:'2-digit'});
const colors = {'Pivo':'#f1c986','Destiláty':'#b1bcf3','Nealko':'#8acbb6','Víno':'#dbabd6','Koktejly':'#efaa91','Likéry':'#b6c49f','Rumy':'#daba8b','Whisky':'#e2b46a','Brandy':'#e3aa9e','Teplé nápoje':'#c6ba91','Snacks':'#98b8df'};
let state, view = 'pos', current = 'bar', category = 'Vše', query = '', toastTimer, submitting = false, dialogCancel;
let accountQuery = '', accountSearchOpen = false, entryQuantity = 1, entryServingMl;
let mobileBillOpen = false;
let undoMarking, undoTimer, markingSequence = 0;
const accountActionsReady = () => !window.POSCloud || window.POSCloud.meta.accountActionsProtocol === 1;
let salesHistory, salesCounts;
const normalizeSearch = value => String(value).toLocaleLowerCase('cs').normalize('NFD').replace(/[\u0300-\u036f]/g, '').trim();
const getOrder = () => state.orders.find(x => x.id === current) || state.orders[0];
const btn = (label, action, cls = 'secondary', attrs = '') => `<button type="button" class="${cls}" data-action="${action}" ${attrs}>${label}</button>`;
function toast(message, bad = false) { const t = $('#toast'); t.textContent = message; t.className = `toast visible${bad ? ' bad' : ''}`; clearTimeout(toastTimer); toastTimer = setTimeout(() => t.className = 'toast', 4200); }
async function command(type, payload, fast = false) {
  const sequence = ++markingSequence;
  clearUndo();
  $('#save-state').textContent = 'Ukládám…';
  try {
    const response = await Store.command(type, payload);
    const addition=type==='addLine'&&response.operationId?response.state.audit.find(a=>[a.detail?.marking?.operationId,a.detail?.clientOperationId,a.id].includes(response.operationId)):null;
    const next=window.POSCloud?await Store.read():response.state,changed=next!==state;
    state=next;
    if(sequence===markingSequence&&addition?.type==='addLine')offerUndo(addition);
    if(changed)fast&&view==='pos'?renderPOSFast():render();else updateUndo();
    return response.result;
  }
  catch (e) { $('#save-state').textContent = window.POSCloud?.pending ? 'Výsledek zatím nepotvrzený' : 'Změna nebyla uložena'; $('#save-state').classList.add('error'); throw e; }
}
function clearUndo() { undoMarking=null;clearTimeout(undoTimer);updateUndo(); }
function offerUndo(addition) {
  if(!accountActionsReady()||addition.detail.orderId!==current)return;
  const line=getOrder().lines.find(l=>l.id===addition.addedLineId);
  if(!line)return;
  undoMarking={operationId:addition.detail.marking?.operationId||addition.id,orderId:current,quantity:addition.detail.quantity??1,expectedQuantity:line.quantity,expires:Date.now()+5000};
  updateUndo();
}
function undoLine() {
  if(!undoMarking||Date.now()>=undoMarking.expires||undoMarking.orderId!==current||!accountActionsReady())return;
  const cloud=window.POSCloud;
  if(cloud&&(cloud.optimisticMarking?(!cloud.canMark||cloud.outbox.some(r=>r.local?.status==='blocked'&&r.payload.orderId===current)):(!cloud.connected||!!cloud.pending||cloud.busy||!!cloud.storageError||cloud.authBlocked)))return;
  const o=getOrder(),a=state.audit.find(a=>(a.detail?.marking?.operationId||a.id)===undoMarking.operationId);
  const line=o.lines.find(l=>l.id===(a?.markingResult?.lineId||a?.addedLineId));
  if(a&&state.audit.slice(state.audit.indexOf(a)+1).some(event=>event.type!=='markingRejected'&&[event.orderId,event.detail?.orderId,event.detail?.targetOrderId].includes(current)))return;
  if(!o.paymentLock&&line&&!line.stockIssue&&line.quantity===undoMarking.expectedQuantity)return line;
}
function updateUndo() {
  const line=state&&undoLine(),seconds=line?Math.max(1,Math.ceil((undoMarking.expires-Date.now())/1000)):0;
  document.querySelectorAll('[data-action="undoLast"]').forEach(b=>{
    b.disabled=!line;b.textContent=seconds?`↶ Zpět · ${seconds} s`:'↶ Zpět';
    b.setAttribute('aria-label',line?`Vrátit poslední namarkování: ${undoMarking.quantity}× ${line.name}, zbývá ${seconds} sekund`:'Poslední namarkování už nelze vrátit');
  });
  clearTimeout(undoTimer);
  if(seconds)undoTimer=setTimeout(updateUndo,Math.min(250,undoMarking.expires-Date.now()));
}
async function undoLast() {
  const line=undoLine(),last=undoMarking;if(!line)return;
  clearUndo();
  await command('removeLine',{orderId:last.orderId,lineId:line.id,quantity:last.quantity,undoOf:last.operationId,reason:'Zpět · oprava posledního namarkování'},true);
  toast(`Vráceno ${last.quantity}× ${line.name}.`);
}
function renderPOSFast(){
  if(view!=='pos'||!state)return render();
  if(!state.orders.some(o=>o.id===current))return render();
  const shell=document.createElement('div');shell.innerHTML=renderPOS();
  const fresh=shell.firstElementChild, live=$('.pos-layout');
  if(!fresh||!live)return render();
  const nextAccounts=fresh.querySelector('.accounts'),nextReceipt=fresh.querySelector('.receipt');
  const accounts=live.querySelector('.accounts'),receipt=live.querySelector('.receipt');
  if(accounts&&nextAccounts){const top=accounts.scrollTop,left=accounts.scrollLeft;accounts.replaceWith(nextAccounts);nextAccounts.scrollTop=top;nextAccounts.scrollLeft=left;}
  if(receipt&&nextReceipt){const scroll=receipt.querySelector('.receipt-items')?.scrollTop||0;receipt.replaceWith(nextReceipt);nextReceipt.querySelector('.receipt-items').scrollTop=scroll;}
  const notice=live.querySelector('#payment-reservation'),nextNotice=fresh.querySelector('#payment-reservation');
  if(notice&&nextNotice)notice.replaceWith(nextNotice);
  updateEntryContext();
  if(accountSearchOpen)renderAccountResults();
  updateMobileBill();
  $('#save-state').textContent=window.POSCloud?'Potvrzeno serverem':'Uloženo v tomto zařízení';$('#save-state').classList.remove('error');connection();
}
function field(label, name, value = '', extra = '', full = false) { return `<label class="field${full ? ' full' : ''}">${label}<input name="${name}" value="${E(value)}" ${extra}></label>`; }
function showDialog(title, body, submit, label = 'Uložit', onDone, onCancel) {
  window.paymentAbort?.abort();
  const d = $('#dialog'); if (d.open) d.close();
  d.classList.remove('payment-dialog');$('#dialog-summary').hidden=true;$('#dialog-summary').textContent='';
  dialogCancel = onCancel;
  $('#dialog-title').textContent = title; $('#dialog-body').innerHTML = body; $('#dialog-error').textContent = '';
  $('#dialog-submit').textContent = label; $('#dialog-submit').hidden = !submit; $('#dialog-submit').disabled = false;
  $('#dialog-form').onsubmit = async event => {
    event.preventDefault(); if (!submit || submitting) return;
    submitting = true; $('#dialog-submit').disabled = true; $('#dialog-error').textContent = '';
    try { const result = await submit(new FormData(event.currentTarget)); d.close(); if (onDone) await onDone(result); }
    catch (e) { if (d.open) $('#dialog-error').textContent = e.message || 'Operace se nepodařila.'; else toast(e.message || 'Operace se nepodařila.', true); }
    finally { submitting = false; $('#dialog-submit').disabled = false; }
  };
  $('#dialog .dialog-actions .close-dialog').hidden=false;
  $('#dialog .dialog-actions .close-dialog').textContent='Zpět';
  window.paymentAbort=new AbortController();
  d.showModal();
  scrollDialogTop();
}
function scrollDialogTop() { $('#dialog').scrollTop=0;$('#dialog-body').scrollTop=0; }
function closeDialog() {
  if (submitting) return;
  if (dialogCancel) dialogCancel(); else $('#dialog').close();
}
function connection() {
  const cloud=window.POSCloud,online=cloud?cloud.connected:navigator.onLine;
  $('#network').textContent=cloud?(online?'Spojeno s PUB GURU':cloud.canMark?'Bez spojení · místně':'Čekám na server'):(online?'Místní pokladna':'Místní · bez internetu');
  $('#network').classList.toggle('offline',!online);
  if(!cloud)return;
  const all=cloud.outbox||[],marking=all.filter(r=>r.local?.kind==='marking'),strict=all.find(r=>r.local?.kind!=='marking'),conflicts=marking.filter(r=>r.local.status==='blocked');
  const pending=cloud.pending,warning=$('#sync-warning');
  const backgroundMarking=marking.length&&!strict&&!conflicts.length&&!cloud.serviceError&&!cloud.storageError&&!cloud.authBlocked;
  warning.hidden=!state||!!backgroundMarking||(!pending&&online&&!cloud.storageError&&!cloud.authBlocked);
  // Routine background work must never intercept the next product tap.
  // Local counts and the bill retain their pending status; errors stay explicit.
  if(backgroundMarking)warning.innerHTML='';
  else if(strict)warning.innerHTML=`<span><strong>Ověřujeme uloženou operaci.</strong> Platbu na terminálu neopakuj.</span>${btn('Ověřit operaci','retryPending','primary',cloud.busy?'disabled':'')}`;
  else if(marking.length)warning.innerHTML=`<span><strong>${E(cloud.serviceError|| (cloud.authBlocked?'Ověř přihlášení a oprávnění':conflicts.length?`${conflicts.length} konfliktů ke kontrole`:cloud.busy?'Odesílám markování':'Uloženo v zařízení'))}</strong> · ${marking.length} změn čeká na potvrzení.</span><div class="sync-actions">${btn('Zobrazit','syncDetails','secondary')}${!cloud.busy?btn('Ověřit','retryPending','secondary'):''}</div>`;
  else warning.innerHTML=`<span>${E(cloud.storageError|| (cloud.authBlocked?'Přístup vyžaduje nové přihlášení. Čekající data zůstávají v zařízení.':'Server není dostupný. Markování se ukládá v zařízení; placení vyžaduje spojení.'))}</span>`;
  if(state){$('#save-state').textContent=conflicts.length?'Konflikt ke kontrole':marking.length?`${marking.length} změn v zařízení`:cloud.busy?'Ukládám na server…':pending?'Čeká na ověření':online?'Potvrzeno serverem':'Místní · bez spojení';$('#save-state').classList.toggle('error',!!conflicts.length||!!strict||!!cloud.storageError);}
  const writeActions=['add','minus','quantityPad','undoLast','moveAccount','moveItems','restoreReceipt','newOrder','renameOrder','endVisit','deleteOrder','mergeOrders','openShift','payCash','payCard','payCredit','paySplit','cancelPayment','creditTopup','creditReverse','refund','closeShift','cashMovement','newProduct','editProduct','archiveProduct','bulkProducts','recipe','resolveStock'];
  const markAllowed=cloud.canMark,orderLocked=!!state&&!!getOrder()?.paymentLock,orderConflict=conflicts.some(r=>r.payload.orderId===current);
  document.querySelectorAll('[data-action]').forEach(b=>{
    if(!writeActions.includes(b.dataset.action))return;
    const soft=['add','minus','quantityPad','undoLast'].includes(b.dataset.action)&&cloud.optimisticMarking;
    const lock=soft?(!markAllowed||orderLocked||orderConflict):(!!pending||!online||!!cloud.storageError||cloud.authBlocked);
    if(lock&&!b.disabled){b.disabled=true;b.dataset.connectionDisabled='true';}
    else if(!lock&&b.dataset.connectionDisabled){b.disabled=false;delete b.dataset.connectionDisabled;}
  });
  updateUndo();
}
function syncDetails() {
  const rows=(window.POSCloud?.outbox||[]).filter(r=>r.local?.kind==='marking');
  showDialog('Čekající markování',`<p class="help">Čekající položky patří původnímu účtu. Konflikt porovnej s potvrzeným účtem; chybějící nápoj pak namarkuj znovu.</p><div class="sync-list">${rows.map(r=>`<div class="sync-item"><strong>${E(r.local.orderName)}</strong><span>${E(r.local.label)} · ${r.type==='addLine'?'+':r.type==='removeLine'?'−':''}${r.local.quantity} ks</span><small>${E(r.local.error||'Uloženo v zařízení · čeká na server')}</small>${r.local.status==='blocked'?btn('Ponechat stav serveru','dismissMarking','secondary',`data-id="${E(r.requestId)}"`):''}</div>`).join('')}</div>`,null);
}
function render() {
  if (!state) return;
  const focused=document.activeElement?.id, selection=document.activeElement?.selectionStart;
  const scrolls=['#products','.accounts','.receipt-items'].map(selector=>{const el=$(selector);return {selector,top:el?.scrollTop||0,left:el?.scrollLeft||0};});
  document.body.classList.toggle('pos-workspace',view==='pos');
  if (!state.orders.some(x => x.id === current)) setCurrentAccount('bar');
  $('#venue').textContent = state.settings.venue;
  const sh = C.activeShift(state);
  $('#shift-label').textContent = sh ? `Směna od ${date(sh.openedAt)} · ${sh.operator}` : 'Směna není otevřená';
  $('#save-state').textContent = window.POSCloud ? 'Potvrzeno serverem' : 'Uloženo v tomto zařízení'; $('#save-state').classList.remove('error');
  document.querySelectorAll('[data-view]').forEach(b => b.classList.toggle('active', b.dataset.view === view));
  const pageName = $('#main-nav .active').textContent;
  $('#nav-current-view').textContent = pageName;
  $('#nav-toggle').setAttribute('aria-label', 'Přepnout stránku: ' + pageName);
  $('#nav-context').textContent = $('#venue').textContent + ' · ' + $('#shift-label').textContent;
  const templates = { pos: renderPOS, history: renderHistory, overview: renderOverview, catalog: renderCatalog, settings: renderSettings, stock:()=>POSStockUI.render(state) };
  $('#app').innerHTML = templates[view]();
  if (view === 'pos') {
    renderProducts();
    $('#search').addEventListener('input', e => { query = e.target.value; document.querySelectorAll('.category').forEach(b => b.classList.toggle('active', !query && b.dataset.id===category)); renderProducts(); });
    bindAccountSearch();
    resizePOSWorkspace();
    for(const {selector,top,left} of scrolls){const el=$(selector);if(el){el.scrollTop=top;el.scrollLeft=left;}}
  }
  if(view==='stock')POSStockUI.bind();
  if(focused&&['search','recipe-search','account-search'].includes(focused)&&document.getElementById(focused)){const el=document.getElementById(focused);el.focus({preventScroll:true});if(selection!==null)el.setSelectionRange(selection,selection);}
  updateMobileBill();
  connection();
  if (view === 'settings') $('#settings-form').onsubmit = async e => { e.preventDefault(); try { await command('settings', Object.fromEntries(new FormData(e.currentTarget))); toast('Nastavení uložené.'); } catch(err) { toast(err.message, true); } };
}
function accountNumber(order) {
  return order.name.match(/^(?:st[ůu]l\s*#?\s*)?(\d+)\b/i)?.[1] || '';
}
function matchingAccounts() {
  const q = normalizeSearch(accountQuery);
  const exact = o => normalizeSearch(o.name) === q || (/^\d+$/.test(q) && accountNumber(o) && Number(accountNumber(o)) === Number(q));
  return state.orders.filter(o => !q || normalizeSearch(o.name).includes(q) || exact(o))
    .sort((a,b) => Number(exact(b))-Number(exact(a)) || Number(b.id===current)-Number(a.id===current));
}
function renderAccountResults() {
  const results = $('#account-results'); if (!results) return;
  results.hidden = !accountSearchOpen;
  $('#account-search').setAttribute('aria-expanded', String(accountSearchOpen));
  if (!accountSearchOpen) return;
  const matches = matchingAccounts();
  results.innerHTML = matches.map(o => `<button type="button" class="account-result ${o.id===current?'active':''}" data-action="account" data-id="${E(o.id)}"><strong>${E(o.name)}</strong><span>${fmt(C.sum(o.lines))}${o.paymentLock?' · Platba':''}</span></button>`).join('') + (matches.length ? '' : '<p class="account-not-found">Takový účet zatím není otevřený.</p>') + btn(accountQuery.trim()?`+ Nový účet: ${E(accountQuery.trim())}`:'+ Nový účet','newOrder','account-result account-create');
}
function bindAccountSearch() {
  const input = $('#account-search');
  input.addEventListener('focus', () => { accountSearchOpen = true; if(!accountQuery&&current!=='bar')input.select(); renderAccountResults(); });
  input.addEventListener('input', e => {
    accountQuery = e.target.value; accountSearchOpen = true;
    if(!accountQuery.trim()&&current!=='bar'){
      try{setCurrentAccount('bar');}catch(err){accountQuery=getOrder().name;input.value=accountQuery;toast(err.message,true);return;}
      renderPOSFast();renderProducts();
    }
    renderAccountResults();
  });
  input.addEventListener('keydown', e => {
    if (e.key==='Escape') { accountSearchOpen=false;renderAccountResults();input.blur(); }
    if (e.key==='Enter') {
      e.preventDefault(); const matches=matchingAccounts(), q=normalizeSearch(accountQuery);
      if(matches.length===1 || (matches[0] && (normalizeSearch(matches[0].name)===q || (/^\d+$/.test(q)&&Number(accountNumber(matches[0]))===Number(q))))) selectAccount(matches[0].id);
    }
  });
  renderAccountResults();
}
function updateEntryContext() {
  const o=getOrder();
  const accountInput=$('#account-search');
  if(accountInput&&!accountSearchOpen&&!accountQuery&&document.activeElement!==accountInput)accountInput.value=o.id==='bar'?'':o.name;
  if($('#entry-account-name'))$('#entry-account-name').textContent=o.name;
  if($('#entry-account-total'))$('#entry-account-total').textContent=fmt(C.sum(o.lines));
  if($('#entry-quantity'))$('#entry-quantity').textContent=`${entryQuantity}×`;
  const portionButton=document.querySelector('[data-action="smallShot"]');
  if(portionButton){portionButton.classList.toggle('active',entryServingMl===20);portionButton.setAttribute('aria-pressed',String(entryServingMl===20));}
  if($('#entry-count-label'))$('#entry-count-label').textContent=entryServingMl===20?'Počet malých panáků · 2 cl':'Počet';
  const profileButton=document.querySelector('[data-action="customerProfile"]');if(profileButton)profileButton.hidden=!customerAccount(o);
  document.querySelectorAll('[data-action="entryCount"]').forEach(b=>{
    const active=Number(b.dataset.id)===entryQuantity;
    b.classList.toggle('active',active);b.setAttribute('aria-pressed',String(active));
  });
}
function resizePOSWorkspace() {
  const layout=$('.pos-layout');if(!layout)return;
  const dockHeight=$('#mobile-account-dock')?.getBoundingClientRect().height||0;
  const bottom=window.innerWidth<=630?Math.max(116,dockHeight+12):16;
  const height=Math.min(window.innerHeight,window.visualViewport?.height||window.innerHeight);
  layout.style.setProperty('--pos-height',`${Math.max(280,height-Math.max(10,layout.getBoundingClientRect().top+window.scrollY)-bottom)}px`);
}
function updateMobileBill(){
  const bill=$('#mobile-bill');if(!bill)return;
  const dock=$('#mobile-account-dock');if(dock)dock.hidden=view!=='pos';
  bill.hidden=view!=='pos';bill.dataset.action=mobileBillOpen?'showProducts':'showBill';
  const order=getOrder(),queued=(window.POSCloud?.outbox||[]).filter(r=>r.local?.kind==='marking').length;
  bill.innerHTML=mobileBillOpen?`<strong>← Nápoje</strong><span>${E(order.name)} · ${fmt(C.sum(order.lines))}</span>`:`<span>${E(order.name)} · ${order.lines.reduce((n,l)=>n+l.quantity,0)} ks${queued?` · ${queued} čeká`:''}</span><strong>Účet ${fmt(C.sum(order.lines))} →</strong>`;
  const actions=$('#mobile-account-actions');if(actions)actions.innerHTML=billActions(order);
  updateUndo();resizePOSWorkspace();
}
function showProducts(){
  mobileBillOpen=false;updateMobileBill();
  const catalog=$('.catalog-area'),toolbar=$('.topbar');
  if(window.innerWidth<=630&&catalog){
    const top=toolbar?.getBoundingClientRect().bottom||0,rect=catalog.getBoundingClientRect();
    if(rect.top<top||rect.top>window.innerHeight/2)window.scrollTo({top:Math.max(0,window.scrollY+rect.top-top-6),behavior:'auto'});
  }
}
function updateProductFilters(){
  const cats=['Vše',...new Set(state.products.filter(p=>p.active&&(entryServingMl!==20||C.smallShot(p))).map(p=>p.category))],categories=$('.categories'),left=categories.scrollLeft;
  categories.innerHTML=cats.map(c=>`<button type="button" class="category ${!query&&category===c?'active':''}" data-action="category" data-id="${E(c)}" aria-pressed="${!query&&category===c}">${E(c)}</button>`).join('');categories.scrollLeft=left;
  if($('#search'))$('#search').value=query;
  // Keep the live menu and its scroll container in place on every selection.
  renderProducts();if($('#products'))$('#products').scrollTop=0;
  updateEntryContext();showProducts();connection();
}
function setCurrentAccount(id) {
  window.POSCloud?.selectOrder(id);if(current!==id)clearUndo();current=id;
}
function selectAccount(id) {
  if(!state.orders.some(o=>o.id===id))return;
  setCurrentAccount(id);entryQuantity=1;accountQuery='';accountSearchOpen=false;
  const input=$('#account-search');if(input){input.value=id==='bar'?'':getOrder().name;input.blur();}
  renderPOSFast();renderProducts();renderAccountResults();showProducts();
}
function renderPOS() {
  const o=getOrder(),sh=C.activeShift(state),activeProducts=state.products.filter(x=>x.active&&(entryServingMl!==20||C.smallShot(x))),cats=['Vše',...new Set(activeProducts.map(x=>x.category))];
  const canMerge=sh&&o.lines.length&&!o.paymentLock&&state.orders.some(x=>x.id!==o.id&&!x.paymentLock);
  const canResume=!o.paymentLock||o.paymentLock.actorId===window.POSCloud?.user?.id||['owner','manager'].includes(window.POSCloud?.meta.role);
  const customer=customerAccount(o), credit=customer?customerCredit(o):0;
  const accounts=state.orders.map(a=>`<button type="button" class="account ${a.id===o.id?'active':''}" data-action="account" data-id="${E(a.id)}" aria-pressed="${a.id===o.id}"><span class="account-number">${E(accountNumber(a)||'•')}</span><span class="account-name">${E(a.name)}<span class="account-amount">${a.lines.length?fmt(C.sum(a.lines)):'Prázdný účet'}</span></span></button>`).join('');
  const waiting=(window.POSCloud?.outbox||[]).filter(r=>r.local?.kind==='marking'&&r.payload.orderId===o.id);
  const lines=o.lines.map(l=>`<div class="line${waiting.some(r=>r.payload.productId===l.productId||r.payload.lineId===l.id)?' line-pending':''}"><div class="line-top"><span>${E(l.name)}${waiting.some(r=>r.payload.productId===l.productId||r.payload.lineId===l.id)?'<small class="pending-badge">čeká</small>':''}${l.serving?`<small class="small"> · ${E(l.serving)}</small>`:''}</span><strong>${fmt(l.price*l.quantity)}</strong></div><div class="line-bottom"><span>${fmt(l.price)} / ks</span><div class="quantity"><button type="button" data-action="minus" data-id="${E(l.id)}" aria-label="Odebrat ${E(l.name)}">−</button><button type="button" class="quantity-tap" data-action="quantityPad" data-id="${E(l.id)}" aria-label="Množství ${E(l.name)}">${l.quantity}×</button><button type="button" data-action="add" data-id="${E(l.productId)}" data-serving-ml="${l.servingMl||''}" aria-label="Přidat ${E(l.name)}">+</button></div></div></div>`).join('');
  return `<div class="pos-layout">
    <aside class="accounts"><div class="section-label"><span class="eyebrow">Otevřené účty</span><span class="badge">${state.orders.filter(x=>x.lines.length).length}</span></div>${accounts}${btn('+ Nový účet','newOrder','add-account')}</aside>
    <section class="catalog-area">
      <div class="order-entry"><div class="entry-target"><span>Na účet</span><strong id="entry-account-name">${E(o.name)}</strong><button type="button" class="customer-profile-button" data-action="customerProfile" aria-label="Detail zákazníka" ${customer?'':'hidden'}>Profil</button><span id="entry-account-total">${fmt(C.sum(o.lines))}</span></div>
        <div class="account-finder"><label class="sr-only" for="account-search">Stůl nebo zákazník; prázdné pole znamená rychlý prodej</label><input id="account-search" type="search" placeholder="Stůl / zákazník · prázdné = rychlý prodej" autocomplete="off" value="${E(accountQuery||(o.id==='bar'?'':o.name))}" aria-expanded="false" aria-controls="account-results"><div id="account-results" class="account-results" hidden></div></div>
        <div class="entry-counts" aria-label="Počet kusů pro další položku"><div class="entry-count-options"><span id="entry-count-label">${entryServingMl===20?'Počet malých panáků · 2 cl':'Počet'}</span>${btn('2 cl','smallShot',`entry-portion ${entryServingMl===20?'active':''}`,`aria-pressed="${entryServingMl===20}" aria-label="Malý panák 2 cl"`)}</div>${[1,2,3,4,5].map(n=>btn(n,'entryCount',`entry-count ${n===entryQuantity?'active':''}`,`data-id="${n}" aria-pressed="${n===entryQuantity}"`)).join('')}${btn(`<strong id="entry-quantity">${entryQuantity}×</strong><small>Jiný počet</small>`,'entryQuantity','entry-calculator','aria-label="Zadat počet kusů na velké klávesnici"')}</div>
      </div>
      <div id="payment-reservation">${window.POSCloud&&o.paymentLock?`<div class="notice"><span>Účet je rezervovaný pro rozpracovanou platbu.</span><div class="actions">${btn('Zrušit platbu','cancelPayment','secondary',canResume?'':'disabled')}${btn('Zkontrolovat platbu','checkPayment','secondary')}</div></div>`:''}</div>
      ${!sh?`<div class="notice"><span>Začni směnu a zadej hotovost v pokladně.</span>${btn('Otevřít směnu','openShift','shift-start')}</div>`:''}
      ${activeProducts.some(x=>x.price===null)?`<div class="notice"><span>${activeProducts.filter(x=>x.price===null).length} položek nemá cenu. Doplníš ji klepnutím.</span></div>`:''}
      <div class="search"><span class="search-icon">⌕</span><label class="sr-only" for="search">Hledat v nápojích</label><input id="search" type="search" placeholder="Hledat nápoj nebo kód…" autocomplete="off" value="${E(query)}"></div>
      <div class="categories" aria-label="Kategorie">${cats.map(c=>`<button type="button" class="category ${category===c?'active':''}" data-action="category" data-id="${E(c)}" aria-pressed="${category===c}">${E(c)}</button>`).join('')}</div>
      <div class="products" id="products"></div>
    </section>
    <section class="receipt" aria-label="Aktuální účet"><div class="receipt-head"><div><h2>${E(o.name)}</h2>${waiting.length?`<span class="pending-badge">${waiting.length} změn čeká</span>`:''}<p>${o.lines.length?'Účet zůstává otevřený do zaplacení':'Připravený pro dalšího hosta'}</p></div><span class="receipt-number">${E(accountNumber(o)||'•')}</span></div><div class="receipt-tools">${o.id!=='bar'?btn('Přejmenovat','renameOrder','merge-account rename-account',o.paymentLock?'disabled':''):''}${btn('Spojit účty','mergeOrders','merge-account',canMerge?'':'disabled')}</div><div class="receipt-items">${lines||'<div class="receipt-empty"><span>≡</span><p>Účet je zatím prázdný.<br>Přidej první nápoj.</p></div>'}</div><div class="receipt-bottom"><div class="receipt-meta"><span>${o.lines.reduce((n,l)=>n+l.quantity,0)} ks na účtu</span>${o.id!=='bar'&&!o.lines.length?btn('Smazat účet','deleteOrder','splitbutton'):'<span>Ceny v Kč</span>'}</div><div class="receipt-total"><span>K zaplacení</span>${btn('↶ Zpět','undoLast','undo-marking','disabled')}<strong>${fmt(C.sum(o.lines))}</strong></div>${billActions(o)}<div class="payment-buttons ${customer?'with-credit':''}">${btn('Hotově','payCash','paycash',!sh||!o.lines.length||!!o.paymentLock?'disabled':'')}${btn('Kartou','payCard','paycard',!sh||!o.lines.length||!!o.paymentLock?'disabled':'')}${customer?btn(`Kredit ${fmt(credit)}`,'payCredit','paycredit',!sh||!o.lines.length||!!o.paymentLock||credit<C.sum(o.lines)?'disabled':''):''}</div></div></section>
  </div>`;
}
function billActions(o) {
  const enabled=!!C.activeShift(state)&&!!o.lines.length&&!o.paymentLock;
  const canSplit=!!C.activeShift(state)&&!!o.lines.length&&(!o.paymentLock||o.paymentLock.actorId===window.POSCloud?.user?.id||['owner','manager'].includes(window.POSCloud?.meta.role));
  const target=state.orders.some(x=>x.id!==o.id&&!x.paymentLock);
  return `<div class="bill-actions" aria-label="Práce s účtem">${btn('Rozdělit','paySplit','bill-action',canSplit?'':'disabled')}${btn('Přesun účtu','moveAccount','bill-action',enabled&&target?'':'disabled')}${btn('Přesun položek','moveItems','bill-action',enabled&&target&&accountActionsReady()?'':'disabled')}</div>`;
}
function quantityPickerHTML(name,initial,min=1,max=999,all=false) {
  const digits=[7,8,9,4,5,6,1,2,3];
  return `<div class="quantity-picker"><div class="qty-product"><strong>${E(name)}</strong><span>${min}–${max} ks</span></div>
    <div class="qty-quick"><div class="qty-pad">${digits.map(n=>`<button type="button" class="qty-choice ${n===initial?'active':''}" data-qty="${n}" ${n>max?'disabled':''}>${n}</button>`).join('')}${min===0?'<button type="button" class="qty-choice" data-qty="0">0</button>':`<button type="button" class="qty-choice" data-qty="10" ${max<10?'disabled':''}>10</button>`}${all?`<button type="button" class="qty-choice qty-all" data-qty="${max}">Vše<br><small>${max} ks</small></button>`:''}<button type="button" class="qty-choice qty-more" data-qty-more>Jiný počet</button></div></div>
    <div class="qty-calculator" hidden><label class="sr-only">Počet kusů</label><input class="qty-display" aria-label="Počet kusů" inputmode="numeric" value="${initial}" readonly><div class="qty-pad">${digits.map(n=>`<button type="button" class="qty-choice" data-qty-digit="${n}">${n}</button>`).join('')}<button type="button" class="qty-choice" data-qty-clear>C</button><button type="button" class="qty-choice" data-qty-digit="0">0</button><button type="button" class="qty-choice" data-qty-back aria-label="Smazat číslici">⌫</button></div><button type="button" class="primary qty-confirm" data-qty-confirm>OK · použít počet</button></div></div>`;
}
function bindQuantityPicker(root,initial,min,max,onSelect,calculator=false) {
  root=root.querySelector('.quantity-picker')||root;
  let digits=String(initial),replace=true,multiple=false;
  const valid=()=>Number.isSafeInteger(Number(digits))&&Number(digits)>=min&&Number(digits)<=max;
  const update=()=>{root.querySelector('.qty-display').value=digits||'0';root.querySelector('[data-qty-confirm]').disabled=!valid();};
  const key=value=>{if(replace){digits='';replace=false;}if(digits.length<3)digits=(digits+value).replace(/^0+(?=\d)/,'');update();};
  const choose=quantity=>{if(Number.isSafeInteger(quantity)&&quantity>=min&&quantity<=max)onSelect(quantity);};
  root.addEventListener('click',e=>{
    const b=e.target.closest('button');if(!b||b.disabled)return;
    if(b.dataset.qty!==undefined)choose(Number(b.dataset.qty));
    else if(b.hasAttribute('data-qty-more')){multiple=true;root.querySelector('.qty-quick').hidden=true;root.querySelector('.qty-calculator').hidden=false;update();root.querySelector('[data-qty-digit]').focus();}
    else if(b.dataset.qtyDigit!==undefined)key(b.dataset.qtyDigit);
    else if(b.hasAttribute('data-qty-clear')){digits='';replace=false;update();}
    else if(b.hasAttribute('data-qty-back')){digits=digits.slice(0,-1);replace=false;update();}
    else if(b.hasAttribute('data-qty-confirm')&&valid())choose(Number(digits));
  });
  root.addEventListener('keydown',e=>{
    if(/^\d$/.test(e.key)){e.preventDefault();if(multiple)key(e.key);else choose(Number(e.key));}
    else if(multiple&&e.key==='Backspace'){e.preventDefault();digits=digits.slice(0,-1);replace=false;update();}
    else if(multiple&&e.key==='Enter'){e.preventDefault();if(valid())choose(Number(digits));}
  });
  if(calculator)root.querySelector('[data-qty-more]').click();else root.querySelector('[data-qty]:not([disabled])')?.focus();
}
function entryQuantityPad() {
  showDialog('Počet pro další položku',quantityPickerHTML(getOrder().name,entryQuantity),null);
  bindQuantityPicker($('#dialog-body'),entryQuantity,1,999,quantity=>{entryQuantity=quantity;$('#dialog').close();updateEntryContext();},true);
}
function quantityPad(lineId) {
  const o=getOrder(),l=o.lines.find(x=>x.id===lineId);if(!l)return;
  showDialog('Změnit počet kusů',quantityPickerHTML(l.name,l.quantity),null);
  bindQuantityPicker($('#dialog-body'),l.quantity,1,999,async quantity=>{
    $('#dialog').close();try{await command('setLineQuantity',{orderId:o.id,lineId:l.id,quantity},true);}catch(err){toast(err.message||'Množství se nepodařilo změnit.',true);}
  });
}
function customerAccount(order) {
  return !!Customer && order?.id !== 'bar' && Customer.isCustomerName(order?.name);
}
function customerCredit(order) {
  const customer=order?.customerId?(state.customers||[]).find(x=>x.id===order.customerId):C.findCustomer?.(state,order?.name);
  return customer?C.creditBalance(state,customer.id):0;
}
function durationText(minutes) {
  if (!Number.isFinite(minutes) || minutes <= 0) return '—';
  const h=Math.floor(minutes/60),m=Math.round(minutes%60);
  return h ? `${h} h ${m} min` : `${m} min`;
}
function customerProfile() {
  const o=getOrder(); if(!customerAccount(o))return;
  const p=Customer.profile(state,o.name,o,new Date().toISOString());
  const rows=p.items.map(x=>`<tr><td><strong>${E(x.name)}</strong>${x.serving?`<br><span class="muted small">${E(x.serving)}</span>`:''}</td><td class="amount">${x.quantity}×</td><td class="amount">${fmt(x.spend)}</td></tr>`).join('');
  const payments=p.payments.slice(0,12).map(r=>`<tr><td><strong>${date(r.at)}</strong><br><span class="muted small">${E(r.number||'Doklad')}</span></td><td>${paymentLabel(r)}</td><td class="amount">${fmt(r.total)}</td></tr>`).join('');
  const canReverse=!window.POSCloud||['owner','manager'].includes(window.POSCloud.meta.role);
  const deposits=(state.creditLedger||[]).filter(x=>x.customerId===p.customerId&&['topup','reversal'].includes(x.type)).reverse().map(x=>{
    const reversed=state.creditLedger.some(y=>y.reversalOf===x.id);
    return `<div class="summary-row"><span>${date(x.at)} · ${x.type==='reversal'?'Storno dobití':'Dobití'} · ${x.method==='card'?'kartou':'hotově'}${reversed?' · stornováno':''}</span><strong>${fmt(x.amount)}</strong>${canReverse&&x.type==='topup'&&!reversed?btn('Stornovat','creditReverse','textbutton',`data-id="${E(x.id)}" ${C.activeShift(state)?'':'disabled'}`):''}</div>`;
  }).join('');
  const rank=p.rank?`#${p.rank} z ${p.competitors}`:'—';
  showDialog(o.name+` · zákazník`,`<div class="customer-profile">
    ${p.activeVisit?`<div class="customer-current"><span>Aktuální návštěva</span><strong>${p.currentMinutes?durationText(p.currentMinutes):'0 min'}</strong></div>`:p.lastVisit?'<p class="help">Návštěva je ukončená. Nezaplacený účet zůstává otevřený.</p>':''}
    ${o.visitStartedAt&&!o.paymentLock?btn('Host odešel · ukončit návštěvu','endVisit','secondary'):''}
    <div class="customer-stats">
      <div><span>Kredit</span><strong>${fmt(p.creditBalance||0)}</strong></div>
      <div><span>Věrnostní body</span><strong>${p.points}</strong></div>
      <div><span>Pořadí</span><strong>${rank}</strong></div>
      <div><span>Historicky zaplaceno</span><strong>${fmt(p.spend)}</strong></div>
      <div><span>Aktuálně nezaplaceno</span><strong>${fmt(p.openAmount||0)}</strong></div>
      <div><span>Položek</span><strong>${p.itemCount}</strong></div>
      <div><span>Návštěvy s časem</span><strong>${p.visitCount}</strong></div>
      <div><span>Čas návštěv${p.estimatedVisitCount?' · část odhadem':''}</span><strong>${durationText(p.totalMinutes)}</strong></div>
      <div><span>Průměr návštěvy</span><strong>${durationText(p.averageMinutes)}</strong></div>
      <div><span>Útrata / hod.</span><strong>${p.exactMinutes?fmt(p.spendPerHour):'—'}</strong></div>
    </div>
    <div class="form-actions">${btn('Dobít kredit','creditTopup','primary',C.activeShift(state)?'':'disabled')}</div>
    ${deposits?`<details class="section-gap"><summary>Dobití a storna kreditu</summary>${deposits}</details>`:''}
    <p class="help customer-rules"><strong>Kredit</strong> jsou předplacené peníze, 1 Kč = 1 Kč. <strong>Věrnostní body</strong> jsou samostatná odměna a nejdou použít jako peníze. 1 bod získáš za každých 10 Kč skutečně zaplacené útraty.</p>
    <div class="customer-detail"><span>Zaplacených dokladů: <strong>${p.receiptCount}</strong></span><span>Poslední platba: <strong>${p.lastAt?date(p.lastAt):'—'}</strong></span></div>
    <h3>Jednotlivé zaplacené doklady</h3>
    <div class="table-wrap customer-payments"><table><thead><tr><th>Datum</th><th>Úhrada</th><th class="amount">Částka</th></tr></thead><tbody>${payments||'<tr><td colspan="3" class="empty">Zatím žádný zaplacený doklad.</td></tr>'}</tbody></table></div>
    <p class="help customer-rules">1 bod za každých 10 Kč skutečně zaplacené útraty. Vratky se automaticky odečítají. Pořadí je podle bodů, ne podle množství alkoholu. Návštěva se po 2 hodinách bez další objednávky automaticky ukončí odhadem. Další objednávka začne novou návštěvu i na nezaplaceném účtu. Odchod lze potvrdit ručně. Odhady se nepoužívají pro útratu za hodinu.</p>
    <h3>Co nejčastěji bere</h3>
    <div class="table-wrap customer-drinks"><table><thead><tr><th>Položka</th><th class="amount">Počet</th><th class="amount">Útrata</th></tr></thead><tbody>${rows||'<tr><td colspan="3" class="empty">Po prvním zaplaceném dokladu se tu objeví statistika.</td></tr>'}</tbody></table></div>
  </div>`,null);
}
function creditTopup(prepared) {
  const o=structuredClone(getOrder());if(!customerAccount(o))return;
  const funding=prepared?.purpose==='creditTopup'?prepared:null;
  if(funding){
    showDialog('Dobít kredit · '+o.name,`<p class="help"><strong>${fmt(funding.amount)} kartou</strong> · účet je rezervovaný. Pokud už host zaplatil, platbu na terminálu neopakuj.</p><label class="inline-check"><input type="checkbox" name="cardConfirmed" required>Dobití kartou na terminálu proběhlo úspěšně.</label>`,f=>command('creditTopup',{orderId:o.id,amount:funding.amount,method:'card',paymentToken:funding.token,cardConfirmed:f.has('cardConfirmed')}),'Připsat kredit',r=>{toast(`Kredit dobit o ${fmt(r.amount)}`);customerProfile();});return;
  }
  showDialog('Dobít kredit · '+o.name,`
    <p class="help">Kredit je předplacená peněžní hodnota. Dobití se eviduje odděleně od tržby za nápoje.</p>
    <div class="form-grid">${field('Částka (Kč)','amount','','required inputmode="decimal" placeholder="500"')}<label class="field">Zaplaceno<select name="method"><option value="cash">Hotově</option><option value="card">Kartou</option></select></label></div>
    <label class="inline-check" id="topup-card-confirm" hidden><input type="checkbox" name="cardConfirmed">Dobití kartou na terminálu proběhlo úspěšně.</label>`,
    async form=>{
      const amount=C.money(form.get('amount')),method=form.get('method');
      if(window.POSCloud&&method==='card')return command('beginPayment',{orderId:o.id,revision:o.revision,purpose:'creditTopup',amount});
      return command('creditTopup',{orderId:o.id,amount,method,cardConfirmed:form.has('cardConfirmed')});
    },
    'Připsat kredit',r=>{if(r.purpose==='creditTopup')return creditTopup(r);toast(`Kredit dobit o ${fmt(r.amount)} · zůstatek ${fmt(r.balance)}`);customerProfile();}
  );
  const form=$('#dialog-form'),select=form.elements.method,confirm=$('#topup-card-confirm');
  const update=()=>{const card=select.value==='card',localCard=card&&!window.POSCloud;confirm.hidden=!localCard;form.elements.cardConfirmed.required=localCard;form.elements.cardConfirmed.checked=false;$('#dialog-submit').textContent=card&&window.POSCloud?'Připravit platbu kartou':'Připsat kredit';};
  select.addEventListener('change',update);update();
}
function creditReverse(id) {
  const entry=(state.creditLedger||[]).find(x=>x.id===id&&x.type==='topup');if(!entry)return;
  const card=entry.method==='card';
  showDialog('Stornovat dobití kreditu',`<p class="help"><strong>${E(entry.customerName)} · ${fmt(entry.amount)}</strong><br>${date(entry.at)} · ${card?'kartou':'hotově'}</p><p class="help">Vrátí se celé původní dobití. Záznam zůstane v historii. Pro správnou částku potom vytvoř nové dobití.</p>${field('Důvod storna','reason','','required maxlength="120"',true)}${card?'<label class="inline-check"><input type="checkbox" name="cardConfirmed" required>Vratka kartou na terminálu proběhla úspěšně.</label>'+field('Číslo storna / vratky z terminálu','terminalReference','','required maxlength="120"',true):'<p class="help">Vrať zákazníkovi uvedenou hotovost pouze jednou.</p>'}`,f=>command('creditReverse',{entryId:entry.id,reason:f.get('reason'),cardConfirmed:f.has('cardConfirmed'),terminalReference:f.get('terminalReference')||''}),'Potvrdit storno',()=>{toast('Dobití stornované.');customerProfile();});
}
function paymentLabel(r) {
  const parts=[];if(r.cash)parts.push('Hotově');if(r.card)parts.push('Karta');if(r.credit)parts.push('Kredit');
  return parts.length>1?'Kombinovaně · '+parts.join(' + '):(parts[0]||'—');
}
function endVisit() {
  const o=getOrder();if(!customerAccount(o)||!o.visitStartedAt)return;
  const now=new Date().toISOString(),sessions=C.visitSessions(state,o,now),last=sessions[sessions.length-1];
  const activity=C.visitSessions(state,o,now,{ignoreSavedEnd:true}).slice(-1)[0];
  const minimumAt=activity?.lastActivityAt || o.visitStartedAt;
  const d=new Date(Math.max(Date.parse(last?.endedAt||now),Date.parse(minimumAt)));
  const localDate=at=>{const date=new Date(at);return new Date(date.getTime()-date.getTimezoneOffset()*60000).toISOString().slice(0,23);};
  const local=localDate(d),minimum=localDate(minimumAt);
  showDialog('Host odešel',`<p class="help">Ukončí se pouze návštěva zákazníka <strong>${E(o.name)}</strong>. Nezaplacená částka <strong>${fmt(C.sum(o.lines))}</strong> zůstane na jeho účtu.</p><label class="field">Čas odchodu<input type="datetime-local" step="0.001" name="endedAt" min="${E(minimum)}" value="${E(local)}" required></label><p class="help">Čas nesmí předcházet poslední objednávce nebo průběžné platbě. Automaticky předvyplněný konec je odhad podle aktivity.</p>`,f=>command('endVisit',{orderId:o.id,revision:o.revision,endedAt:new Date(String(f.get('endedAt'))).toISOString()}),'Ukončit návštěvu',()=>{render();toast('Návštěva ukončená. Účet zůstává otevřený.');});
}
function productSalesCounts() {
  // Receipts come from the shared confirmed state; never count taps or unpaid orders.
  // Cache per immutable receipt array so typing in search does not rescan history.
  if (salesHistory === state.receipts) return salesCounts;
  const refunded = new Set(state.receipts.filter(r => r.kind === 'refund').map(r => r.refundOf));
  const counts = new Map();
  for (const receipt of state.receipts) {
    if (receipt.kind !== 'sale' || refunded.has(receipt.id)) continue;
    for (const line of receipt.lines) counts.set(line.productId, (counts.get(line.productId) || 0) + line.quantity);
  }
  salesHistory = state.receipts; salesCounts = counts;
  return counts;
}
function renderProducts() {
  const norm = normalizeSearch;
  const activeOrder=getOrder(), counts = productSalesCounts(), personal = customerAccount(activeOrder) ? Customer.productCounts(state,activeOrder.name,activeOrder.customerId||null,activeOrder.id) : null;
  const displayProducts = entryServingMl===20 ? state.products.map(p=>{const portion=C.smallShot(p);return portion?{...p,...portion}:null;}).filter(Boolean) : state.products;
  const products = displayProducts.filter(p => p.active && (query || category === 'Vše' || p.category === category) && norm(p.name+' '+p.serving+' '+(p.sourceCode||'')).includes(norm(query)))
    .sort((a, b) => (personal?.get(b.id) || 0) - (personal?.get(a.id) || 0) || (counts.get(b.id) || 0) - (counts.get(a.id) || 0));
  $('#products').innerHTML = products.map(p => `<button class="product" style="--category:${colors[p.category] || '#a5c99a'}" data-action="add" data-id="${E(p.id)}"><span class="product-cat">${E(p.category)}${p.sourceCode ? ` · #${E(p.sourceCode)}` : ''}</span><span class="product-name">${E(p.name)}</span>${p.serving ? `<span class="product-serving">${E(p.serving)}</span>` : ''}<span class="product-price ${p.price === null ? 'unset' : ''}">${p.price === null ? (p.priceNote ? E(p.priceNote) + ' · zadat cenu' : 'Doplnit cenu') : fmt(p.price)}</span><span class="product-plus">+</span></button>`).join('') + `<button class="product quick-product" data-action="newProduct"><span>+</span>Nová položka</button>`;
}
function renderHistory() {
  const rows = [...state.receipts].reverse().map(r => `<tr><td><strong>${E(r.number)}</strong><br><span class="muted small">${date(r.at)}</span></td><td>${E(C.receiptAccount(state,r).orderName)}${state.receiptAssignments?.[r.id]?`<br><span class="muted small">Původně: ${E(r.orderName)}</span>`:''}<br><span class="tag ${r.kind === 'refund' ? 'orange' : ''}">${r.kind === 'refund' ? 'Vratka' : 'Zaplaceno'}</span></td><td>${paymentLabel(r)}</td><td class="amount">${fmt(r.total)}</td><td class="table-actions">${btn('Doklad','receipt','secondary',`data-id="${E(r.id)}"`)}${r.kind === 'sale' && r.shiftId === C.activeShift(state)?.id && !state.receipts.some(x => x.refundOf === r.id) ? btn('Opravit','restoreReceipt','textbutton',`data-id="${E(r.id)}"`) : ''}</td></tr>`).join('');
  return `<section class="page"><div class="workspace-heading"><div><h1>Doklady</h1><p>${window.POSCloud?'Prodeje, vratky a nákupní faktury celé provozovny.':'Prodeje a vratky z tohoto zařízení.'}</p></div><div class="actions">${window.POSCloud?btn('Nahrát faktury do AI účetního','invoiceUpload','primary'):''}${btn('Export CSV','csv')}</div></div>${window.POSCloud?'<div class="notice"><span><strong>PUB INVOICES · AI účetní</strong><br>Fotky, PDF i více dokladů najednou. AI účetní zkontroluje duplicity, položky, ceny, DPH, obaly a skladové mapování. Nejisté položky zastaví k ověření.</span>'+btn('Otevřít faktury','invoiceUpload','secondary')+'</div>':''}<div class="table-wrap"><table><thead><tr><th>Číslo / čas</th><th>Účet</th><th>Úhrada</th><th class="amount">Částka</th><th></th></tr></thead><tbody>${rows || '<tr><td colspan="5" class="empty">Zatím žádná platba. Doklady se objeví po zaplacení prvního účtu.</td></tr>'}</tbody></table></div></section>`;
}
function renderOverview() {
  const sh = C.activeShift(state), t = sh ? C.totals(state, sh.id) : {total:0,cash:0,card:0,credit:0,count:0,expected:0,opening:0,movements:0,creditTopupCash:0,creditTopupCard:0,creditTopups:0,terminal:0};
  return `<section class="page"><div class="workspace-heading"><div><h1>${sh ? 'Dnešní směna' : 'Přehled směn'}</h1><p>${sh ? `Otevřeno ${date(sh.openedAt)} · ${E(sh.operator)}` : 'Otevři směnu a začni markovat.'}</p></div>${sh ? btn('Uzavřít směnu','closeShift','primary') : btn('Otevřít směnu','openShift','primary')}</div><div class="cards"><div class="stat lime"><span class="eyebrow">Tržba po vratkách</span><strong>${fmt(t.total)}</strong></div><div class="stat"><span class="eyebrow">Hotovostní tržba</span><strong>${fmt(t.cash)}</strong></div><div class="stat"><span class="eyebrow">Karetní tržba</span><strong>${fmt(t.card)}</strong></div><div class="stat"><span class="eyebrow">Kreditní tržba</span><strong>${fmt(t.credit)}</strong></div><div class="stat"><span class="eyebrow">Počet prodejů</span><strong>${t.count}</strong></div></div>${sh ? `<div class="panel"><h3>Hotovost v pokladně</h3><div class="summary-row"><span class="muted">Počáteční vklad</span><strong>${fmt(t.opening)}</strong></div><div class="summary-row"><span class="muted">Prodej hotově</span><strong>${fmt(t.cash)}</strong></div><div class="summary-row"><span class="muted">Dobití kreditu hotově</span><strong>${fmt(t.creditTopupCash)}</strong></div><div class="summary-row"><span class="muted">Vklady a výběry</span><strong>${fmt(t.movements)}</strong></div><div class="summary-row"><span class="muted">Očekávaná hotovost</span><strong>${fmt(t.expected)}</strong></div><div class="actions section-gap">${btn('Vklad / výběr','cashMovement')}${btn('Export CSV','csv')}${btn('Stáhnout zálohu','backup')}</div>${sh.movements.length ? `<div class="section-gap">${sh.movements.map(x => `<div class="summary-row small"><span>${date(x.at)} · ${E(x.reason)}</span><span>${fmt(x.amount)}</span></div>`).join('')}</div>` : ''}</div><div class="panel"><h3>Předplacený kredit</h3><div class="summary-row"><span class="muted">Dobití hotově</span><strong>${fmt(t.creditTopupCash)}</strong></div><div class="summary-row"><span class="muted">Dobití kartou</span><strong>${fmt(t.creditTopupCard)}</strong></div><div class="summary-row"><span class="muted">Celkem dobito</span><strong>${fmt(t.creditTopups)}</strong></div><div class="summary-row"><span class="muted">Tržba zaplacená kreditem</span><strong>${fmt(t.credit)}</strong></div><div class="summary-row"><span class="muted">Terminál celkem včetně dobití</span><strong>${fmt(t.terminal)}</strong></div></div>` : ''}<div class="panel"><h3>Uzavřené směny</h3>${state.shifts.filter(x => x.closedAt).reverse().map(x => `<div class="summary-row"><span>${date(x.openedAt)} → ${date(x.closedAt)}<br><small class="muted">Hotovost ${fmt(x.summary.cash)} · karta ${fmt(x.summary.card)} · kredit ${fmt(x.summary.credit||0)} · dobití ${fmt(x.summary.creditTopups||0)}<br>Hotovost v zásuvce: ${fmt(x.counted)} · rozdíl ${fmt(x.difference)}</small></span><strong>${fmt(x.summary.total)}</strong></div>`).join('') || '<p>Uzávěrky se tu zobrazí po skončení první směny.</p>'}</div></section>`;
}
function renderCatalog() {
  return `<section class="page"><div class="workspace-heading"><div><h1>Nápojový lístek</h1><p>Ceny se do otevřených účtů zpětně nepřepisují.</p></div><div class="actions">${btn('Hromadně vložit','bulkProducts')}${btn('+ Nová položka','newProduct','primary')}</div></div><div class="table-wrap"><table><thead><tr><th>Položka</th><th>Kategorie</th><th>Porce</th><th class="amount">Cena</th><th></th></tr></thead><tbody>${state.products.filter(x => x.active).map(p => `<tr><td><strong>${E(p.name)}</strong>${p.sourceCode ? `<br><span class="muted small">Agnis #${E(p.sourceCode)}</span>` : ''}</td><td>${E(p.category)}</td><td>${E(p.serving) || '—'}</td><td class="amount">${p.price === null ? '<span class="tag orange">Chybí cena</span>' : fmt(p.price)}</td><td class="table-actions">${btn('Upravit','editProduct','secondary',`data-id="${E(p.id)}"`)}${btn('Skrýt','archiveProduct','textbutton',`data-id="${E(p.id)}"`)}</td></tr>`).join('')}</tbody></table></div></section>`;
}
function renderSettings() {
  const s = state.settings;
  if(window.POSCloud)return renderCloudSettings(s);
  return `<section class="page"><div class="workspace-heading"><div><h1>Nastavení pokladny</h1><p>Údaje provozovatele, tisk a zálohy.</p></div></div><form id="settings-form" class="panel"><h3>Údaje na dokladu</h3><div class="form-grid">${field('Název podniku','venue',s.venue,'required maxlength="120"')}${field('Jméno obsluhy','operator',s.operator,'required maxlength="120"')}${field('Provozovatel / firma','company',s.company,'maxlength="120"')}${field('Adresa provozovny','address',s.address,'maxlength="240"')}${field('IČ','ico',s.ico,'maxlength="30"')}${field('DIČ','dic',s.dic,'maxlength="30"')}<label class="field full">Režim DPH<select name="vat"><option value="unknown" ${s.vat==='unknown'?'selected':''}>Zatím nenastaveno — provozní záznam bez rozpisu DPH</option><option value="nonpayer" ${s.vat==='nonpayer'?'selected':''}>Neplátce DPH</option><option value="payer" ${s.vat==='payer'?'selected':''}>Plátce DPH — sazbu nastavím u každé položky</option></select></label></div><div class="form-actions"><button type="submit" class="primary">Uložit údaje</button></div></form><div class="panel"><h3>Zálohy a přenos dat</h3><p>Účty a tržby jsou uložené jen v tomto prohlížeči na tomto zařízení. Mezi PC a telefonem se zatím nesdílejí. Používej stejnou adresu a běžné okno prohlížeče; smazání dat webu smaže i pokladnu.</p><p class="section-gap">Zálohu JSON stáhni po směně. Obnovit ji můžeš v prázdné pokladně. Při přechodu na jiné zařízení přestaň markovat na původním.</p><div class="form-actions">${btn('Stáhnout úplnou zálohu','backup','primary')}${btn('Obnovit ze zálohy','restore')}${btn('Prodeje do CSV','csv')}</div><p class="section-gap small">Poslední vytvořená záloha: ${state.lastBackup ? date(state.lastBackup) : 'zatím žádná'}</p></div><div class="panel"><h3>Tisk a karetní terminál</h3><p>Doklad se tiskne přes tiskový dialog prohlížeče. Pro pokladní tiskárnu zvol papír 80 mm a vypni záhlaví a zápatí. Platbu kartou provedeš na terminálu a teprve po jejím úspěchu ji potvrdíš v pokladně.</p></div><div class="panel"><h3>PUB-BIZZ · další propojení</h3><p>Export zálohy obsahuje stabilní identifikátory položek, prodejů a směn pro další napojení na PUB GURU. Automatický odpis skladu ani synchronizace s ostatními moduly zatím nejsou zapnuté.</p><p class="section-gap small">Pokladna ${E(state.deviceId.slice(0,8).toUpperCase())} · ${state.audit.length} záznamů historie změn</p></div></section>`;
}
function renderCloudSettings(s) {
  return `<section class="page"><div class="workspace-heading"><div><h1>Spojené s PUB GURU</h1><p>${E(POSCloud.user?.email)} · ${E(POSCloud.venue?.name)}</p></div>${btn('Odhlásit se','logout')}</div><form id="settings-form" class="panel"><h3>Údaje na dokladu</h3><div class="form-grid">${field('Název podniku','venue',s.venue,'required maxlength="120"')}${field('Obsluha','operator',s.operator,'required maxlength="120"')}${field('Provozovatel / firma','company',s.company,'maxlength="120"')}${field('Adresa provozovny','address',s.address,'maxlength="240"')}${field('IČ','ico',s.ico,'maxlength="30"')}${field('DIČ','dic',s.dic,'maxlength="30"')}<label class="field full">Režim DPH<select name="vat"><option value="unknown" ${s.vat==='unknown'?'selected':''}>Nenastaveno — provozní záznam bez rozpisu DPH</option><option value="nonpayer" ${s.vat==='nonpayer'?'selected':''}>Neplátce DPH</option><option value="payer" ${s.vat==='payer'?'selected':''}>Plátce DPH — sazba u každé položky</option></select></label></div><div class="form-actions"><button type="submit" class="primary">Uložit údaje</button></div></form><div class="panel"><h3>Společné účty a sklad</h3><p><a href="../pub_guru/index.html#inventory">Otevřít inventuru v PUB GURU ↗</a></p><p>Telefon i počítač používají tutéž provozovnu. Účty se obnovují každé tři sekundy. Platba je hotová až po potvrzení serverem. Receptury nastavíš v části Sklad; nenapojené odpisy zůstávají ve frontě k doplnění.</p><p class="section-gap">Uzavřená směna se objeví také v uzávěrkách PUB GURU ke kontrole. Doklady tiskneš přes prohlížeč. Platbu kartou provedeš na samostatném terminálu.</p></div><div class="panel"><h3>Export a původní místní data</h3><p>Sdílené prodeje jsou uložené na serveru. Můžeš si stáhnout jejich kopii. Data z původní místní pokladny zůstávají v prohlížeči a automaticky se nepřičítají do skladu ani tržeb.</p><div class="form-actions">${btn('Záloha společné pokladny','backup','primary')}${btn('Prodeje CSV','csv')}${btn('Stáhnout původní místní data','localBackup')}</div></div></section>`;
}
function openShift() {
  showDialog('Otevřít směnu', `<p class="help">Kolik hotovosti je teď v zásuvce? Započítá se do kontroly uzávěrky.</p><div class="form-grid">${field('Počáteční hotovost (Kč)','opening','','required inputmode="decimal" placeholder="0"')}${field('Obsluha','operator',state.settings.operator,'required maxlength="120"')}</div>`, async f => {
    const r = await command('openShift', {opening:C.money(f.get('opening')),operator:f.get('operator')});
    navigator.storage?.persist?.().catch(() => {}); return r;
  }, 'Otevřít směnu', () => toast('Směna je otevřená.'));
}
function finishMerge(result) {
  const source=state.orders.find(o=>o.id===result.sourceOrderId);
  setCurrentAccount(result.selected&&source?.lines.length?source.id:result.orderId);accountQuery='';accountSearchOpen=false;render();showProducts();
  toast(`${result.movedQuantity} ks přesunuto na ${result.name}.`);
}
function renameOrder() {
  const o = structuredClone(getOrder());
  if (o.id === 'bar' || o.paymentLock) return;
  showDialog('Přejmenovat stůl / účet', field('Nový název stolu nebo jméno hosta', 'name', o.name, 'required maxlength="120" autocomplete="off"') + '<p class="help section-gap">Položky, zaplacené části a historie tohoto účtu zůstanou zachované.</p>', f => command('renameOrder', {orderId:o.id, revision:o.revision, name:f.get('name')}), 'Přejmenovat', result => {
    setCurrentAccount(result.orderId); accountQuery = ''; accountSearchOpen = false; render();
    toast(`Účet přejmenovaný na ${result.name}.`);
  });
  const input = $('#dialog-form').elements.name; input.focus(); input.select();
}
function mergeOrders() {
  const source = structuredClone(getOrder());
  const targets = structuredClone(state.orders.filter(x => x.id !== source.id));
  if (!source.lines.length || source.paymentLock || !C.activeShift(state)) return;
  showDialog('Spojit účty', `<p class="help">Všechny položky z účtu <strong>${E(source.name)}</strong> se přesunou na vybraný účet. Původní účet zůstane prázdný. Návštěvy a kredit obou hostů zůstávají oddělené; spojení neznamená odchod hosta.</p><label class="field">Spojit s účtem<select name="targetOrderId" required><option value="">Vyber stůl nebo zákazníka</option>${targets.map(o => `<option value="${E(o.id)}" ${o.paymentLock?'disabled':''}>${E(o.name)} · ${fmt(C.sum(o.lines))}${o.paymentLock?' · probíhá platba':''}</option>`).join('')}</select></label><div id="merge-summary" class="payment-summary merge-summary" role="status" aria-live="polite">Vyber účet pro zobrazení společné částky.</div>`, async f => {
    const target = targets.find(o => o.id === f.get('targetOrderId'));
    if (!target || target.paymentLock) throw new Error('Vyber dostupný účet pro spojení.');
    return command('mergeOrders', {orderId:source.id,revision:source.revision,targetOrderId:target.id,targetRevision:target.revision});
  }, 'Spojit účty', finishMerge);
  const select = $('#dialog-form').elements.targetOrderId;
  $('#dialog-submit').disabled = true;
  select.addEventListener('change', () => {
    const target = targets.find(o => o.id === select.value);
    $('#dialog-submit').disabled = !target || !!target.paymentLock;
    $('#merge-summary').innerHTML = target ? `<div class="summary-row"><span>${E(source.name)}</span><strong>${fmt(C.sum(source.lines))}</strong></div><div class="summary-row"><span>${E(target.name)}</span><strong>${fmt(C.sum(target.lines))}</strong></div><div class="summary-row total"><span>Celkem</span><strong>${fmt(C.sum(source.lines)+C.sum(target.lines))}</strong></div><p>Společný účet: <strong>${E(target.name)}</strong></p>` : 'Vyber účet pro zobrazení společné částky.';
  });
}
function transferItems(partial=false) {
  const source=structuredClone(getOrder()),targets=structuredClone(state.orders.filter(o=>o.id!==source.id&&!o.paymentLock));
  if(!source.lines.length||source.paymentLock||!C.activeShift(state)||!targets.length)return;
  if(partial&&!accountActionsReady())throw new Error('Přesun položek čeká na aktualizaci serveru.');
  const quantities=new Map(source.lines.map(l=>[l.id,partial?0:l.quantity]));let targetId='';
  const selected=()=>source.lines.filter(l=>quantities.get(l.id)>0).map(l=>({id:l.id,quantity:quantities.get(l.id)}));
  showDialog(partial?'Přesunout vybrané položky':'Přesunout celý účet',`
    <p class="help">Z účtu <strong>${E(source.name)}</strong>${partial?' vyber položky a počet kusů.':' přesunout všechny položky.'}</p>
    ${partial?'<div id="transfer-items" class="payment-items"></div><div id="transfer-qty-editor" hidden></div>':''}
    <div id="transfer-destination"><h3>Kam přesunout</h3><label class="field transfer-search">Hledat stůl nebo zákazníka<input id="transfer-search" type="search" autocomplete="off" placeholder="Číslo stolu / jméno"></label><div id="transfer-targets" class="transfer-targets"></div><div id="transfer-summary" class="payment-summary" role="status" aria-live="polite"></div></div>`,async()=>{
      const target=targets.find(o=>o.id===targetId);if(!target)throw new Error('Vyber cílový účet.');
      const selection=selected();if(!selection.length)throw new Error('Vyber položky k přesunu.');
      return command('mergeOrders',{orderId:source.id,revision:source.revision,targetOrderId:target.id,targetRevision:target.revision,...(partial?{selected:selection}:{})});
    },'Přesunout',finishMerge);
  const signal=window.paymentAbort.signal;
  function preview() {
    const moving=selected(),amount=source.lines.reduce((n,l)=>n+l.price*quantities.get(l.id),0),target=targets.find(o=>o.id===targetId);
    $('#dialog-submit').disabled=!moving.length||!target;
    $('#transfer-summary').innerHTML=`<div class="summary-row"><span>Přesunout ${moving.reduce((n,l)=>n+l.quantity,0)} ks</span><strong>${fmt(amount)}</strong></div><div class="summary-row"><span>Zůstane u ${E(source.name)}</span><strong>${fmt(C.sum(source.lines)-amount)}</strong></div>${target?`<div class="summary-row total"><span>${E(target.name)} po přesunu</span><strong>${fmt(C.sum(target.lines)+amount)}</strong></div>`:'<p>Vyber cílový účet.</p>'}`;
  }
  function renderTargets() {
    const q=normalizeSearch($('#transfer-search').value),matches=targets.filter(o=>!q||normalizeSearch(o.name).includes(q));
    $('#transfer-targets').innerHTML=matches.map(o=>`<button type="button" class="transfer-target ${o.id===targetId?'selected':''}" data-transfer-target="${E(o.id)}" aria-pressed="${o.id===targetId}"><strong>${E(o.name)}</strong><span>${fmt(C.sum(o.lines))}</span></button>`).join('')||'<p class="help">Žádný dostupný účet.</p>';
  }
  function renderItems() {
    if(!partial)return;
    $('#transfer-items').innerHTML=source.lines.map(l=>`<button type="button" class="payment-item ${quantities.get(l.id)?'selected':''}" data-transfer-line="${E(l.id)}" aria-pressed="${quantities.get(l.id)>0}"><span><strong>${E(l.name)}</strong><small>${E(l.serving)} · ${fmt(l.price)} / ks</small></span><span class="payment-item-count">${quantities.get(l.id)}<small>z ${l.quantity} ks</small></span></button>`).join('');
  }
  function returnToItems() {
    $('#transfer-qty-editor').hidden=true;$('#transfer-qty-editor').innerHTML='';$('#transfer-items').hidden=false;$('#transfer-destination').hidden=false;$('#dialog-submit').hidden=false;$('#dialog .dialog-actions .close-dialog').hidden=false;renderItems();preview();
  }
  $('#transfer-search').addEventListener('input',renderTargets,{signal});
  $('#dialog-body').addEventListener('click',e=>{
    const target=e.target.closest('[data-transfer-target]');if(target){targetId=target.dataset.transferTarget;renderTargets();preview();}
    const item=e.target.closest('[data-transfer-line]');
    if(item){
      const line=source.lines.find(l=>l.id===item.dataset.transferLine),editor=$('#transfer-qty-editor');
      editor.innerHTML=quantityPickerHTML(line.name,quantities.get(line.id)||1,0,line.quantity,true)+'<button type="button" class="secondary qty-return" data-transfer-return>Zpět k položkám</button>';
      editor.hidden=false;$('#transfer-items').hidden=true;$('#transfer-destination').hidden=true;$('#dialog-submit').hidden=true;$('#dialog .dialog-actions .close-dialog').hidden=true;
      bindQuantityPicker(editor,quantities.get(line.id)||1,0,line.quantity,quantity=>{quantities.set(line.id,quantity);returnToItems();});
    }
    if(e.target.closest('[data-transfer-return]'))returnToItems();
  },{signal});
  renderItems();renderTargets();preview();
}
function editProduct(id, addAfter = false, addContext = {orderId:current,quantity:entryQuantity,servingMl:entryServingMl}) {
  const p = state.products.find(x => x.id === id) || {name:'',category:category !== 'Vše' ? category : 'Destiláty',serving:'',price:null,vatRate:null,stockProductId:''};
  showDialog(p.id ? 'Upravit položku' : 'Nová položka', `<div class="form-grid">${field('Název','name',p.name,'required maxlength="120"',true)}${field('Cena v Kč','price',p.price === null ? '' : inputMoney(p.price),'required inputmode="decimal" placeholder="Zadej skutečnou cenu"')}${field('Velikost porce','serving',p.serving,'maxlength="40" placeholder="např. 0,04 l"')}${C.shotVolumeMl(p)===40?field('Cena 2 cl v Kč (prázdné = polovina)','smallShotPrice',p.smallShotPrice==null?'':inputMoney(p.smallShotPrice),'inputmode="decimal" placeholder="Polovina běžné ceny"'):''}<label class="field">Kategorie<input name="category" list="category-list" value="${E(p.category)}" maxlength="40" required><datalist id="category-list">${['Pivo','Destiláty','Nealko','Víno','Koktejly','Káva','Ostatní'].map(x=>`<option>${x}</option>`).join('')}</datalist></label>${field('Sazba DPH (%)','vatRate',p.vatRate ?? '',`type="number" min="0" max="100" step="0.01" ${state.settings.vat === 'payer' ? 'required' : ''} placeholder="Nezadáno"`)}</div>`, async f => {
    const pr = await command('product', {id:p.id,name:f.get('name'),category:f.get('category'),price:C.money(f.get('price')),serving:f.get('serving'),vatRate:f.get('vatRate') === '' ? null : Number(f.get('vatRate')),stockProductId:p.stockProductId,...(f.has('smallShotPrice')?{smallShotPrice:f.get('smallShotPrice')===''?null:C.money(f.get('smallShotPrice'))}:{})});
    return pr;
  }, addAfter && C.activeShift(state) ? 'Uložit a přidat na účet' : 'Uložit položku', async pr => { if (addAfter && C.activeShift(state)) {entryQuantity=1;await command('addLine',{...addContext,productId:pr.id});} toast('Položka uložená.'); });
}
function finishPayment(r) {
  window.paymentAbort?.abort();
  if($('#dialog').open)$('#dialog').close();
  const remaining=state.orders.find(o=>o.id===r.orderId);
  selectAccount(remaining?.lines.length?remaining.id:'bar');
  const catalog=$('.catalog-area');if(catalog)catalog.scrollTop=0;
  if($('#products'))$('#products').scrollTop=0;
  showProducts();
  toast(`Zaplaceno · ${fmt(r.total)}${r.change?` · Vrátit ${fmt(r.change)}`:''}`);
}
function finishPaymentCancellation(orderId) {
  window.paymentAbort?.abort();
  if($('#dialog').open)$('#dialog').close();
  view='pos';selectAccount(orderId);
  toast('Platba zrušená. Položky zůstávají na účtu.');
}
function cancelPayment(o=structuredClone(getOrder())) {
  if(!window.POSCloud||!o.paymentLock)return;
  if(POSCloud.pending||POSCloud.busy){toast('Nejdřív ověř uloženou operaci. Platbu na terminálu neopakuj.',true);return;}
  const {token}=o.paymentLock;
  showDialog('Zrušit rozpracovanou platbu',`<p class="help"><strong>${E(o.name)}</strong> · ${fmt(o.paymentLock.purpose==='creditTopup'?o.paymentLock.amount:C.sum(o.lines))}. Položky zůstanou na účtu a můžeš dál markovat.</p><label class="inline-check"><input type="checkbox" name="checked" required>Potvrzuji, že host nezaplatil hotově ani kartou; stav terminálu jsem ověřil/a.</label>`,f=>{
    if(!f.has('checked'))throw new Error('Nejdřív potvrď, že host nezaplatil.');
    return command('cancelPayment',{orderId:o.id,paymentToken:token,terminalChecked:true,reason:'Zrušení omylem rozpracované platby po ověření obsluhou'});
  },'Zrušit platbu a markovat',()=>finishPaymentCancellation(o.id));
}
async function pay(mode, resume=false) {
  const o=structuredClone(getOrder());if(!o.lines.length)return;
  const delayReservation=window.POSCloud&&mode!=='card'&&!resume;
  let reservation=window.POSCloud?(resume?o.paymentLock:delayReservation?null:await command('beginPayment',{orderId:o.id,revision:o.revision})):null;
  let cardReservation=null,cardReservationFailed=false;
  const operationId=crypto.randomUUID();let partial=mode==='split';
  let paymentMode=partial?'cash':mode,receivedTouched=false,splitTouched=false;
  const selected=()=>o.lines.map(l=>({id:l.id,quantity:Number($('#dialog-form').elements['line-'+l.id].value)})).filter(x=>x.quantity>0);
  const canCredit=!!customerAccount(o);
  showDialog(partial?'Rozdělit účet':mode==='cash'?'Zaplatit hotově':mode==='credit'?'Zaplatit kreditem':'Zaplatit kartou',`
    <p class="help" id="payment-help">${partial?'Klepni na položku a vyber počet kusů. Zbytek zůstane na účtu.':'Zaplatit celý účet, nebo rozdělit jen vybrané položky.'}</p>${!partial?'<button type="button" class="secondary" data-payment-reset>Rozdělit po položkách</button>':''}${resume?'<p class="help">Pokud host už platil, platbu na terminálu neopakuj. Zapiš pouze skutečně zaplacenou část.</p>':''}
    ${o.lines.map(l=>`<input type="hidden" name="line-${E(l.id)}" value="${partial?0:l.quantity}">`).join('')}
    <div class="payment-items" id="payment-items"></div><div id="payment-qty-editor" hidden></div>
    <div class="payment-checkout" id="payment-checkout">
      <div class="payment-methods ${canCredit?'credit-enabled':''}" aria-label="Způsob platby"><button type="button" data-payment-mode="cash">Hotově</button><button type="button" data-payment-mode="card">Kartou</button><button type="button" data-payment-mode="split">Kombinovaně</button>${canCredit?'<button type="button" data-payment-mode="credit">Kredit</button>':''}</div>
      <div class="payment-summary" id="payment-summary"></div>
      <div class="form-grid"><div id="split-cash-field">${field('Z toho hotově (Kč)','splitCash','0','inputmode="decimal"')}</div><div id="received-field">${field('Přijato v hotovosti (Kč)','received','0','inputmode="decimal"')}</div></div>
      <label class="inline-check" id="card-confirm-field"><input type="checkbox" name="cardConfirmed">Platba kartou na terminálu proběhla úspěšně.</label>
    </div>`, async f=>{
      for(const l of o.lines){const q=Number(f.get('line-'+l.id));if(!Number.isSafeInteger(q)||q<0||q>l.quantity)throw new Error('Neplatný počet kusů.');}
      if(cardReservation)await cardReservation;
      if(cardReservationFailed)throw new Error('Platbu se nepodařilo připravit. Zkontroluj uloženou operaci a otevři platbu znovu.');
      if(window.POSCloud&&!reservation) reservation=await command('beginPayment',{orderId:o.id,revision:o.revision});
      return await command('checkout',{orderId:o.id,revision:o.revision,operationId,paymentToken:reservation?.token,selected:selected(),mode:paymentMode,received:['card','credit'].includes(paymentMode)?0:C.money(f.get('received')),splitCash:paymentMode==='split'?C.money(f.get('splitCash')):0,cardConfirmed:f.has('cardConfirmed')});
    },'Potvrdit zaplacení',finishPayment,()=>{
      if(window.POSCloud&&(POSCloud.pending||POSCloud.busy)){
        $('#dialog').close();toast('Nejdřív ověř uloženou operaci. Platbu na terminálu neopakuj.',true);return;
      }
      if(reservation)cancelPayment({...o,paymentLock:reservation});else $('#dialog').close();
    });
  $('#dialog .dialog-actions .close-dialog').textContent='Zrušit platbu';
  $('#dialog').classList.add('payment-dialog');
  const signal=window.paymentAbort.signal,form=$('#dialog-form');
  function prepareCard() {
    if(reservation||cardReservation||cardReservationFailed||signal.aborted)return;
    cardReservation=command('beginPayment',{orderId:o.id,revision:o.revision}).then(r=>{reservation=r;}).catch(e=>{cardReservationFailed=true;if(!signal.aborted)$('#dialog-error').textContent=e.message;}).finally(()=>{cardReservation=null;if(!signal.aborted&&$('#dialog').open)preview();});
  }
  function renderItems() {
    $('#payment-items').innerHTML=o.lines.map(l=>{
      const q=Number(form.elements['line-'+l.id].value);
      return `<button type="button" class="payment-item ${q?'selected':''}" data-payment-line="${E(l.id)}" aria-pressed="${q>0}"><span><strong>${E(l.name)}</strong><small>${E(l.serving)} · ${fmt(l.price)} / ks</small></span><span class="payment-item-count">${q}<small>z ${l.quantity} ks</small></span></button>`;
    }).join('');
  }
  function preview() {
    $('#split-cash-field').hidden=paymentMode!=='split';$('#received-field').hidden=['card','credit'].includes(paymentMode);
    form.elements.splitCash.required=paymentMode==='split';form.elements.received.required=!['card','credit'].includes(paymentMode);
    document.querySelectorAll('[data-payment-mode]').forEach(b=>{const active=b.dataset.paymentMode===paymentMode;b.classList.toggle('active',active);b.setAttribute('aria-pressed',String(active));});
    try{
      const raw=C.sum(C.selectedLines(o,selected()));
      if(paymentMode==='split'&&!splitTouched)form.elements.splitCash.value='0';
      const cash=paymentMode==='cash'?Math.round(raw/100)*100:paymentMode==='split'?C.money(form.elements.splitCash.value):0;
      if(!receivedTouched)form.elements.received.value=inputMoney(cash);
      const received=['card','credit'].includes(paymentMode)?0:C.money(form.elements.received.value),p=C.payment(raw,paymentMode,Math.max(cash,received),cash);
      const cardReady=!window.POSCloud||!p.card||!!reservation;
      form.elements.cardConfirmed.required=p.card>0;$('#card-confirm-field').hidden=p.card===0||!cardReady;
      const balance=canCredit?customerCredit(o):0,creditMissing=Math.max(0,p.credit-balance);
      $('#dialog-submit').disabled=received<cash||creditMissing>0||!cardReady;
      $('#dialog-summary').hidden=false;$('#dialog-summary').innerHTML=`<span>K úhradě · ${selected().reduce((n,l)=>n+l.quantity,0)} ks</span><strong>${fmt(p.total)}</strong>`;
      $('#payment-summary').innerHTML=`<div class="summary-row total"><span>K úhradě</span><strong>${fmt(p.total)}</strong></div>${p.rounding?`<div class="summary-row"><span>Zaokrouhlení</span><span>${fmt(p.rounding)}</span></div>`:''}${paymentMode==='split'?`<div class="summary-row"><span>Na terminálu</span><strong>${fmt(p.card)}</strong></div>`:''}${paymentMode==='credit'?`<div class="summary-row"><span>Kredit před platbou</span><strong>${fmt(balance)}</strong></div><div class="summary-row"><span>${creditMissing?'Na kreditu chybí':'Kredit po platbě'}</span><strong>${fmt(creditMissing||balance-p.credit)}</strong></div>`:paymentMode!=='card'?`<div class="summary-row"><span>${received<cash?'Ještě chybí':'Vrátit hostovi'}</span><strong>${fmt(Math.abs(received-cash))}</strong></div>`:'<span class="muted small">Částku zadej na samostatném terminálu.</span>'}`;
      if(!cardReady){$('#payment-summary').innerHTML+='<p class="help">Nejdřív připravujeme rezervaci. Zatím neprováděj platbu na terminálu.</p>';prepareCard();}
    }catch(e){$('#payment-summary').textContent=e.message;$('#dialog-summary').hidden=false;$('#dialog-summary').textContent='Vyber položky k zaplacení';$('#dialog-submit').disabled=true;form.elements.cardConfirmed.required=false;$('#card-confirm-field').hidden=true;}
  }
  function returnToItems() {
    $('#payment-qty-editor').hidden=true;$('#payment-qty-editor').innerHTML='';$('#payment-items').hidden=false;$('#payment-checkout').hidden=false;
    $('#dialog-submit').hidden=false;$('#dialog .dialog-actions .close-dialog').hidden=false;
    renderItems();preview();scrollDialogTop();
  }
  $('#dialog-body').addEventListener('click',e=>{
    const item=e.target.closest('[data-payment-line]');
    if(item){
      const l=o.lines.find(x=>x.id===item.dataset.paymentLine);if(!l)return;
      const q=Number(form.elements['line-'+l.id].value),editor=$('#payment-qty-editor');
      editor.innerHTML=quantityPickerHTML(l.name,q||1,0,l.quantity,true)+'<button type="button" class="secondary qty-return" data-return-payment>Zpět k položkám</button>';
      editor.hidden=false;$('#payment-items').hidden=true;$('#payment-checkout').hidden=true;$('#dialog-submit').hidden=true;$('#dialog .dialog-actions .close-dialog').hidden=true;
      $('#dialog-summary').hidden=true;scrollDialogTop();
      bindQuantityPicker(editor,q||1,0,l.quantity,quantity=>{form.elements.cardConfirmed.checked=false;form.elements['line-'+l.id].value=String(quantity);returnToItems();});
    }
    if(e.target.closest('[data-payment-reset]')){partial=true;for(const l of o.lines)form.elements['line-'+l.id].value='0';form.elements.cardConfirmed.checked=false;$('#dialog-title').textContent='Rozdělit účet';$('#payment-help').textContent='Klepni na položku a vyber počet kusů. Zbytek zůstane na účtu.';e.target.closest('[data-payment-reset]').hidden=true;renderItems();preview();}
    const method=e.target.closest('[data-payment-mode]');
    if(method){paymentMode=method.dataset.paymentMode;receivedTouched=false;splitTouched=false;form.elements.cardConfirmed.checked=false;preview();}
    if(e.target.closest('[data-return-payment]'))returnToItems();
  },{signal});
  $('#dialog-body').addEventListener('input',e=>{
    if(e.target.name!=='cardConfirmed')form.elements.cardConfirmed.checked=false;
    if(e.target.name==='received')receivedTouched=true;
    if(e.target.name==='splitCash')splitTouched=true;
    preview();
  },{signal});
  renderItems();preview();
}
function receiptHTML(r) {
  const s=r.settings, sign=r.kind==='refund'?-1:1, vat={};
  for(const l of r.lines){if(l.vatRate!==null){const key=String(l.vatRate); const gross=l.price*l.quantity*sign; const tax=Math.round(gross*l.vatRate/(100+l.vatRate)); const v=vat[key]||(vat[key]={base:0,tax:0}); v.base+=gross-tax;v.tax+=tax;}}
  return `<div class="receipt-preview"><header><h3>${E(s.venue)}</h3>${s.company?`<div>${E(s.company)}</div>`:''}${s.address?`<div>${E(s.address)}</div>`:''}${s.ico?`<div>IČ: ${E(s.ico)}${s.dic?' · DIČ: '+E(s.dic):''}</div>`:''}<div class="section-gap">${r.kind==='refund'?'VRATKA':'PRODEJNÍ DOKLAD'} ${E(r.number)}</div><div>${date(r.at)} · ${E(r.operator)}</div><div>${E(r.orderName)}</div></header><hr><table><tbody>${r.lines.map(l=>`<tr><td>${l.quantity}× ${E(l.name)} ${E(l.serving)}<br><span class="muted">${fmt(l.price)} / ks</span></td><td class="amount">${fmt(l.price*l.quantity*sign)}</td></tr>`).join('')}</tbody></table><hr>${r.rounding?`<div class="summary-row"><span>Zaokrouhlení</span><span>${fmt(r.rounding)}</span></div>`:''}<div class="summary-row total"><span>Celkem</span><strong>${fmt(r.total)}</strong></div>${r.cash?`<div class="summary-row"><span>Hotově</span><span>${fmt(r.cash)}</span></div>`:''}${r.card?`<div class="summary-row"><span>Kartou</span><span>${fmt(r.card)}</span></div>`:''}${r.credit?`<div class="summary-row"><span>Kredit</span><span>${fmt(r.credit)}</span></div>`:''}${r.change?`<div class="summary-row"><span>Přijato / vráceno</span><span>${fmt(r.received)} / ${fmt(r.change)}</span></div>`:''}${s.vat==='payer'?`<hr>${Object.entries(vat).map(([rate,v])=>`<div class="small">DPH ${E(rate)} % · základ ${fmt(v.base)} · daň ${fmt(v.tax)}</div>`).join('')}`:''}${r.reason?`<p class="section-gap">Důvod vratky: ${E(r.reason)}</p>`:''}${r.terminalConfirmation?`<p class="small">Ověření vratky na terminálu: ${E(r.terminalConfirmation.reference)} · ${date(r.terminalConfirmation.at)}</p>`:''}${state.receiptAssignments?.[r.id]?`<p class="small">Aktuální přiřazení: ${E(C.receiptAccount(state,r).orderName)} · ${date(state.receiptAssignments[r.id].at)}</p>`:''}<div class="footnote">${s.vat==='unknown'?'Provozní záznam — režim DPH není nastaven.':s.vat==='nonpayer'?'Provozovatel není plátcem DPH.':''}${!s.company||!s.ico||!s.address?'<br>Údaje provozovatele nejsou kompletní.':''}<br>PUB-BIZZ · Děkujeme za návštěvu.</div></div>`;
}
function receiptDialog(r) { showDialog(r.kind==='refund'?'Vratka uložená':'Zaplaceno',receiptHTML(r),async()=>{ $('#print-area').innerHTML=receiptHTML(r); window.print(); },'Vytisknout doklad'); }
function terminalRefundFields(r) {
  return r.card>0?`${field('Číslo storna / vratky z terminálu','terminalReference','','required maxlength="120" autocomplete="off"')}<label class="inline-check"><input type="checkbox" name="cardConfirmed" required>Na terminálu jsem ověřil/a úspěšné vrácení ${fmt(r.card)}.</label>`:'';
}
function finishReceiptCorrection(r) {
  window.paymentAbort?.abort();if($('#dialog').open)$('#dialog').close();
  if(r.restoredToOrderId){setCurrentAccount(r.restoredToOrderId);accountQuery='';accountSearchOpen=false;view='pos';render();toast(`Platba vrácena. Položky jsou na ${r.restoredToOrderName||r.orderName}.`);}
  else {view='history';render();toast(`Doklad přiřazen k ${r.orderName}. Platba zůstává zaplacená.`);}
}
function receiptCorrection(id) {
  const r=state.receipts.find(x=>x.id===id);if(!r)return;
  const account=C.receiptAccount(state,r), manager=!window.POSCloud||['owner','manager'].includes(POSCloud.meta.role||POSCloud.venue?.role);
  showDialog('Opravit doklad',`<p class="help">${E(r.number)} · ${fmt(r.total)} · ${E(account.orderName)}</p>${manager?'<label class="field">Co opravit<select name="correction"><option value="reassign">Změnit stůl — platba zůstává</option><option value="restore">Vrátit platbu a položky na stůl</option></select></label>':''}<div id="receipt-assignment"><label class="field">Správný stůl / zákazník<select name="targetOrderId" required><option value="">Vyber účet</option>${state.orders.filter(o=>o.id!==account.orderId).map(o=>`<option value="${E(o.id)}">${E(o.name)}</option>`).join('')}</select></label><p class="help">Doklad zůstane zaplacený. Položky se znovu neúčtují.</p></div>${manager?`<fieldset id="receipt-reversal" hidden disabled><p class="help">${r.cash?`Nejprve vrať ${fmt(r.cash)} hotově. `:''}${r.card?`Nejprve zruš nebo vrať ${fmt(r.card)} na terminálu a ověř výsledek. `:''}${r.credit?`Kredit ${fmt(r.credit)} se vrátí zákazníkovi. `:''}Poté se celá platba stornuje a položky budou znovu k zaplacení na ${E(account.orderName)}.</p>${field('Důvod vratky','reason','','required maxlength="120"')}${terminalRefundFields(r)}</fieldset>`:'<p class="help">Skutečnou vratku může zapsat vedoucí nebo majitel.</p>'}`,f=>f.get('correction')==='restore'?command('restoreReceipt',{receiptId:id,reason:f.get('reason'),cardConfirmed:f.has('cardConfirmed'),terminalReference:f.get('terminalReference')}):command('reassignReceipt',{receiptId:id,targetOrderId:f.get('targetOrderId'),previousOrderId:account.orderId,reason:'Oprava přiřazení účtu'}),'Změnit stůl',finishReceiptCorrection);
  const form=$('#dialog-form');
  form.elements.correction?.addEventListener('change',()=>{
    const financial=form.elements.correction.value==='restore';
    $('#receipt-assignment').hidden=financial;form.elements.targetOrderId.disabled=financial;
    $('#receipt-reversal').hidden=!financial;$('#receipt-reversal').disabled=!financial;
    if(form.elements.cardConfirmed)form.elements.cardConfirmed.checked=false;
    if(form.elements.terminalReference)form.elements.terminalReference.value='';
    $('#dialog-submit').textContent=financial?'Zapsat vratku a vrátit na stůl':'Změnit stůl';
  });
}
function download(name,content,type){ const url=URL.createObjectURL(new Blob([content],{type})); const a=document.createElement('a');a.href=url;a.download=name;document.body.append(a);a.click();a.remove();setTimeout(()=>URL.revokeObjectURL(url),60000); }
async function downloadBackup(s,prefix='PUB-BIZZ-zaloha') {
  const data=JSON.stringify(s),hash=Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(data)))).map(x=>x.toString(16).padStart(2,'0')).join('');
  download(`${prefix}-${new Date().toISOString().replace(/[:.]/g,'-')}.json`,JSON.stringify({format:'pubbizz.pos.backup.v1',hash,data:s},null,2),'application/json');
}
async function backup(){await downloadBackup(await Store.read());if(!window.POSCloud||POSCloud.meta.role!=='accountant')await command('backup',{});toast('Záloha připravená ke stažení.');}

function csv(){
  const cell=v=>{let s=String(v??''); if(/^[=+\-@\t\r]/.test(s))s="'"+s;return '"'+s.replaceAll('"','""')+'"';};
  const rows=[['doklad','datum','typ','ucet','polozka','porce','pocet','cena_kc','celkem_polozka_kc','dph_procent','doklad_hotove_kc','doklad_karta_kc','doklad_kredit_kc','doklad_zaokrouhleni_kc','směna_id','produkt_id','sklad_id','prirazeny_ucet']];
  for(const r of state.receipts)r.lines.forEach((l,i)=>rows.push([r.number,r.at,r.kind,r.orderName,l.name,l.serving,l.quantity*(r.kind==='refund'?-1:1),inputMoney(l.price),inputMoney(l.price*l.quantity*(r.kind==='refund'?-1:1)),l.vatRate??'',i===0?inputMoney(r.cash):'',i===0?inputMoney(r.card):'',i===0?inputMoney(r.credit||0):'',i===0?inputMoney(r.rounding):'',r.shiftId,l.productId,l.stockProductId,C.receiptAccount(state,r).orderName]));
  download(`PUB-BIZZ-prodeje-${new Date().toISOString().slice(0,10)}.csv`,'\uFEFF'+rows.map(r=>r.map(cell).join(';')).join('\r\n'),'text/csv;charset=utf-8');toast('CSV připravené ke stažení.');
}
function closeShift(){ const sh=C.activeShift(state);if(!sh)return;
  if(state.orders.some(x=>x.paymentLock)){toast('Nejdřív dokonči nebo uvolni všechny rozpracované platby.',true);return;}
  const blocked=state.orders.filter(x=>x.lines.length&&!C.customerLike(x.name));
  if(blocked.length){toast('Nejdřív doplať rychlý prodej a běžné stoly. Pojmenovaný zákazník může zůstat nezaplacený.',true);return;}
  const debts=state.orders.filter(x=>x.lines.length&&C.customerLike(x.name)).map(x=>({name:x.name,amount:C.sum(x.lines),items:x.lines.reduce((n,l)=>n+l.quantity,0)}));
  const debtTotal=debts.reduce((n,x)=>n+x.amount,0),t=C.totals(state,sh.id);
  showDialog('Uzavřít směnu',`<div class="payment-summary"><div class="summary-row"><span>Tržba celkem</span><strong>${fmt(t.total)}</strong></div><div class="summary-row"><span>Hotově</span><strong>${fmt(t.cash)}</strong></div><div class="summary-row"><span>Kartou</span><strong>${fmt(t.card)}</strong></div><div class="summary-row"><span>Kreditem</span><strong>${fmt(t.credit)}</strong></div><hr><div class="summary-row"><span>Dobití kreditu hotově</span><strong>${fmt(t.creditTopupCash)}</strong></div><div class="summary-row"><span>Dobití kreditu kartou</span><strong>${fmt(t.creditTopupCard)}</strong></div><div class="summary-row"><span>Terminál celkem</span><strong>${fmt(t.terminal)}</strong></div><div class="summary-row"><span>Očekávaná hotovost</span><strong>${fmt(t.expected)}</strong></div></div>${debts.length?`<div class="panel debt-summary"><h3>Neuhrazené účty · nejsou v tržbě</h3>${debts.map(d=>`<div class="summary-row"><span>${E(d.name)} · ${d.items} ks</span><strong>${fmt(d.amount)}</strong></div>`).join('')}<div class="summary-row total"><span>Celkem nezaplaceno</span><strong>${fmt(debtTotal)}</strong></div><p class="help">Tyto účty zůstanou otevřené do další směny. Spotřebu zapíše samostatná výdejka; chybějící receptury nebo zásoby zůstanou ve Skladu ke kontrole. Doplacení už vydané porce znovu neodepíše.</p></div>`:''}${field('Spočítaná hotovost v zásuvce (Kč)','counted','','required inputmode="decimal"')}<p class="help section-gap">Dobití kreditu je oddělené od tržby za nápoje, aby se peníze nezapočítaly dvakrát.</p>`,f=>command('closeShift',{counted:C.money(f.get('counted'))}),'Uzavřít a zálohovat',async()=>{view='overview';render();await backup();});}
function checkPayment(){
  const o=structuredClone(getOrder()),creditOption=customerAccount(o)?'<option value="credit">Pokračovat v platbě kreditem</option>':'';
  if(o.paymentLock?.purpose==='creditTopup'){
    showDialog('Rozpracované dobití kreditu',`<p class="help">${E(o.name)} · ${fmt(o.paymentLock.amount)} kartou. Ověř stav terminálu; úspěšnou platbu neopakuj.</p><label class="field">Co provést<select name="operation"><option value="complete">Dokončit zápis dobití</option><option value="cancel">Host nezaplatil — uvolnit účet</option></select></label><label class="inline-check"><input type="checkbox" name="checked" required>Stav platby jsem zkontroloval/a.</label>`,async f=>{if(f.get('operation')==='cancel')await command('cancelPayment',{orderId:o.id,paymentToken:o.paymentLock.token,terminalChecked:f.has('checked'),reason:'Ověřené zrušení nepřijatého dobití'});return f.get('operation');},'Pokračovat',operation=>{if(operation==='complete')creditTopup(o.paymentLock);});return;
  }
  showDialog('Rozpracovaná platba',`<p class="help">Ověř u obsluhy a na terminálu, zda už host platil. Pokud už platba proběhla, platbu na terminálu neopakuj.</p><label class="field">Co provést<select name="operation"><option value="cash">Pokračovat v hotovostní platbě</option><option value="card">Pokračovat v karetní platbě</option><option value="split">Pokračovat v rozdělení účtu</option>${creditOption}<option value="cancel">Host nezaplatil — uvolnit účet</option></select></label><label class="inline-check"><input type="checkbox" name="checked" required>Stav platby jsem zkontroloval/a.</label>`,async f=>{
    if(f.get('operation')==='cancel')await command('cancelPayment',{orderId:o.id,paymentToken:o.paymentLock.token,terminalChecked:f.has('checked'),reason:'Obsluha ověřila, že host nezaplatil'});
    return f.get('operation');
  },'Pokračovat',operation=>{if(operation!=='cancel')return pay(operation,true);});
}
function bulkProducts(){showDialog('Hromadně vložit ceník',`<p class="help">Každý řádek: <strong>název; cena; kategorie; porce; DPH</strong>. Poslední tři údaje lze vynechat. Existující položky se shodným názvem a porcí se aktualizují.</p><label class="field">Položky<textarea name="rows" rows="9" required placeholder="Název nápoje; cena v Kč; kategorie; porce; DPH %"></textarea></label>`,async f=>{const rows=String(f.get('rows')).split(/\r?\n/).filter(x=>x.trim());if(rows.length>300)throw new Error('Najednou lze vložit nejvýš 300 položek.');const items=rows.map((row,i)=>{const [name,price,category='Ostatní',serving='',rate='']=row.split(';').map(x=>x.trim());if(!name||!price)throw new Error(`Na řádku ${i+1} chybí název nebo cena.`);return {name,price:C.money(price),category,serving,vatRate:rate===''?null:Number(rate.replace(',','.'))};});await command('importProducts',{items});},'Uložit ceník',()=>toast('Ceník byl uložený.'));}
const actions={
  syncDetails,dismissMarking:id=>{POSCloud.dismiss(id);$('#dialog').close();toast('Odmítnutá změna uzavřená podle serveru.');},
  quantityPad:id=>quantityPad(id),
  entryCount:id=>{entryQuantity=Number(id);updateEntryContext();},entryQuantity:entryQuantityPad,
  smallShot:()=>{entryServingMl=entryServingMl===20?undefined:20;if(entryServingMl===20){const shots=state.products.filter(p=>p.active&&C.smallShot(p));if(!shots.some(p=>p.category===category))category='Vše';if(query&&!shots.some(p=>normalizeSearch(p.name+' '+p.serving+' '+(p.sourceCode||'')).includes(normalizeSearch(query))))query='';}updateProductFilters();},
  account:id=>selectAccount(id),customerProfile,creditTopup,creditReverse,endVisit,category:async id=>{category=id;query='';updateProductFilters();},openShift,renameOrder,mergeOrders,undoLast,moveAccount:()=>transferItems(false),moveItems:()=>transferItems(true),
  newOrder:()=>showDialog('Nový účet',field('Stůl nebo jméno hosta (nepovinné)','name',accountQuery.trim(),'maxlength="120" placeholder="Bez vyplnění = rychlý prodej"'),f=>{
    const name=String(f.get('name')||'').trim();
    return name?command('newOrder',{name}):{id:'bar'};
  },'Pokračovat',r=>selectAccount(r.id)),
  deleteOrder:async()=>{await command('deleteOrder',{orderId:current});setCurrentAccount('bar');render();},
  add:async (id,button)=>{const p=state.products.find(x=>x.id===id);if(!p)return;const fromCatalog=button?.classList.contains('product'),quantity=fromCatalog?entryQuantity:1,servingMl=fromCatalog?entryServingMl:button?.dataset.servingMl==='20'?20:undefined,orderId=current;if(p.price===null){editProduct(id,true,{orderId,quantity,servingMl});return;}if(!C.activeShift(state)){openShift();return;}entryQuantity=1;updateEntryContext();await command('addLine',{orderId,productId:id,quantity,servingMl},true);},
  minus:async id=>{await command('removeLine',{orderId:current,lineId:id,reason:'Oprava namarkování'},true);},
  newProduct:()=>editProduct(),editProduct:id=>editProduct(id),archiveProduct:id=>showDialog('Skrýt položku',`<p class="help">${E(state.products.find(x=>x.id===id)?.name)} zmizí z nabídky. Existující účty a doklady zůstanou.</p>`,()=>command('archiveProduct',{id}),'Skrýt'),
  checkPayment,
  payCash:()=>pay('cash'),payCard:()=>pay('card'),payCredit:()=>pay('credit'),paySplit:()=>pay('split',!!getOrder().paymentLock),cancelPayment:()=>cancelPayment(),
  receipt:id=>receiptDialog(state.receipts.find(x=>x.id===id)),
  restoreReceipt:receiptCorrection,
  refund:id=>{const r=state.receipts.find(x=>x.id===id);showDialog('Vrátit celý doklad',`<p class="help">Doklad ${E(r.number)} · ${fmt(r.total)}. Vrací se stejným způsobem jako původní platba. Vratka se uloží samostatně.</p>${field('Důvod vratky','reason','','required maxlength="120"')}${window.POSCloud?'<label class="inline-check"><input type="checkbox" name="restock">Zboží se fyzicky vrátilo a chci ho vrátit na sklad.</label>':''}${terminalRefundFields(r)}`,f=>command('refund',{receiptId:id,reason:f.get('reason'),cardConfirmed:f.has('cardConfirmed'),terminalReference:f.get('terminalReference'),restock:f.has('restock')}),'Zapsat vratku',receiptDialog);},
  cashMovement:()=>showDialog('Vklad / výběr hotovosti',`<div class="form-grid"><label class="field">Pohyb<select name="direction"><option value="1">Vklad do pokladny</option><option value="-1">Výběr z pokladny</option></select></label>${field('Částka v Kč','amount','','required inputmode="decimal"')}${field('Důvod','reason','','required maxlength="120"',true)}</div>`,f=>command('cashMovement',{amount:C.money(f.get('amount'))*Number(f.get('direction')),reason:f.get('reason')}),'Zapsat pohyb'),
  recipe:id=>POSStockUI.edit(state,id,showDialog,command,toast),
  resolveStock:id=>{const [receiptId,lineId]=id.split(':');showDialog('Doplnit skladový odpis','<p class="help">Provede se odpis podle nyní nastavené receptury k původnímu prodeji. U stejného řádku ho nelze provést dvakrát.</p>',()=>command('resolveStock',{receiptId,lineId}),'Provést odpis',()=>toast('Odpis byl zpracovaný.'));},
  retryPending:async()=>{const pending=POSCloud.pending,r=await POSCloud.retry();state=r.state;render();if(r.result?.kind==='sale')finishPayment(r.result);else if(r.result?.restoredToOrderId||r.result?.type==='reassignReceipt')finishReceiptCorrection(r.result);else if(r.result?.kind)receiptDialog(r.result);else if(r.result?.type==='mergeOrders')finishMerge(r.result);else if(pending?.type==='cancelPayment')finishPaymentCancellation(pending.payload.orderId);else toast('Operace ověřená.');},
  invoiceUpload:()=>{ location.href='../pub_guru/invoice-capture.html'; },
  logout:()=>POSCloud.logout(),
  showBill:()=>{mobileBillOpen=true;updateMobileBill();$('.receipt')?.scrollIntoView({behavior:'auto',block:'start'});},showProducts,
  localBackup:async()=>{const local=await POSCloud.localBackup();await downloadBackup(local,'PUB-BIZZ-stara-mistni-data');toast('Místní data připravená ke stažení.');},
  closeShift,backup,csv,bulkProducts,restore:()=>$('#restore-input').click()
};
function setNavigationOpen(open, focus = false) {
  $('.topbar').classList.toggle('menu-open', open);
  $('#nav-toggle').setAttribute('aria-expanded', String(open));
  if (focus && window.innerWidth <= 630) $('#nav-toggle').focus();
}
document.addEventListener('keydown', e => {
  if(e.key === 'Escape' && $('.topbar').classList.contains('menu-open')) { setNavigationOpen(false, true); e.preventDefault(); }
});
document.addEventListener('click',async e=>{
  if(accountSearchOpen&&!e.target.closest('.account-finder')){accountSearchOpen=false;renderAccountResults();}
  if(e.target.closest('#nav-toggle')) { setNavigationOpen(!$('.topbar').classList.contains('menu-open')); return; }
  if(!e.target.closest('#main-nav'))setNavigationOpen(false);
  const close=e.target.closest('.close-dialog');if(close){closeDialog();return;}
  const tab=e.target.closest('[data-view]');if(tab){view=tab.dataset.view;setNavigationOpen(false, true);render();return;}
  const b=e.target.closest('[data-action]');if(!b||b.disabled||!state)return;
  const action=actions[b.dataset.action];if(action)try{await action(b.dataset.id,b);}catch(err){toast(err.message||'Operace se nepodařila.',true);}
});
$('#dialog').addEventListener('cancel',e=>{e.preventDefault();closeDialog();});
$('#fullscreen').addEventListener('click',async()=>{try{if(document.fullscreenElement)await document.exitFullscreen();else if(document.documentElement.requestFullscreen)await document.documentElement.requestFullscreen();else toast('Na telefonu přidej pokladnu na plochu z nabídky prohlížeče.');}catch{toast('Prohlížeč celoobrazovkový režim nepovolil.',true);}});
$('#restore-input').addEventListener('change',async e=>{
  const file=e.target.files?.[0];e.target.value='';if(!file)return;
  try{if(file.size>20000000)throw new Error('Záloha je příliš velká (maximum 20 MB).');const wrapper=JSON.parse(await file.text());if(wrapper.format!=='pubbizz.pos.backup.v1')throw new Error('Tohle není záloha PUB-BIZZ.');const hash=Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(JSON.stringify(wrapper.data))))).map(x=>x.toString(16).padStart(2,'0')).join('');if(hash!==wrapper.hash)throw new Error('Kontrolní součet nesedí. Soubor je změněný nebo poškozený.');C.validate(wrapper.data);showDialog('Obnovit pokladnu',`<p class="help">Záloha: <strong>${E(wrapper.data.settings.venue)}</strong><br>${wrapper.data.receipts.length} dokladů · ${wrapper.data.products.length} položek.<br>Po obnově používej pouze toto zařízení.</p>`,async()=>{const r=await Store.restore(wrapper.data);state=r.state;setCurrentAccount('bar');render();},'Obnovit zálohu',()=>toast('Záloha byla obnovená.'));}catch(err){toast(err.message,true);}
});
window.addEventListener('pos-connection',connection);
window.addEventListener('online',connection);window.addEventListener('offline',connection);
async function refresh(){if(state){try{const next=await Store.read();if(window.POSCloud?next!==state:next.revision!==state.revision){const fast=view==='pos'&&next.receipts.length===state.receipts.length&&JSON.stringify(next.products)===JSON.stringify(state.products)&&JSON.stringify(next.settings)===JSON.stringify(state.settings);state=next;fast?renderPOSFast():render();}}catch{toast('Nepodařilo se načíst uložená data.',true);}}}
window.addEventListener('focus',refresh);
window.addEventListener('resize',()=>{if(window.innerWidth>630)setNavigationOpen(false);resizePOSWorkspace();});
window.visualViewport?.addEventListener('resize',resizePOSWorkspace);
(async()=>{
  document.querySelectorAll('[data-cloud]').forEach(x=>x.hidden=!window.POSCloud);
  try{
    window.POSRuntime?.assertReady();
    if(window.POSBootError)throw window.POSBootError;
    if(!C||!Store||(!document.documentElement.dataset.standalone&&!window.POSCloud))throw new Error('Sdílená pokladna se nenačetla. Obnov stránku a zkontroluj připojení.');
    state=await Store.open(refresh);C.validate(state);const selected=window.POSCloud?.selectedOrder||'bar';setCurrentAccount(state.orders.some(o=>o.id===selected)?selected:'bar');render();connection();
    if(window.POSCloud?.meta.recoveredResult?.kind==='sale')finishPayment(POSCloud.meta.recoveredResult);
    else if(window.POSCloud?.meta.recoveredResult?.restoredToOrderId||window.POSCloud?.meta.recoveredResult?.type==='reassignReceipt')finishReceiptCorrection(POSCloud.meta.recoveredResult);
    else if(window.POSCloud?.meta.recoveredResult?.kind)receiptDialog(POSCloud.meta.recoveredResult);
    else if(window.POSCloud?.meta.recoveredResult?.type==='mergeOrders')finishMerge(POSCloud.meta.recoveredResult);
    else if(window.POSCloud?.meta.recoveryMessage)toast(POSCloud.meta.recoveryMessage,true);
    if(document.documentElement.dataset.standalone){$('#offline-status').textContent='Samostatná offline verze · data tohoto prohlížeče';}
    else if('serviceWorker' in navigator){try{await navigator.serviceWorker.register('./sw.js');await navigator.serviceWorker.ready;$('#offline-status').textContent=window.POSCloud?'Markování i bez internetu · platby po potvrzení serveru':'Připraveno i bez internetu · jedno zařízení';}catch{$('#offline-status').textContent=window.POSCloud?'Sdílené účty · PUB GURU':'Offline spuštění není připravené · data zůstávají místní';}}
  }catch(e){
    if(window.POSRuntime)window.POSRuntime.fail(e.message);
    else{$('#app').innerHTML=`<div class="panel"><h1>Pokladnu nelze otevřít</h1><p class="error">${E(e.message)}</p><p class="section-gap">Nic nemaž. Obnov stránku nebo použij aktuální Firefox ESR 115 na Windows 7.</p></div>`;$('#save-state').textContent='Pokladna není připravená';}
  }
})();

