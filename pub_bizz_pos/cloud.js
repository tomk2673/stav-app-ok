(function(root) {
  'use strict';
  if(document.documentElement.dataset.standalone) return;
  const local = root.POSStore, cfg=root.POS_CONFIG;
  const client=root.supabase.createClient(cfg.url,cfg.publishableKey,{auth:{persistSession:true,autoRefreshToken:true,detectSessionInUrl:false}});
  let user,venue,cache,meta={stock:[],issues:[],issueCount:0},onChange,opened,resolveOpen,lastConfirmed=0,poll,busy=false,queue=Promise.resolve();
  const endpoint=cfg.url+'/functions/v1/pub-bizz-pos';
  const escape=s=>String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  const prefix=()=>`pub-bizz-cloud-pending:${venue.id}:${user.id}:`;
  const key=id=>prefix()+id;
  // Separate keys prevent two tabs from overwriting each other's unacknowledged operation.
  const pending=()=>{
    if(!venue||!user)return null;
    const entries=[];
    for(let i=0;i<localStorage.length;i++){const k=localStorage.key(i);if(k?.startsWith(prefix()))entries.push(JSON.parse(localStorage.getItem(k)));}
    return entries.sort((a,b)=>String(a.sentAt).localeCompare(String(b.sentAt)))[0]||null;
  };
  function emit(){root.dispatchEvent(new Event('pos-connection'));}
  function accept(data) {
    if(data.state && (!cache || data.state.revision>=cache.revision)) {cache=data.state;meta={...meta,...data};}
    lastConfirmed=Date.now();emit();return {state:cache,result:data.result};
  }
  async function api(body,context=false,refreshed=false) {
    const {data:{session}}=await client.auth.getSession();
    if(!session) throw Object.assign(new Error('Přihlášení vypršelo. Přihlas se znovu.'),{auth:true});
    const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),18000);
    try {
      const response=await fetch(endpoint+(body||context?'':'?venueId='+encodeURIComponent(venue.id)),{
        method:body?'POST':'GET',headers:{Authorization:'Bearer '+session.access_token,apikey:cfg.publishableKey,'Content-Type':'application/json'},
        body:body?JSON.stringify(body):undefined,signal:controller.signal,cache:'no-store'
      });
      const data=await response.json();
      if(response.status===401 && !refreshed) {
        const r=await client.auth.refreshSession();
        if(!r.error&&r.data.session) return await api(body,context,true);
      }
      if(!response.ok) throw Object.assign(new Error(data.error||data.message||'Server změnu nepotvrdil.'),{definitive:data.definitive===true,auth:response.status===401});
      return data;
    } finally {clearTimeout(timer);}
  }
  async function sendSaved(request) {
    try {
      const response=await api(request);localStorage.removeItem(key(request.requestId));return accept(response);
    } catch(e) {
      lastConfirmed=0;
      if(e.definitive) localStorage.removeItem(key(request.requestId));
      emit();
      if(!e.definitive) e.message='Výsledek operace zatím není potvrzený. Použij „Ověřit operaci“. Platbu na terminálu neopakuj.';
      throw e;
    }
  }
  async function refresh() {
    if(!venue||busy||document.hidden) return;
    try {const before=cache?.revision;accept(await api());if(cache?.revision!==before) onChange?.();}
    catch {lastConfirmed=0;emit();}
  }
  async function activate(selected) {
    venue=selected;cache=null;
    localStorage.setItem('pub-bizz-venue',venue.id);
    accept(await api());
    const journal=pending();
    if(journal) {try {busy=true;const recovered=await sendSaved(journal);meta.recoveredResult=recovered.result;} catch(e) {meta.recoveryMessage=e.message;} finally{busy=false;}}
    if(!opened){opened=true;resolveOpen(cache);}else onChange?.();
    clearInterval(poll);poll=setInterval(refresh,3000);emit();
  }
  async function loadContext() {
    const context=await api(null,true);user=context.user;
    if(!context.venues.length) throw new Error('Účet nemá přiřazenou provozovnu. Přístup nastav v PUB GURU.');
    if(context.venues.length===1) return activate(context.venues[0]);
    document.querySelector('#app').innerHTML=`<section class="login-panel panel"><span class="eyebrow">PUB-BIZZ</span><h1>Vyber provozovnu</h1><p class="section-gap">Účty a sklad se sdílejí uvnitř zvolené provozovny.</p><div class="venue-list section-gap">${context.venues.map((v,i)=>`<button class="secondary" data-venue-index="${i}">${escape(v.name)}</button>`).join('')}</div><p class="error" id="login-error"></p></section>`;
    document.querySelectorAll('[data-venue-index]').forEach(b=>b.onclick=async()=>{try{b.disabled=true;await activate(context.venues[Number(b.dataset.venueIndex)]);}catch(e){document.querySelector('#login-error').textContent=e.message;b.disabled=false;}});
  }
  function login(message='') {
    document.querySelector('#app').innerHTML=`<section class="login-panel panel"><span class="eyebrow">PUB-BIZZ · ZTRACENÝ BAR</span><h1>Jedna pokladna.<br>Na baru i v telefonu.</h1><p class="section-gap">Přihlas se stejným účtem jako do PUB GURU. Účty, tržby a sklad pak najdeš pohromadě.</p><form id="login-form" class="section-gap"><label class="field">E-mail<input type="email" name="email" autocomplete="username" required></label><label class="field section-gap">Heslo<input type="password" name="password" autocomplete="current-password" required></label><p class="error" id="login-error">${escape(message)}</p><button type="submit" class="primary section-gap">Přihlásit se</button></form><p class="section-gap small">Přístup k pokladně určuje tvoje role v provozovně PUB GURU.</p></section>`;
    document.querySelector('#save-state').textContent='Čekám na přihlášení';
    document.querySelector('#login-form').onsubmit=async e=>{
      e.preventDefault();const form=e.currentTarget,b=form.querySelector('button');b.disabled=true;document.querySelector('#login-error').textContent='';
      try {
        const f=new FormData(form);const r=await client.auth.signInWithPassword({email:String(f.get('email')).trim(),password:String(f.get('password'))});
        form.elements.password.value='';if(r.error) throw new Error('Přihlášení se nepodařilo. Zkontroluj e-mail a heslo.');
        await loadContext();
      } catch(err){if(document.querySelector('#login-error'))document.querySelector('#login-error').textContent=err.message;}finally{b.disabled=false;}
    };
  }
  async function open(callback) {
    onChange=callback;
    const ready=new Promise(resolve=>resolveOpen=resolve);
    try {const {data:{session}}=await client.auth.getSession();if(session) await loadContext();else login();}
    catch(e){login(e.message);}
    return ready;
  }
  function command(type,payload={}) {
    const task=queue.then(async()=>{
      if(pending()) throw new Error('Nejdřív ověř předchozí operaci. Nová platba zatím není povolená.');
      const request={venueId:venue.id,requestId:crypto.randomUUID(),type,payload:structuredClone(payload),sentAt:new Date().toISOString()};
      // Persist before making the request. If the response is lost, replay this exact ID.
      localStorage.setItem(key(request.requestId),JSON.stringify(request));busy=true;emit();
      try{return await sendSaved(request);}finally{busy=false;emit();}
    });queue=task.catch(()=>{});return task;
  }
  async function retry() {
    if(busy) throw new Error('Operace se právě ověřuje.');
    const request=pending();if(!request){await refresh();return {state:cache,result:null};}
    busy=true;emit();try {const r=await sendSaved(request);onChange?.();return r;}finally{busy=false;emit();}
  }
  root.POSCloud={
    get meta(){return meta;},get user(){return user;},get venue(){return venue;},get pending(){return pending();},get busy(){return busy;},
    get connected(){return navigator.onLine && Date.now()-lastConfirmed<12000;},refresh,retry,
    async logout(){if(busy)throw new Error('Počkej na dokončení operace.');await client.auth.signOut({scope:'local'});location.reload();},
    async localBackup(){await local.open(()=>{});return local.read();}
  };
  root.POSStore={open,read:async()=>cache,command,restore:async()=>{throw new Error('Místní záloha nesmí přepsat sdílenou pokladnu. Použij původní offline verzi.');}};
  window.addEventListener('online',refresh);window.addEventListener('focus',refresh);
  window.addEventListener('storage',e=>{if(e.key?.startsWith('pub-bizz-cloud-pending:')){emit();refresh();}});
})(globalThis);
