/* Shared online register; standalone HTML keeps the separate local emergency mode. */
'use strict';
const C = POSCore, Store = POSStore;
const $ = s => document.querySelector(s);
const escapeHTML = value => String(value ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const E = escapeHTML;
const fmt = n => new Intl.NumberFormat('cs-CZ', { style:'currency', currency:'CZK', maximumFractionDigits:n % 100 ? 2 : 0 }).format(n / 100);
const inputMoney = n => String(n / 100).replace('.', ',');
const date = d => new Date(d).toLocaleString('cs-CZ', {timeZone:'Europe/Prague', day:'2-digit',month:'2-digit',hour:'2-digit',minute:'2-digit'});
const colors = {'Pivo':'#f1c986','Destiláty':'#b1bcf3','Nealko':'#8acbb6','Víno':'#dbabd6','Koktejly':'#efaa91','Likéry':'#b6c49f','Rumy':'#daba8b','Whisky':'#e2b46a','Brandy':'#e3aa9e','Teplé nápoje':'#c6ba91','Snacks':'#98b8df'};
let state, view = 'pos', current = 'bar', category = 'Pivo', query = '', toastTimer, submitting = false;
let accountQuery = '', accountSearchOpen = false, entryQuantity = 1;
const normalizeSearch = value => String(value).toLocaleLowerCase('cs').normalize('NFD').replace(/[\u0300-\u036f]/g, '').trim();
const getOrder = () => state.orders.find(x => x.id === current) || state.orders[0];
const btn = (label, action, cls = 'secondary', attrs = '') => `<button type="button" class="${cls}" data-action="${action}" ${attrs}>${label}</button>`;
function toast(message, bad = false) { const t = $('#toast'); t.textContent = message; t.className = `toast visible${bad ? ' bad' : ''}`; clearTimeout(toastTimer); toastTimer = setTimeout(() => t.className = 'toast', 4200); }
async function command(type, payload, fast = false) {
  $('#save-state').textContent = 'Ukládám…';
  try { const response = await Store.command(type, payload); state = response.state; fast && view === 'pos' ? renderPOSFast() : render(); return response.result; }
  catch (e) { $('#save-state').textContent = window.POSCloud?.pending ? 'Výsledek zatím nepotvrzený' : 'Změna nebyla uložena'; $('#save-state').classList.add('error'); throw e; }
}
function renderPOSFast(){
  if(view!=='pos'||!state)return render();
  const shell=document.createElement('div');shell.innerHTML=renderPOS();
  const fresh=shell.firstElementChild, live=$('.pos-layout');
  if(!fresh||!live)return render();
  const nextAccounts=fresh.querySelector('.accounts'),nextReceipt=fresh.querySelector('.receipt');
  const accounts=live.querySelector('.accounts'),receipt=live.querySelector('.receipt');
  if(accounts&&nextAccounts)accounts.replaceWith(nextAccounts);
  if(receipt&&nextReceipt)receipt.replaceWith(nextReceipt);
  updateEntryContext();
  if(accountSearchOpen)renderAccountResults();
  const bill=$('#mobile-bill');if(bill)bill.innerHTML=`<span>${E(getOrder().name)} · ${getOrder().lines.reduce((n,l)=>n+l.quantity,0)} ks</span><strong>${fmt(C.sum(getOrder().lines))} →</strong>`;
  $('#save-state').textContent=window.POSCloud?'Potvrzeno serverem':'Uloženo v tomto zařízení';$('#save-state').classList.remove('error');connection();
}
function field(label, name, value = '', extra = '', full = false) { return `<label class="field${full ? ' full' : ''}">${label}<input name="${name}" value="${E(value)}" ${extra}></label>`; }
function showDialog(title, body, submit, label = 'Uložit', onDone) {
  window.paymentAbort?.abort();
  const d = $('#dialog'); if (d.open) d.close();
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
  window.paymentAbort=new AbortController();
  d.showModal();
}
function connection() {
  const cloud=window.POSCloud, online=cloud?cloud.connected:navigator.onLine;
  $('#network').textContent=cloud?(online?'Spojeno s PUB GURU':'Čekám na server'):(online?'Místní pokladna':'Místní · bez internetu');
  $('#network').classList.toggle('offline',!online);
  if(!cloud)return;
  const pending=cloud.pending, warning=$('#sync-warning');
  warning.hidden=!state||(!pending&&online);
  warning.innerHTML=pending?`<span><strong>Ověřujeme uloženou operaci.</strong> Platbu na terminálu neopakuj.</span>${btn('Ověřit operaci','retryPending','primary',cloud.busy?'disabled':'')}`:'<span>Server není dostupný. Zobrazená data mohou být starší; placení vyžaduje spojení.</span>';
  if(state){$('#save-state').textContent=cloud.busy?'Ukládám na server…':pending?'Čeká na ověření':online?'Potvrzeno serverem':'Spojení přerušeno';$('#save-state').classList.toggle('error',!!pending||!online);}
  const writeActions=['add','minus','restoreReceipt','newOrder','deleteOrder','mergeOrders','openShift','payCash','payCard','paySplit','refund','closeShift','cashMovement','newProduct','editProduct','archiveProduct','bulkProducts','recipe','resolveStock'];
  document.querySelectorAll('[data-action]').forEach(b=>{if(writeActions.includes(b.dataset.action)){const lock=!!pending&&!cloud.busy||!online;if(lock&&!b.disabled){b.disabled=true;b.dataset.connectionDisabled='true';}else if(!lock&&b.dataset.connectionDisabled){b.disabled=false;delete b.dataset.connectionDisabled;}}});
}
function render() {
  if (!state) return;
  const focused=document.activeElement?.id, selection=document.activeElement?.selectionStart;
  if (!state.orders.some(x => x.id === current)) current = 'bar';
  $('#venue').textContent = state.settings.venue;
  const sh = C.activeShift(state);
  $('#shift-label').textContent = sh ? `Směna od ${date(sh.openedAt)} · ${sh.operator}` : 'Směna není otevřená';
  $('#save-state').textContent = window.POSCloud ? 'Potvrzeno serverem' : 'Uloženo v tomto zařízení'; $('#save-state').classList.remove('error');
  document.querySelectorAll('[data-view]').forEach(b => b.classList.toggle('active', b.dataset.view === view));
  const templates = { pos: renderPOS, history: renderHistory, overview: renderOverview, catalog: renderCatalog, settings: renderSettings, stock:()=>POSStockUI.render(state) };
  $('#app').innerHTML = templates[view]();
  if (view === 'pos') {
    renderProducts();
    $('#search').addEventListener('input', e => { query = e.target.value; document.querySelectorAll('.category').forEach(b => b.classList.toggle('active', !query && b.dataset.id===category)); renderProducts(); });
    bindAccountSearch();
  }
  if(view==='stock')POSStockUI.bind();
  if(focused&&['search','recipe-search','account-search'].includes(focused)&&document.getElementById(focused)){const el=document.getElementById(focused);el.focus();if(selection!==null)el.setSelectionRange(selection,selection);}
  const bill=$('#mobile-bill');bill.hidden=view!=='pos';bill.innerHTML=`<span>${E(getOrder().name)} · ${getOrder().lines.reduce((n,l)=>n+l.quantity,0)} ks</span><strong>${fmt(C.sum(getOrder().lines))} →</strong>`;
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
  input.addEventListener('focus', () => { accountSearchOpen = true; renderAccountResults(); });
  input.addEventListener('input', e => { accountQuery = e.target.value; accountSearchOpen = true; renderAccountResults(); });
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
  if($('#entry-account-name'))$('#entry-account-name').textContent=o.name;
  if($('#entry-account-total'))$('#entry-account-total').textContent=fmt(C.sum(o.lines));
  if($('#entry-quantity'))$('#entry-quantity').textContent=`${entryQuantity}×`;
  document.querySelectorAll('[data-action="entryCount"]').forEach(b=>{
    const active=Number(b.dataset.id)===entryQuantity;
    b.classList.toggle('active',active);b.setAttribute('aria-pressed',String(active));
  });
}
function selectAccount(id) {
  if(!state.orders.some(o=>o.id===id))return;
  current=id;entryQuantity=1;accountQuery='';accountSearchOpen=false;
  const input=$('#account-search');if(input){input.value='';input.blur();}
  renderPOSFast();renderAccountResults();
}
function renderPOS() {
  const o=getOrder(),sh=C.activeShift(state),activeProducts=state.products.filter(x=>x.active),cats=['Vše',...new Set(activeProducts.map(x=>x.category))];
  const canMerge=sh&&o.lines.length&&!o.paymentLock&&state.orders.some(x=>x.id!==o.id&&!x.paymentLock);
  const accounts=state.orders.map(a=>`<button type="button" class="account ${a.id===o.id?'active':''}" data-action="account" data-id="${E(a.id)}" aria-pressed="${a.id===o.id}"><span class="account-number">${E(accountNumber(a)||'•')}</span><span class="account-name">${E(a.name)}<span class="account-amount">${a.lines.length?fmt(C.sum(a.lines)):'Prázdný účet'}</span></span></button>`).join('');
  const lines=o.lines.map(l=>`<div class="line"><div class="line-top"><span>${E(l.name)}${l.serving?`<small class="small"> · ${E(l.serving)}</small>`:''}</span><strong>${fmt(l.price*l.quantity)}</strong></div><div class="line-bottom"><span>${fmt(l.price)} / ks</span><div class="quantity"><button type="button" data-action="minus" data-id="${E(l.id)}" aria-label="Odebrat ${E(l.name)}">−</button><button type="button" class="quantity-tap" data-action="quantityPad" data-id="${E(l.id)}" aria-label="Množství ${E(l.name)}">${l.quantity}×</button><button type="button" data-action="add" data-id="${E(l.productId)}" aria-label="Přidat ${E(l.name)}">+</button></div></div></div>`).join('');
  return `<div class="pos-layout">
    <aside class="accounts"><div class="section-label"><span class="eyebrow">Otevřené účty</span><span class="badge">${state.orders.filter(x=>x.lines.length).length}</span></div>${accounts}${btn('+ Nový účet','newOrder','add-account')}</aside>
    <section class="catalog-area">
      <div class="order-entry"><div class="entry-target"><span>Na účet</span><strong id="entry-account-name">${E(o.name)}</strong><span id="entry-account-total">${fmt(C.sum(o.lines))}</span></div>
        <div class="account-finder"><label class="sr-only" for="account-search">Stůl nebo zákazník</label><input id="account-search" type="search" placeholder="Hledat stůl nebo zákazníka…" autocomplete="off" value="${E(accountQuery)}" aria-expanded="false" aria-controls="account-results"><div id="account-results" class="account-results" hidden></div></div>
        <div class="entry-counts" aria-label="Počet kusů pro další položku"><span>Počet</span>${[1,2,3,4,5].map(n=>btn(n,'entryCount',`entry-count ${n===entryQuantity?'active':''}`,`data-id="${n}" aria-pressed="${n===entryQuantity}"`)).join('')}${btn(`<strong id="entry-quantity">${entryQuantity}×</strong><small>Jiný počet</small>`,'entryQuantity','entry-calculator','aria-label="Zadat počet kusů na velké klávesnici"')}</div>
      </div>
      ${window.POSCloud&&o.paymentLock?`<div class="notice"><span>Účet je rezervovaný pro rozpracovanou platbu.</span>${btn('Zkontrolovat platbu','checkPayment','secondary')}</div>`:''}
      ${!sh?`<div class="notice"><span>Začni směnu a zadej hotovost v pokladně.</span>${btn('Otevřít směnu','openShift','shift-start')}</div>`:''}
      ${activeProducts.some(x=>x.price===null)?`<div class="notice"><span>${activeProducts.filter(x=>x.price===null).length} položek nemá cenu. Doplníš ji klepnutím.</span></div>`:''}
      <div class="search"><span class="search-icon">⌕</span><label class="sr-only" for="search">Hledat v nápojích</label><input id="search" type="search" placeholder="Hledat nápoj nebo kód…" autocomplete="off" value="${E(query)}"></div>
      <div class="categories" aria-label="Kategorie">${cats.map(c=>`<button type="button" class="category ${category===c?'active':''}" data-action="category" data-id="${E(c)}" aria-pressed="${category===c}">${E(c)}</button>`).join('')}</div>
      <div class="products" id="products"></div>
    </section>
    <section class="receipt" aria-label="Aktuální účet"><div class="receipt-head"><div><h2>${E(o.name)}</h2><p>${o.lines.length?'Účet zůstává otevřený do zaplacení':'Připravený pro dalšího hosta'}</p></div><span class="receipt-number">${E(accountNumber(o)||'•')}</span></div><div class="receipt-tools">${btn('Spojit účty','mergeOrders','merge-account',canMerge?'':'disabled')}</div><div class="receipt-items">${lines||'<div class="receipt-empty"><span>≡</span><p>Účet je zatím prázdný.<br>Přidej první nápoj.</p></div>'}</div><div class="receipt-bottom"><div class="receipt-meta"><span>${o.lines.reduce((n,l)=>n+l.quantity,0)} ks na účtu</span>${o.id!=='bar'&&!o.lines.length?btn('Smazat účet','deleteOrder','splitbutton'):'<span>Ceny v Kč</span>'}</div><div class="receipt-total"><span>K zaplacení</span><strong>${fmt(C.sum(o.lines))}</strong></div><div class="payment-buttons">${btn('Hotově','payCash','paycash',!sh||!o.lines.length||!!o.paymentLock?'disabled':'')}${btn('Kartou','payCard','paycard',!sh||!o.lines.length||!!o.paymentLock?'disabled':'')}</div>${btn('Rozdělit platbu / položky','paySplit','splitbutton',!sh||!o.lines.length||!!o.paymentLock?'disabled':'')}</div></section>
  </div>`;
}
function quantityPickerHTML(name,initial,min=1,max=999,all=false) {
  const digits=[7,8,9,4,5,6,1,2,3];
  return `<div class="quantity-picker"><div class="qty-product"><strong>${E(name)}</strong><span>${min}–${max} ks</span></div>
    <div class="qty-quick"><div class="qty-pad">${digits.map(n=>`<button type="button" class="qty-choice ${n===initial?'active':''}" data-qty="${n}" ${n>max?'disabled':''}>${n}</button>`).join('')}${min===0?'<button type="button" class="qty-choice" data-qty="0">0</button>':`<button type="button" class="qty-choice" data-qty="10" ${max<10?'disabled':''}>10</button>`}${all?`<button type="button" class="qty-choice qty-all" data-qty="${max}">Vše<br><small>${max} ks</small></button>`:''}<button type="button" class="qty-choice qty-more" data-qty-more>Jiný počet</button></div></div>
    <div class="qty-calculator" hidden><label class="sr-only">Počet kusů</label><input class="qty-display" aria-label="Počet kusů" inputmode="numeric" value="${initial}" readonly><div class="qty-pad">${digits.map(n=>`<button type="button" class="qty-choice" data-qty-digit="${n}">${n}</button>`).join('')}<button type="button" class="qty-choice" data-qty-clear>C</button><button type="button" class="qty-choice" data-qty-digit="0">0</button><button type="button" class="qty-choice" data-qty-back aria-label="Smazat číslici">⌫</button></div><button type="button" class="primary qty-confirm" data-qty-confirm>Použít počet</button></div></div>`;
}
function bindQuantityPicker(root,initial,min,max,onSelect) {
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
  root.querySelector('[data-qty]:not([disabled])')?.focus();
}
function entryQuantityPad() {
  showDialog('Počet pro další položku',quantityPickerHTML(getOrder().name,entryQuantity),null);
  bindQuantityPicker($('#dialog-body'),entryQuantity,1,999,quantity=>{entryQuantity=quantity;$('#dialog').close();updateEntryContext();});
}
function quantityPad(lineId) {
  const o=getOrder(),l=o.lines.find(x=>x.id===lineId);if(!l)return;
  showDialog('Změnit počet kusů',quantityPickerHTML(l.name,l.quantity),null);
  bindQuantityPicker($('#dialog-body'),l.quantity,1,999,async quantity=>{
    $('#dialog').close();try{await command('setLineQuantity',{orderId:o.id,lineId:l.id,quantity},true);}catch(err){toast(err.message||'Množství se nepodařilo změnit.',true);}
  });
}
function renderProducts() {
  const norm = normalizeSearch;
  const products = state.products.filter(p => p.active && (query || category === 'Vše' || p.category === category) && norm(p.name+' '+p.serving+' '+(p.sourceCode||'')).includes(norm(query)));
  $('#products').innerHTML = products.map(p => `<button class="product" style="--category:${colors[p.category] || '#a5c99a'}" data-action="add" data-id="${E(p.id)}"><span class="product-cat">${E(p.category)}${p.sourceCode ? ` · #${E(p.sourceCode)}` : ''}</span><span class="product-name">${E(p.name)}</span>${p.serving ? `<span class="product-serving">${E(p.serving)}</span>` : ''}<span class="product-price ${p.price === null ? 'unset' : ''}">${p.price === null ? (p.priceNote ? E(p.priceNote) + ' · zadat cenu' : 'Doplnit cenu') : fmt(p.price)}</span><span class="product-plus">+</span></button>`).join('') + `<button class="product quick-product" data-action="newProduct"><span>+</span>Nová položka</button>`;
}
function renderHistory() {
  const rows = [...state.receipts].reverse().map(r => `<tr><td><strong>${E(r.number)}</strong><br><span class="muted small">${date(r.at)}</span></td><td>${E(r.orderName)}<br><span class="tag ${r.kind === 'refund' ? 'orange' : ''}">${r.kind === 'refund' ? 'Vratka' : 'Zaplaceno'}</span></td><td>${r.cash && r.card ? 'Kombinovaně' : r.card ? 'Karta' : 'Hotově'}</td><td class="amount">${fmt(r.total)}</td><td class="table-actions">${btn('Doklad','receipt','secondary',`data-id="${E(r.id)}"`)}${r.kind === 'sale' && r.shiftId === C.activeShift(state)?.id && !state.receipts.some(x => x.refundOf === r.id) ? btn('↩ Na stůl','restoreReceipt','textbutton',`data-id="${E(r.id)}"`) : ''}</td></tr>`).join('');
  return `<section class="page"><div class="workspace-heading"><div><h1>Doklady</h1><p>${window.POSCloud?'Prodeje, vratky a nákupní faktury celé provozovny.':'Prodeje a vratky z tohoto zařízení.'}</p></div><div class="actions">${window.POSCloud?btn('Nahrát faktury do AI účetního','invoiceUpload','primary'):''}${btn('Export CSV','csv')}</div></div>${window.POSCloud?'<div class="notice"><span><strong>PUB INVOICES · AI účetní</strong><br>Fotky, PDF i více dokladů najednou. AI účetní zkontroluje duplicity, položky, ceny, DPH, obaly a skladové mapování. Nejisté položky zastaví k ověření.</span>'+btn('Otevřít faktury','invoiceUpload','secondary')+'</div>':''}<div class="table-wrap"><table><thead><tr><th>Číslo / čas</th><th>Účet</th><th>Úhrada</th><th class="amount">Částka</th><th></th></tr></thead><tbody>${rows || '<tr><td colspan="5" class="empty">Zatím žádná platba. Doklady se objeví po zaplacení prvního účtu.</td></tr>'}</tbody></table></div></section>`;
}
function renderOverview() {
  const sh = C.activeShift(state), t = sh ? C.totals(state, sh.id) : {total:0,cash:0,card:0,count:0,expected:0,opening:0,movements:0};
  return `<section class="page"><div class="workspace-heading"><div><h1>${sh ? 'Dnešní směna' : 'Přehled směn'}</h1><p>${sh ? `Otevřeno ${date(sh.openedAt)} · ${E(sh.operator)}` : 'Otevři směnu a začni markovat.'}</p></div>${sh ? btn('Uzavřít směnu','closeShift','primary') : btn('Otevřít směnu','openShift','primary')}</div><div class="cards"><div class="stat lime"><span class="eyebrow">Tržba po vratkách</span><strong>${fmt(t.total)}</strong></div><div class="stat"><span class="eyebrow">Hotovostní tržba</span><strong>${fmt(t.cash)}</strong></div><div class="stat"><span class="eyebrow">Karetní tržba</span><strong>${fmt(t.card)}</strong></div><div class="stat"><span class="eyebrow">Počet prodejů</span><strong>${t.count}</strong></div></div>${sh ? `<div class="panel"><h3>Hotovost v pokladně</h3><div class="summary-row"><span class="muted">Počáteční vklad</span><strong>${fmt(t.opening)}</strong></div><div class="summary-row"><span class="muted">Vklady a výběry</span><strong>${fmt(t.movements)}</strong></div><div class="summary-row"><span class="muted">Očekávaná hotovost</span><strong>${fmt(t.expected)}</strong></div><div class="actions section-gap">${btn('Vklad / výběr','cashMovement')}${btn('Export CSV','csv')}${btn('Stáhnout zálohu','backup')}</div>${sh.movements.length ? `<div class="section-gap">${sh.movements.map(x => `<div class="summary-row small"><span>${date(x.at)} · ${E(x.reason)}</span><span>${fmt(x.amount)}</span></div>`).join('')}</div>` : ''}</div>` : ''}<div class="panel"><h3>Uzavřené směny</h3>${state.shifts.filter(x => x.closedAt).reverse().map(x => `<div class="summary-row"><span>${date(x.openedAt)} → ${date(x.closedAt)}<br><small class="muted">Hotovost: ${fmt(x.counted)} · rozdíl ${fmt(x.difference)}</small></span><strong>${fmt(x.summary.total)}</strong></div>`).join('') || '<p>Uzávěrky se tu zobrazí po skončení první směny.</p>'}</div></section>`;
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
  current = result.orderId; render();
  toast(`Účty spojené na ${result.name}.`);
}
function mergeOrders() {
  const source = structuredClone(getOrder());
  const targets = structuredClone(state.orders.filter(x => x.id !== source.id));
  if (!source.lines.length || source.paymentLock || !C.activeShift(state)) return;
  showDialog('Spojit účty', `<p class="help">Všechny položky z účtu <strong>${E(source.name)}</strong> se přesunou na vybraný účet. Původní účet zůstane prázdný pro dalšího hosta.</p><label class="field">Spojit s účtem<select name="targetOrderId" required><option value="">Vyber stůl nebo zákazníka</option>${targets.map(o => `<option value="${E(o.id)}" ${o.paymentLock?'disabled':''}>${E(o.name)} · ${fmt(C.sum(o.lines))}${o.paymentLock?' · probíhá platba':''}</option>`).join('')}</select></label><div id="merge-summary" class="payment-summary merge-summary" role="status" aria-live="polite">Vyber účet pro zobrazení společné částky.</div>`, async f => {
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
function editProduct(id, addAfter = false) {
  const p = state.products.find(x => x.id === id) || {name:'',category:category !== 'Vše' ? category : 'Destiláty',serving:'',price:null,vatRate:null,stockProductId:''};
  showDialog(p.id ? 'Upravit položku' : 'Nová položka', `<div class="form-grid">${field('Název','name',p.name,'required maxlength="120"',true)}${field('Cena v Kč','price',p.price === null ? '' : inputMoney(p.price),'required inputmode="decimal" placeholder="Zadej skutečnou cenu"')}${field('Velikost porce','serving',p.serving,'maxlength="40" placeholder="např. 0,04 l"')}<label class="field">Kategorie<input name="category" list="category-list" value="${E(p.category)}" maxlength="40" required><datalist id="category-list">${['Pivo','Destiláty','Nealko','Víno','Koktejly','Káva','Ostatní'].map(x=>`<option>${x}</option>`).join('')}</datalist></label>${field('Sazba DPH (%)','vatRate',p.vatRate ?? '',`type="number" min="0" max="100" step="0.01" ${state.settings.vat === 'payer' ? 'required' : ''} placeholder="Nezadáno"`)}</div>`, async f => {
    const pr = await command('product', {id:p.id,name:f.get('name'),category:f.get('category'),price:C.money(f.get('price')),serving:f.get('serving'),vatRate:f.get('vatRate') === '' ? null : Number(f.get('vatRate')),stockProductId:p.stockProductId});
    return pr;
  }, addAfter && C.activeShift(state) ? 'Uložit a přidat na účet' : 'Uložit položku', async pr => { if (addAfter && C.activeShift(state)) await command('addLine',{orderId:current,productId:pr.id}); toast('Položka uložená.'); });
}
function finishPayment(r) {
  window.paymentAbort?.abort();
  if($('#dialog').open)$('#dialog').close();
  entryQuantity=1;updateEntryContext();
  toast(`Zaplaceno · ${fmt(r.total)}${r.change?` · Vrátit ${fmt(r.change)}`:''}`);
}
async function pay(mode, resume=false) {
  const o=structuredClone(getOrder());if(!o.lines.length)return;
  const reservation=window.POSCloud?(resume?o.paymentLock:await command('beginPayment',{orderId:o.id,revision:o.revision})):null;
  const operationId=crypto.randomUUID(),partial=mode==='split';
  let paymentMode=partial?'cash':mode,receivedTouched=false,splitTouched=false;
  const selected=()=>o.lines.map(l=>({id:l.id,quantity:Number($('#dialog-form').elements['line-'+l.id].value)})).filter(x=>x.quantity>0);
  showDialog(partial?'Rozdělit účet':mode==='cash'?'Zaplatit hotově':'Zaplatit kartou',`
    <p class="help">${partial?'Klepni na položku a vyber počet kusů. Zbytek zůstane na účtu.':'Zaplatit celý účet, nebo klepnutím na položku upravit počet kusů.'}</p>
    ${o.lines.map(l=>`<input type="hidden" name="line-${E(l.id)}" value="${partial?0:l.quantity}">`).join('')}
    <div class="payment-items" id="payment-items"></div><div id="payment-qty-editor" hidden></div>
    <div class="payment-checkout" id="payment-checkout">
      ${partial?'<div class="payment-methods" aria-label="Způsob platby"><button type="button" data-payment-mode="cash">Hotově</button><button type="button" data-payment-mode="card">Kartou</button><button type="button" data-payment-mode="split">Kombinovaně</button></div>':''}
      <div class="payment-summary" id="payment-summary"></div>
      <div class="form-grid"><div id="split-cash-field">${field('Z toho hotově (Kč)','splitCash','0','inputmode="decimal"')}</div><div id="received-field">${field('Přijato v hotovosti (Kč)','received','0','inputmode="decimal"')}</div></div>
      <label class="inline-check" id="card-confirm-field"><input type="checkbox" name="cardConfirmed">Platba kartou na terminálu proběhla úspěšně.</label>
    </div>`, async f=>{
      for(const l of o.lines){const q=Number(f.get('line-'+l.id));if(!Number.isSafeInteger(q)||q<0||q>l.quantity)throw new Error('Neplatný počet kusů.');}
      return await command('checkout',{orderId:o.id,revision:o.revision,operationId,paymentToken:reservation?.token,selected:selected(),mode:paymentMode,received:paymentMode==='card'?0:C.money(f.get('received')),splitCash:paymentMode==='split'?C.money(f.get('splitCash')):0,cardConfirmed:f.has('cardConfirmed')});
    },'Potvrdit zaplacení',finishPayment);
  const signal=window.paymentAbort.signal,form=$('#dialog-form');
  function renderItems() {
    $('#payment-items').innerHTML=o.lines.map(l=>{
      const q=Number(form.elements['line-'+l.id].value);
      return `<button type="button" class="payment-item ${q?'selected':''}" data-payment-line="${E(l.id)}" aria-pressed="${q>0}"><span><strong>${E(l.name)}</strong><small>${E(l.serving)} · ${fmt(l.price)} / ks</small></span><span class="payment-item-count">${q}<small>z ${l.quantity} ks</small></span></button>`;
    }).join('');
  }
  function preview() {
    $('#split-cash-field').hidden=paymentMode!=='split';$('#received-field').hidden=paymentMode==='card';
    form.elements.splitCash.required=paymentMode==='split';form.elements.received.required=paymentMode!=='card';
    document.querySelectorAll('[data-payment-mode]').forEach(b=>{const active=b.dataset.paymentMode===paymentMode;b.classList.toggle('active',active);b.setAttribute('aria-pressed',String(active));});
    try{
      const raw=C.sum(C.selectedLines(o,selected()));
      if(paymentMode==='split'&&!splitTouched)form.elements.splitCash.value='0';
      const cash=paymentMode==='cash'?Math.round(raw/100)*100:paymentMode==='split'?C.money(form.elements.splitCash.value):0;
      if(!receivedTouched)form.elements.received.value=inputMoney(cash);
      const received=paymentMode==='card'?0:C.money(form.elements.received.value),p=C.payment(raw,paymentMode,Math.max(cash,received),cash);
      form.elements.cardConfirmed.required=p.card>0;$('#card-confirm-field').hidden=p.card===0;
      $('#dialog-submit').disabled=received<cash;
      $('#payment-summary').innerHTML=`<div class="summary-row total"><span>K úhradě</span><strong>${fmt(p.total)}</strong></div>${p.rounding?`<div class="summary-row"><span>Zaokrouhlení</span><span>${fmt(p.rounding)}</span></div>`:''}${paymentMode==='split'?`<div class="summary-row"><span>Na terminálu</span><strong>${fmt(p.card)}</strong></div>`:''}${paymentMode!=='card'?`<div class="summary-row"><span>${received<cash?'Ještě chybí':'Vrátit hostovi'}</span><strong>${fmt(Math.abs(received-cash))}</strong></div>`:'<span class="muted small">Částku zadej na samostatném terminálu.</span>'}`;
    }catch(e){$('#payment-summary').textContent=e.message;$('#dialog-submit').disabled=true;form.elements.cardConfirmed.required=false;$('#card-confirm-field').hidden=true;}
  }
  function returnToItems() {
    $('#payment-qty-editor').hidden=true;$('#payment-qty-editor').innerHTML='';$('#payment-items').hidden=false;$('#payment-checkout').hidden=false;
    $('#dialog-submit').hidden=false;$('#dialog .dialog-actions .close-dialog').hidden=false;
    renderItems();preview();
  }
  $('#dialog-body').addEventListener('click',e=>{
    const item=e.target.closest('[data-payment-line]');
    if(item){
      const l=o.lines.find(x=>x.id===item.dataset.paymentLine);if(!l)return;
      const q=Number(form.elements['line-'+l.id].value),editor=$('#payment-qty-editor');
      editor.innerHTML=quantityPickerHTML(l.name,q||1,0,l.quantity,true)+'<button type="button" class="secondary qty-return" data-return-payment>Zpět k položkám</button>';
      editor.hidden=false;$('#payment-items').hidden=true;$('#payment-checkout').hidden=true;$('#dialog-submit').hidden=true;$('#dialog .dialog-actions .close-dialog').hidden=true;
      bindQuantityPicker(editor,q||1,0,l.quantity,quantity=>{form.elements['line-'+l.id].value=String(quantity);returnToItems();});
    }
    const method=e.target.closest('[data-payment-mode]');
    if(method){paymentMode=method.dataset.paymentMode;receivedTouched=false;splitTouched=false;form.elements.cardConfirmed.checked=false;preview();}
    if(e.target.closest('[data-return-payment]'))returnToItems();
  },{signal});
  $('#dialog-body').addEventListener('input',e=>{
    if(e.target.name==='received')receivedTouched=true;
    if(e.target.name==='splitCash')splitTouched=true;
    preview();
  },{signal});
  renderItems();preview();
}
function receiptHTML(r) {
  const s=r.settings, sign=r.kind==='refund'?-1:1, vat={};
  for(const l of r.lines){if(l.vatRate!==null){const key=String(l.vatRate); const gross=l.price*l.quantity*sign; const tax=Math.round(gross*l.vatRate/(100+l.vatRate)); const v=vat[key]||(vat[key]={base:0,tax:0}); v.base+=gross-tax;v.tax+=tax;}}
  return `<div class="receipt-preview"><header><h3>${E(s.venue)}</h3>${s.company?`<div>${E(s.company)}</div>`:''}${s.address?`<div>${E(s.address)}</div>`:''}${s.ico?`<div>IČ: ${E(s.ico)}${s.dic?' · DIČ: '+E(s.dic):''}</div>`:''}<div class="section-gap">${r.kind==='refund'?'VRATKA':'PRODEJNÍ DOKLAD'} ${E(r.number)}</div><div>${date(r.at)} · ${E(r.operator)}</div><div>${E(r.orderName)}</div></header><hr><table><tbody>${r.lines.map(l=>`<tr><td>${l.quantity}× ${E(l.name)} ${E(l.serving)}<br><span class="muted">${fmt(l.price)} / ks</span></td><td class="amount">${fmt(l.price*l.quantity*sign)}</td></tr>`).join('')}</tbody></table><hr>${r.rounding?`<div class="summary-row"><span>Zaokrouhlení</span><span>${fmt(r.rounding)}</span></div>`:''}<div class="summary-row total"><span>Celkem</span><strong>${fmt(r.total)}</strong></div>${r.cash?`<div class="summary-row"><span>Hotově</span><span>${fmt(r.cash)}</span></div>`:''}${r.card?`<div class="summary-row"><span>Kartou</span><span>${fmt(r.card)}</span></div>`:''}${r.change?`<div class="summary-row"><span>Přijato / vráceno</span><span>${fmt(r.received)} / ${fmt(r.change)}</span></div>`:''}${s.vat==='payer'?`<hr>${Object.entries(vat).map(([rate,v])=>`<div class="small">DPH ${E(rate)} % · základ ${fmt(v.base)} · daň ${fmt(v.tax)}</div>`).join('')}`:''}${r.reason?`<p class="section-gap">Důvod vratky: ${E(r.reason)}</p>`:''}<div class="footnote">${s.vat==='unknown'?'Provozní záznam — režim DPH není nastaven.':s.vat==='nonpayer'?'Provozovatel není plátcem DPH.':''}${!s.company||!s.ico||!s.address?'<br>Údaje provozovatele nejsou kompletní.':''}<br>PUB-BIZZ · Děkujeme za návštěvu.</div></div>`;
}
function receiptDialog(r) { showDialog(r.kind==='refund'?'Vratka uložená':'Zaplaceno',receiptHTML(r),async()=>{ $('#print-area').innerHTML=receiptHTML(r); window.print(); },'Vytisknout doklad'); }
function download(name,content,type){ const url=URL.createObjectURL(new Blob([content],{type})); const a=document.createElement('a');a.href=url;a.download=name;document.body.append(a);a.click();a.remove();setTimeout(()=>URL.revokeObjectURL(url),60000); }
async function downloadBackup(s,prefix='PUB-BIZZ-zaloha') {
  const data=JSON.stringify(s),hash=Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(data)))).map(x=>x.toString(16).padStart(2,'0')).join('');
  download(`${prefix}-${new Date().toISOString().replace(/[:.]/g,'-')}.json`,JSON.stringify({format:'pubbizz.pos.backup.v1',hash,data:s},null,2),'application/json');
}
async function backup(){await downloadBackup(await Store.read());if(!window.POSCloud||POSCloud.meta.role!=='accountant')await command('backup',{});toast('Záloha připravená ke stažení.');}

function csv(){
  const cell=v=>{let s=String(v??''); if(/^[=+\-@\t\r]/.test(s))s="'"+s;return '"'+s.replaceAll('"','""')+'"';};
  const rows=[['doklad','datum','typ','ucet','polozka','porce','pocet','cena_kc','celkem_polozka_kc','dph_procent','doklad_hotove_kc','doklad_karta_kc','doklad_zaokrouhleni_kc','směna_id','produkt_id','sklad_id']];
  for(const r of state.receipts)r.lines.forEach((l,i)=>rows.push([r.number,r.at,r.kind,r.orderName,l.name,l.serving,l.quantity*(r.kind==='refund'?-1:1),inputMoney(l.price),inputMoney(l.price*l.quantity*(r.kind==='refund'?-1:1)),l.vatRate??'',i===0?inputMoney(r.cash):'',i===0?inputMoney(r.card):'',i===0?inputMoney(r.rounding):'',r.shiftId,l.productId,l.stockProductId]));
  download(`PUB-BIZZ-prodeje-${new Date().toISOString().slice(0,10)}.csv`,'\uFEFF'+rows.map(r=>r.map(cell).join(';')).join('\r\n'),'text/csv;charset=utf-8');toast('CSV připravené ke stažení.');
}
function closeShift(){ const sh=C.activeShift(state);if(!sh)return;if(state.orders.some(x=>x.lines.length)){toast('Nejdřív zaplať všechny rozdělané účty.',true);return;}const t=C.totals(state,sh.id);showDialog('Uzavřít směnu',`<div class="payment-summary"><div class="summary-row"><span>Tržba</span><strong>${fmt(t.total)}</strong></div><div class="summary-row"><span>Očekávaná hotovost</span><strong>${fmt(t.expected)}</strong></div></div>${field('Spočítaná hotovost v zásuvce (Kč)','counted','','required inputmode="decimal"')}<p class="help section-gap">Směna se uzamkne. Doklady zůstanou uložené a stáhne se úplná záloha.</p>`,f=>command('closeShift',{counted:C.money(f.get('counted'))}),'Uzavřít a zálohovat',async()=>{view='overview';render();await backup();});}
function bulkProducts(){showDialog('Hromadně vložit ceník',`<p class="help">Každý řádek: <strong>název; cena; kategorie; porce; DPH</strong>. Poslední tři údaje lze vynechat. Existující položky se shodným názvem a porcí se aktualizují.</p><label class="field">Položky<textarea name="rows" rows="9" required placeholder="Název nápoje; cena v Kč; kategorie; porce; DPH %"></textarea></label>`,async f=>{const rows=String(f.get('rows')).split(/\r?\n/).filter(x=>x.trim());if(rows.length>300)throw new Error('Najednou lze vložit nejvýš 300 položek.');const items=rows.map((row,i)=>{const [name,price,category='Ostatní',serving='',rate='']=row.split(';').map(x=>x.trim());if(!name||!price)throw new Error(`Na řádku ${i+1} chybí název nebo cena.`);return {name,price:C.money(price),category,serving,vatRate:rate===''?null:Number(rate.replace(',','.'))};});await command('importProducts',{items});},'Uložit ceník',()=>toast('Ceník byl uložený.'));}
const actions={
  quantityPad:id=>quantityPad(id),
  entryCount:id=>{entryQuantity=Number(id);updateEntryContext();},entryQuantity:entryQuantityPad,
  account:id=>selectAccount(id),category:async id=>{category=id;query='';render();},openShift,mergeOrders,
  newOrder:()=>showDialog('Nový účet',field('Stůl nebo jméno hosta','name',accountQuery.trim(),'required maxlength="120" placeholder="např. Stůl 1 / Petr"'),f=>command('newOrder',{name:f.get('name')}),'Vytvořit účet',r=>selectAccount(r.id)),
  deleteOrder:async()=>{await command('deleteOrder',{orderId:current});current='bar';render();},
  add:async (id,button)=>{const p=state.products.find(x=>x.id===id);if(!p)return;if(p.price===null){editProduct(id,true);return;}if(!C.activeShift(state)){openShift();return;}const quantity=button?.classList.contains('product')?entryQuantity:1,orderId=current;entryQuantity=1;updateEntryContext();await command('addLine',{orderId,productId:id,quantity},true);},
  minus:async id=>{await command('removeLine',{orderId:current,lineId:id,reason:'Oprava namarkování'},true);},
  newProduct:()=>editProduct(),editProduct:id=>editProduct(id),archiveProduct:id=>showDialog('Skrýt položku',`<p class="help">${E(state.products.find(x=>x.id===id)?.name)} zmizí z nabídky. Existující účty a doklady zůstanou.</p>`,()=>command('archiveProduct',{id}),'Skrýt'),
  checkPayment:()=>{const o=structuredClone(getOrder());showDialog('Rozpracovaná platba','<p class="help">Ověř u obsluhy a na terminálu, zda už host platil. Pokud už platba proběhla, pokračuj jejím zapsáním a na terminálu ji neopakuj. Rezervace po zavření okna zůstává.</p><label class="field">Co provést<select name="operation"><option value="cash">Pokračovat v hotovostní platbě</option><option value="card">Pokračovat v karetní platbě</option><option value="split">Pokračovat v rozdělení účtu</option><option value="cancel">Host nezaplatil — uvolnit účet</option></select></label><label class="inline-check"><input type="checkbox" name="checked" required>Stav platby jsem zkontroloval/a.</label>',async f=>{if(f.get('operation')==='cancel')await command('cancelPayment',{orderId:o.id,paymentToken:o.paymentLock.token,terminalChecked:f.has('checked'),reason:'Obsluha ověřila, že host nezaplatil'});return f.get('operation');},'Pokračovat',operation=>{if(operation!=='cancel')return pay(operation,true);});},
  payCash:()=>pay('cash'),payCard:()=>pay('card'),paySplit:()=>pay('split'),
  receipt:id=>receiptDialog(state.receipts.find(x=>x.id===id)),
  restoreReceipt:async id=>{const r=state.receipts.find(x=>x.id===id);if(!r)return;const restored=await command('restoreReceipt',{receiptId:id});current=restored.restoredToOrderId||r.orderId;view='pos';render();toast(`Doklad ${r.number} vrácen na ${r.orderName}.`);},
  refund:id=>{const r=state.receipts.find(x=>x.id===id);showDialog('Vrátit celý doklad',`<p class="help">Doklad ${E(r.number)} · ${fmt(r.total)}. Vrací se stejným způsobem jako původní platba. Vratka se uloží samostatně.</p>${field('Důvod vratky','reason','','required maxlength="120"')}${window.POSCloud?'<label class="inline-check"><input type="checkbox" name="restock">Zboží se fyzicky vrátilo a chci ho vrátit na sklad.</label>':''}${r.card?'<label class="inline-check"><input type="checkbox" name="cardConfirmed" required>Vrácení karetní platby na terminálu proběhlo.</label>':''}`,f=>command('refund',{receiptId:id,reason:f.get('reason'),cardConfirmed:f.has('cardConfirmed'),restock:f.has('restock')}),'Zapsat vratku',receiptDialog);},
  cashMovement:()=>showDialog('Vklad / výběr hotovosti',`<div class="form-grid"><label class="field">Pohyb<select name="direction"><option value="1">Vklad do pokladny</option><option value="-1">Výběr z pokladny</option></select></label>${field('Částka v Kč','amount','','required inputmode="decimal"')}${field('Důvod','reason','','required maxlength="120"',true)}</div>`,f=>command('cashMovement',{amount:C.money(f.get('amount'))*Number(f.get('direction')),reason:f.get('reason')}),'Zapsat pohyb'),
  recipe:id=>POSStockUI.edit(state,id,showDialog,command,toast),
  resolveStock:id=>{const [receiptId,lineId]=id.split(':');showDialog('Doplnit skladový odpis','<p class="help">Provede se odpis podle nyní nastavené receptury k původnímu prodeji. U stejného řádku ho nelze provést dvakrát.</p>',()=>command('resolveStock',{receiptId,lineId}),'Provést odpis',()=>toast('Odpis byl zpracovaný.'));},
  retryPending:async()=>{const r=await POSCloud.retry();state=r.state;render();if(r.result?.kind==='sale')finishPayment(r.result);else if(r.result?.kind)receiptDialog(r.result);else if(r.result?.type==='mergeOrders')finishMerge(r.result);else toast('Operace ověřená.');},
  invoiceUpload:()=>{ location.href='../pub_guru/invoice-capture.html'; },
  logout:()=>POSCloud.logout(),
  showBill:()=>$('.receipt')?.scrollIntoView({behavior:'smooth',block:'start'}),
  localBackup:async()=>{const local=await POSCloud.localBackup();await downloadBackup(local,'PUB-BIZZ-stara-mistni-data');toast('Místní data připravená ke stažení.');},
  closeShift,backup,csv,bulkProducts,restore:()=>$('#restore-input').click()
};
document.addEventListener('click',async e=>{
  if(accountSearchOpen&&!e.target.closest('.account-finder')){accountSearchOpen=false;renderAccountResults();}
  const close=e.target.closest('.close-dialog');if(close){if(!submitting)$('#dialog').close();return;}
  const tab=e.target.closest('[data-view]');if(tab){view=tab.dataset.view;render();return;}
  const b=e.target.closest('[data-action]');if(!b||b.disabled||!state)return;
  const action=actions[b.dataset.action];if(action)try{await action(b.dataset.id,b);}catch(err){toast(err.message||'Operace se nepodařila.',true);}
});
$('#dialog').addEventListener('cancel',e=>{if(submitting)e.preventDefault();});
$('#fullscreen').addEventListener('click',async()=>{try{if(document.fullscreenElement)await document.exitFullscreen();else if(document.documentElement.requestFullscreen)await document.documentElement.requestFullscreen();else toast('Na telefonu přidej pokladnu na plochu z nabídky prohlížeče.');}catch{toast('Prohlížeč celoobrazovkový režim nepovolil.',true);}});
$('#restore-input').addEventListener('change',async e=>{
  const file=e.target.files?.[0];e.target.value='';if(!file)return;
  try{if(file.size>20000000)throw new Error('Záloha je příliš velká (maximum 20 MB).');const wrapper=JSON.parse(await file.text());if(wrapper.format!=='pubbizz.pos.backup.v1')throw new Error('Tohle není záloha PUB-BIZZ.');const hash=Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(JSON.stringify(wrapper.data))))).map(x=>x.toString(16).padStart(2,'0')).join('');if(hash!==wrapper.hash)throw new Error('Kontrolní součet nesedí. Soubor je změněný nebo poškozený.');C.validate(wrapper.data);showDialog('Obnovit pokladnu',`<p class="help">Záloha: <strong>${E(wrapper.data.settings.venue)}</strong><br>${wrapper.data.receipts.length} dokladů · ${wrapper.data.products.length} položek.<br>Po obnově používej pouze toto zařízení.</p>`,async()=>{const r=await Store.restore(wrapper.data);state=r.state;current='bar';render();},'Obnovit zálohu',()=>toast('Záloha byla obnovená.'));}catch(err){toast(err.message,true);}
});
window.addEventListener('pos-connection',connection);
window.addEventListener('online',connection);window.addEventListener('offline',connection);
async function refresh(){if(state){try{const next=await Store.read();if(next.revision!==state.revision){state=next;render();}}catch{toast('Nepodařilo se načíst uložená data.',true);}}}
window.addEventListener('focus',refresh);
(async()=>{
  document.querySelectorAll('[data-cloud]').forEach(x=>x.hidden=!window.POSCloud);
  try{state=await Store.open(refresh);C.validate(state);render();connection();
    if(window.POSCloud?.meta.recoveredResult?.kind==='sale')finishPayment(POSCloud.meta.recoveredResult);
    else if(window.POSCloud?.meta.recoveredResult?.kind)receiptDialog(POSCloud.meta.recoveredResult);
    else if(window.POSCloud?.meta.recoveredResult?.type==='mergeOrders')finishMerge(POSCloud.meta.recoveredResult);
    else if(window.POSCloud?.meta.recoveryMessage)toast(POSCloud.meta.recoveryMessage,true);
    if(document.documentElement.dataset.standalone){$('#offline-status').textContent='Samostatná offline verze · data tohoto prohlížeče';}
    else if('serviceWorker' in navigator){try{await navigator.serviceWorker.register('./sw.js');await navigator.serviceWorker.ready;$('#offline-status').textContent=window.POSCloud?'Sdílené účty · PUB GURU · připojení je nutné':'Připraveno i bez internetu · jedno zařízení';}catch{$('#offline-status').textContent=window.POSCloud?'Sdílené účty · PUB GURU':'Offline spuštění není připravené · data zůstávají místní';}}
  }catch(e){$('#app').innerHTML=`<div class="panel"><h1>Pokladnu nelze otevřít</h1><p class="error">${E(e.message)}</p><p class="section-gap">Nic nemaž. Zkus běžné okno Chrome / Edge, nebo obnov stránku. Pokud máš zálohu, můžeš ji obnovit v novém profilu prohlížeče.</p></div>`;$('#save-state').textContent='Úložiště není dostupné';}
})();

