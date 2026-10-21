(function(root) {
  'use strict';
  if(document.documentElement.dataset.standalone) return;
  const local = root.POSStore, cfg=root.POS_CONFIG;
  let client;
  try {
    root.POSRuntime?.assertReady();
    if(!local||!root.POSCore||!root.POSMarking||!root.POSSync||!cfg?.url||!cfg?.publishableKey||!root.supabase?.createClient) throw new Error('Nepodařilo se načíst sdílenou pokladnu. Obnov stránku a zkontroluj připojení.');
    client=root.supabase.createClient(cfg.url,cfg.publishableKey,{auth:{persistSession:true,autoRefreshToken:true,detectSessionInUrl:false}});
  } catch(e) {
    // Never let an online page silently use the separate local emergency register.
    root.POSBootError=e;root.POSRuntime?.fail(e.message);return;
  }
  const M=root.POSMarking,S=root.POSSync;
  let user,venue,base,cache,meta={stock:[],issues:[],issueCount:0},onChange,opened,resolveOpen,lastConfirmed=0,poll,busy=false;
  let retryTimer,retryDelay=1000,worker,strictQueue=Promise.resolve(),viewSerial=0,storageError='',authBlocked=false,snapshotDB,lastMetadata=0,serviceError='',projectionToken='';
  const endpoint=cfg.url+'/functions/v1/pub-bizz-pos';
  const escape=s=>String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  const scope=()=>`${venue.id}:${user.id}:`;
  const prefix=()=>`pub-bizz-cloud-pending:${scope()}`;
  const key=id=>prefix()+id;
  const snapshotPrefix=()=>`pub-bizz-cloud-confirmed:${scope()}`;
  const contextKey=id=>`pub-bizz-cloud-context:${id}`;
  const selectionKey=()=>`pub-bizz-cloud-account:${scope()}`;
  const isMarking=r=>r?.local?.kind==='marking';
  const localMarking=()=>meta.markingProtocol===1&&cfg.localMarking!==false;
  function write(k,value) {
    try {localStorage.setItem(k,JSON.stringify(value));storageError='';}
    catch {storageError='V zařízení není místo pro bezpečné uložení. Nic nemaž; uvolni místo a zkus ověření znovu.';emit();throw new Error(storageError);}
  }
  // One immutable key per intent prevents tabs from overwriting each other.
  function entries() {
    if(!venue||!user)return [];
    const found=[];
    try {
      for(let i=0;i<localStorage.length;i++){
        const k=localStorage.key(i);if(!k?.startsWith(prefix()))continue;
        const r=JSON.parse(localStorage.getItem(k));
        if(!r||k!==key(r.requestId)||r.venueId!==venue.id||!r.payload||!r.type)throw new Error('journal');
        if(isMarking(r)&&(!M?.types.has(r.type)||r.payload.marking?.operationId!==r.requestId||!['queued','blocked'].includes(r.local.status)))throw new Error('marking journal');
        found.push(r);
      }
    } catch {storageError='Místní frontu nelze přečíst. Nic nemaž; markování a platby jsou pozastavené.';}
    return found.sort((a,b)=>(a.local?.sequence||Date.parse(a.sentAt)||0)-(b.local?.sequence||Date.parse(b.sentAt)||0)||a.requestId.localeCompare(b.requestId));
  }
  const pending=()=>{const all=entries();return all.find(r=>!isMarking(r))||all[0]||null;};
  function emit(){root.dispatchEvent(new Event('pos-connection'));}
  function publish(){viewSerial++;emit();onChange?.();}
  const projectionKey=all=>base.venueId+':'+base.revision+':'+JSON.stringify(all.filter(isMarking).map(r=>[r.requestId,r.local.status,r.local.error||'']));
  function projection() {
    if(!base)return;
    const all=entries(),token=projectionKey(all);
    if(cache&&token===projectionToken){emit();return;}
    const next=structuredClone(base);
    for(const r of all) {
      if(!isMarking(r)||r.local.status==='blocked'||M.applied(base,r.requestId)||M.outcome(base,r.requestId)?.type==='markingRejected')continue;
      try {M.apply(next,r.type,r.payload,r.sentAt,user.id);}
      catch { /* Keep the immutable intent visible in the journal until the server decides. */ }
    }
    cache=next;projectionToken=token;publish();
  }
  function database() {
    if(!snapshotDB)snapshotDB=new Promise((resolve,reject)=>{
      if(!root.indexedDB){reject(new Error('Prohlížeč nemá dostupnou databázi pro rozepsané účty. Nic nemaž; použij běžné okno prohlížeče.'));return;}
      const request=indexedDB.open('pub-bizz-cloud-snapshots-v1',1);
      request.onupgradeneeded=()=>request.result.createObjectStore('confirmed');
      request.onsuccess=()=>{request.result.onversionchange=()=>request.result.close();resolve(request.result);};
      request.onerror=()=>reject(request.error||new Error('Databázi účtů nelze otevřít.'));
      request.onblocked=()=>reject(new Error('Zavři ostatní okna pokladny a obnov stránku.'));
    });
    return snapshotDB;
  }
  async function savedSnapshot() {
    const db=await database();
    return new Promise((resolve,reject)=>{
      const tx=db.transaction('confirmed','readonly'),request=tx.objectStore('confirmed').get(scope());
      request.onsuccess=()=>resolve(request.result);request.onerror=()=>reject(request.error);
    });
  }
  async function saveSnapshot(data) {
    const db=await database();
    return new Promise((resolve,reject)=>{
      let tx;try{tx=db.transaction('confirmed','readwrite',{durability:'strict'});}catch{tx=db.transaction('confirmed','readwrite');}
      const store=tx.objectStore('confirmed'),request=store.get(scope());let saved;
      request.onsuccess=()=>{
        // The read and conditional replacement share one transaction across tabs.
        // IndexedDB keeps the full history out of the small localStorage budget.
        saved=request.result;
        if(!saved||saved.state.revision<data.state.revision){saved=data;store.put(data,scope());}
      };
      tx.oncomplete=()=>{
        try{localStorage.setItem(snapshotPrefix()+'signal',String(saved.state.revision));}catch{/* Another tab also polls; the durable snapshot is already committed. */}
        resolve(saved);
      };
      tx.onerror=tx.onabort=()=>reject(tx.error||new Error('Potvrzený účet se nepodařilo uložit. Čekající operaci nemaž.'));
    });
  }
  async function accept(data,persist=true) {
    if(persist)data={...data,accountActionsProtocol:data.accountActionsProtocol===1?1:0};
    if(persist){serviceError='';if(data.stock)lastMetadata=Date.now();}
    let incoming;try{incoming=S.decode(base,data);}catch{incoming=null;}
    if(!incoming){const full=await api(null,false,false,'?venueId='+encodeURIComponent(venue.id)+'&full=1');return accept(full,persist);}
    if(data.unchanged){meta={...meta,...data};if(persist){lastConfirmed=Date.now();authBlocked=false;}emit();return {state:cache,result:data.result};}
    data={...data,state:incoming};delete data.delta;delete data.unchanged;
    CValidate(data.state);if(data.state.venueId!==venue.id)throw new Error('Server vrátil jinou provozovnu.');
    if(base&&incoming.revision<=base.revision){meta={...meta,...data,state:base};if(persist){lastConfirmed=Date.now();authBlocked=false;}emit();return {state:cache,result:data.result};}
    const saved=persist?await saveSnapshot(data):data;
    // A late response must not overwrite a newer state from this or another tab.
    if(!base||saved.state.revision>=base.revision){base=saved.state;meta={...meta,...data,state:base};}
    if(persist){lastConfirmed=Date.now();authBlocked=false;}
    projection();return {state:cache,result:data.result};
  }
  function CValidate(s){root.POSCore.validate(s);}
  async function api(body,context=false,refreshed=false,query='') {
    const {data:{session}}=await client.auth.getSession();
    if(!session)throw Object.assign(new Error('Přihlášení vypršelo. Přihlas se znovu.'),{auth:true});
    if(user&&session.user&&session.user.id!==user.id)throw Object.assign(new Error('Změnil se přihlášený účet. Obnov stránku.'),{auth:true});
    const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),18000);
    const sync=base&&meta.syncProtocol===1?S.cursor(base):null;
    const suffix=sync?'&sync='+encodeURIComponent(JSON.stringify(sync))+(Date.now()-lastMetadata>60000?'&metadata=1':''):'';
    try {
      const response=await fetch(endpoint+(query||(!body&&!context?'?venueId='+encodeURIComponent(venue.id)+suffix:'')),{
        method:body?'POST':'GET',headers:{Authorization:'Bearer '+session.access_token,apikey:cfg.publishableKey,'Content-Type':'application/json'},
        body:body?JSON.stringify(sync?{...body,sync}:body):undefined,signal:controller.signal,cache:'no-store'
      });
      const data=await response.json();
      if(response.status===402&&/egress/i.test(data.message||'')){serviceError='Server je pozastaven kvůli datovému limitu. Čekající změny zůstávají v zařízení.';throw new Error(serviceError);}
      if(response.status===401&&!refreshed){const r=await client.auth.refreshSession();if(!r.error&&r.data.session)return api(body,context,true,query);}
      if(!response.ok)throw Object.assign(new Error(data.error||data.message||'Server změnu nepotvrdil.'),{definitive:data.definitive===true,auth:[401,403].includes(response.status)});
      return data;
    } finally {clearTimeout(timer);}
  }
  async function sendSaved(request) {
    const {local:localInfo,...wire}=request;
    try {
      const response=await api(wire);
      // Save confirmed state before removing the intent. After a crash the
      // audit operation ID suppresses an already committed optimistic overlay.
      await accept(response);
      if(response.result?.type==='markingRejected') {
        write(key(request.requestId),{...request,local:{...localInfo,status:'blocked',error:response.result.message}});
      } else localStorage.removeItem(key(request.requestId));
      retryDelay=1000;projection();return {state:cache,result:response.result};
    } catch(e) {
      lastConfirmed=0;if(e.auth)authBlocked=true;
      // Marking rejections are durably consumed by the versioned server.
      // Never discard a marking intent on an ambiguous/old-server response.
      if(e.definitive&&!isMarking(request))localStorage.removeItem(key(request.requestId));
      emit();
      if(!e.definitive)e.message=isMarking(request)?'Markování je uložené v zařízení a čeká na server.':'Výsledek operace zatím není potvrzený. Použij „Ověřit operaci“. Platbu na terminálu neopakuj.';
      throw e;
    }
  }
  function schedule() {
    clearTimeout(retryTimer);
    const all=entries();
    if(!all.some(r=>isMarking(r)&&r.local.status!=='blocked')||all.some(r=>!isMarking(r))||authBlocked||storageError)return;
    retryTimer=setTimeout(()=>drain().catch(()=>{}),retryDelay);retryDelay=Math.min(30000,retryDelay*2);
  }
  function drain() {
    if(worker)return worker;
    entries();if(storageError)return Promise.resolve({state:cache,result:null});
    if(entries().some(r=>!isMarking(r)))return Promise.resolve({state:cache,result:null});
    if(busy||!navigator.onLine||authBlocked){schedule();return Promise.resolve({state:cache,result:null});}
    if(!entries().some(r=>isMarking(r)&&r.local.status!=='blocked'))return Promise.resolve({state:cache,result:null});
    busy=true;emit();
    worker=(async()=>{
      await Promise.resolve();let result={state:cache,result:null};
      try {
        while(true) {
          const r=entries().find(x=>isMarking(x)&&x.local.status!=='blocked');
          if(!r||entries().some(x=>!isMarking(x)))break;
          result=await sendSaved(r);
        }
        return result;
      } finally {busy=false;worker=null;emit();schedule();}
    })();
    return worker;
  }
  async function refresh() {
    if(!venue||busy||document.hidden)return;
    try{await accept(await api());if(navigator.onLine)await drain();}
    catch(e){lastConfirmed=0;if(e.auth)authBlocked=true;emit();}
  }
  async function activate(selected) {
    venue=selected;base=null;cache=null;localStorage.setItem('pub-bizz-venue',venue.id);
    try{await accept(await api());}
    catch(e){
      if(e.auth)throw e;
      const saved=await savedSnapshot();if(!saved)throw e;await accept(saved,false);
    }
    const journal=pending();
    if(journal&&!isMarking(journal)){try{busy=true;const recovered=await sendSaved(journal);meta.recoveredResult=recovered.result;}catch(e){meta.recoveryMessage=e.message;}finally{busy=false;}}
    if(!opened){opened=true;resolveOpen(cache);}else onChange?.();
    clearInterval(poll);poll=setInterval(refresh,3000);emit();drain().catch(()=>{});
  }
  async function loadContext() {
    let context;
    try{context=await api(null,true);write(contextKey(context.user.id),context);}
    catch(e){
      const {data:{session}}=await client.auth.getSession();
      if(e.auth||!session?.user?.id)throw e;
      context=JSON.parse(localStorage.getItem(contextKey(session.user.id))||'null');
      if(!context||context.user.id!==session.user.id)throw e;
      const selected=localStorage.getItem('pub-bizz-venue');
      context={...context,venues:context.venues.filter(v=>v.id===selected)};
    }
    user=context.user;
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
        form.elements.password.value='';if(r.error) throw new Error(/egress/i.test(r.error.message||'')?'Datový limit serveru je vyčerpaný. Správce musí obnovit provoz.':'Přihlášení se nepodařilo. Zkontroluj e-mail a heslo.');
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
    if(((type==='mergeOrders'&&payload.selected!==undefined)||(type==='removeLine'&&(payload.quantity!==undefined||payload.undoOf!==undefined)))&&meta.accountActionsProtocol!==1)
      return Promise.reject(new Error('Tato oprava vyžaduje aktualizovaný server. Obnov pokladnu po aktualizaci.'));
    if(M?.types.has(type)&&localMarking()) {
      try {
        const all=entries();
        if(storageError||authBlocked||all.some(r=>!isMarking(r)))throw new Error(storageError||'Nejdřív ověř předchozí operaci nebo přihlášení.');
        if(!['owner','manager','staff'].includes(meta.role))throw new Error('Nemáš oprávnění markovat.');
        if(all.some(r=>r.local.status==='blocked'&&r.payload.orderId===payload.orderId))throw new Error('Nejdřív zkontroluj čekající konflikt tohoto účtu.');
        const id=crypto.randomUUID(),sentAt=new Date().toISOString(),p=M.prepare(cache,type,payload,id),next=structuredClone(cache);
        M.apply(next,type,p,sentAt,user.id);
        const sequence=Math.max(Date.now(),...all.map(r=>(r.local?.sequence||0)+1));
        const order=cache.orders.find(o=>o.id===p.orderId),line=order.lines.find(l=>l.id===p.lineId),product=cache.products.find(pr=>pr.id===p.productId);
        const label=p.servingMl===20&&product?root.POSCore.smallShot(product)?.name:product?.name||line?.name;
        const request={venueId:venue.id,requestId:id,type,payload:p,sentAt,local:{kind:'marking',status:'queued',sequence,orderName:order.name,label:label||'Položka',quantity:p.quantity??1}};
        // The local caller paints the returned view; notify other tabs through
        // storage events. Avoid rebuilding the bill twice for every finger tap.
        write(key(id),request);cache=next;projectionToken=projectionKey(entries());viewSerial++;emit();
        // The promise resolves after durable local storage; HTTP is independent.
        setTimeout(()=>drain().catch(()=>{}),0);
        return Promise.resolve({state:cache,result:null,local:true});
      }catch(e){return Promise.reject(e);}
    }
    const task=strictQueue.then(async()=>{
      if(entries().length||storageError)throw new Error(storageError||'Nejdřív počkej na potvrzení markování nebo ověř předchozí operaci.');
      if(!navigator.onLine||authBlocked)throw new Error('Platby a správa pokladny vyžadují spojení se serverem.');
      const request={venueId:venue.id,requestId:crypto.randomUUID(),type,payload:structuredClone(payload),sentAt:new Date().toISOString()};
      if(type==='mergeOrders'&&payload.selected!==undefined)request.payload.marking={version:2,kind:'selectedTransfer',operationId:request.requestId};
      if(type==='removeLine'&&(payload.quantity!==undefined||payload.undoOf!==undefined))request.payload=M.prepare(cache,type,payload,request.requestId);
      write(key(request.requestId),request);busy=true;emit();
      try{return await sendSaved(request);}finally{busy=false;emit();}
    });strictQueue=task.catch(()=>{});return task;
  }
  async function cancelPending() {
    if(busy)throw new Error('Operace se právě ověřuje.');
    const request=pending();if(!request){await refresh();return {cancelled:true,state:cache};}
    if(isMarking(request))throw new Error('Čekající markování nelze zahodit bez rozhodnutí serveru.');
    busy=true;emit();
    try {
      const data=await api(null,false,false,'?venueId='+encodeURIComponent(venue.id)+'&requestId='+encodeURIComponent(request.requestId));
      if(data.committed)throw new Error('Operace už byla serverem zapsaná. Nejde ji jen zahodit; použij odpovídající opravu v pokladně.');
      localStorage.removeItem(key(request.requestId));emit();return {cancelled:true,state:cache};
    }finally{busy=false;emit();}
  }
  async function retry() {
    if(busy)throw new Error('Operace se právě ověřuje.');
    authBlocked=false;storageError='';
    const request=pending();if(!request){await refresh();return {state:cache,result:null};}
    if(isMarking(request)){const r=await drain();return {...r,state:cache};}
    busy=true;emit();try{return await sendSaved(request);}finally{busy=false;emit();drain().catch(()=>{});}
  }
  function dismiss(id) {
    const request=entries().find(r=>r.requestId===id);
    if(!isMarking(request)||request.local.status!=='blocked'||M.outcome(base,id)?.type!=='markingRejected')throw new Error('Nejdřív ověř trvalé odmítnutí operace serverem.');
    localStorage.removeItem(key(id));projection();
  }
  root.POSCloud={
    get meta(){return meta;},get user(){return user;},get venue(){return venue;},get pending(){return pending();},get busy(){return busy;},get version(){return viewSerial;},
    get outbox(){return entries();},get storageError(){return storageError;},get authBlocked(){return authBlocked;},
    get serviceError(){return serviceError;},
    get optimisticMarking(){return localMarking();},
    get canMark(){const all=entries();return !!base&&localMarking()&&!storageError&&!authBlocked&&!all.some(r=>!isMarking(r))&&['owner','manager','staff'].includes(meta.role);},
    get selectedOrder(){return localStorage.getItem(selectionKey())||'bar';},
    selectOrder(id){try{if(localStorage.getItem(selectionKey())!==id)localStorage.setItem(selectionKey(),id);}catch{storageError='Výběr účtu se nepodařilo uložit. Zůstal vybraný původní host.';emit();throw new Error(storageError);}},
    get connected(){return navigator.onLine&&Date.now()-lastConfirmed<12000&&!authBlocked;},refresh,retry,cancelPending,dismiss,
    async logout(){if(busy||entries().length)throw new Error('Nejdřív ověř všechny čekající operace.');await client.auth.signOut({scope:'local'});location.reload();},
    async localBackup(){await local.open(()=>{});return local.read();}
  };
  root.POSStore={open,read:async()=>cache,command,restore:async()=>{throw new Error('Místní záloha nesmí přepsat sdílenou pokladnu. Použij původní offline verzi.');}};
  window.addEventListener('online',()=>{authBlocked=false;refresh();drain().catch(()=>{});});
  window.addEventListener('offline',()=>{lastConfirmed=0;emit();});
  window.addEventListener('focus',refresh);
  window.addEventListener('storage',async e=>{
    if(!venue||!user)return;
    if(e.key?.startsWith(prefix())||e.key?.startsWith(snapshotPrefix())) {
      try{const saved=await savedSnapshot();if(saved&&saved.state.revision>(base?.revision??-1))await accept(saved,false);else projection();if(navigator.onLine)drain().catch(()=>{});}
      catch{storageError='Potvrzené účty nelze přečíst. Čekající operace zůstávají uložené.';emit();}
    }
  });
})(globalThis);
