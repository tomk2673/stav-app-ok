(function(root){'use strict';
if(!root.globalThis) root.globalThis=root;
if(!root.structuredClone) root.structuredClone=function(value){return JSON.parse(JSON.stringify(value));};
if(root.crypto&&!root.crypto.randomUUID&&root.crypto.getRandomValues){
 root.crypto.randomUUID=function(){var b=new Uint8Array(16);root.crypto.getRandomValues(b);b[6]=(b[6]&15)|64;b[8]=(b[8]&63)|128;var h=[];for(var i=0;i<16;i++)h.push((b[i]+256).toString(16).slice(1));return h.slice(0,4).join('')+'-'+h.slice(4,6).join('')+'-'+h.slice(6,8).join('')+'-'+h.slice(8,10).join('')+'-'+h.slice(10).join('');};
}
})(typeof globalThis!=='undefined'?globalThis:window);

// Keep this guard in ES5 so even a browser that cannot parse app.js gets a remedy.
(function(root){'use strict';
  var failure='';
  function fail(message){
    failure=message;
    var app=document.getElementById('app');
    if(!app)return;
    var panel=document.createElement('section'),title=document.createElement('h1'),detail=document.createElement('p'),help=document.createElement('p');
    panel.className='panel login-panel';title.textContent='Pokladnu nelze otevřít';
    detail.className='error section-gap';detail.textContent=message;
    help.className='section-gap';help.textContent='Na Windows 7 použij aktuální Firefox ESR 115 v běžném okně. Nic nemaž; pokud chyba přetrvá, obnov stránku a zkontroluj připojení.';
    panel.appendChild(title);panel.appendChild(detail);panel.appendChild(help);
    app.textContent='';app.appendChild(panel);
    var status=document.getElementById('save-state'),network=document.getElementById('network');
    if(status){status.textContent='Pokladna není připravená';status.className='save-state error';}
    if(network){network.textContent='Pokladna není připravená';network.className='network offline';}
  }
  function assertReady(){
    if(failure)throw new Error(failure);
    var standalone=document.documentElement.getAttribute('data-standalone')==='true';
    var dialog=root.HTMLDialogElement&&root.HTMLDialogElement.prototype;
    if(!root.Promise||!root.Map||!root.Set||!root.FormData||!root.URL||!root.URLSearchParams||
       !root.AbortController||!root.TextEncoder||!root.Intl||!root.Intl.NumberFormat||
       !Object.fromEntries||!Array.prototype.find||!Array.prototype.includes||
       !String.prototype.normalize||!String.prototype.replaceAll||!dialog||!dialog.showModal||!dialog.close||
       (!standalone&&(!root.fetch||!root.WebSocket))){
      throw new Error('Prohlížeč je příliš starý nebo mu chybí funkce potřebné pro pokladnu.');
    }
    if(!standalone&&root.location.protocol!=='https:'&&
       !/^(localhost|127\.0\.0\.1|\[::1\])$/.test(root.location.hostname)){
      throw new Error('Sdílenou pokladnu otevři přes zabezpečenou adresu https://.');
    }
    if(!root.crypto||!root.crypto.getRandomValues||!root.crypto.randomUUID||!root.crypto.subtle){
      throw new Error('Není dostupné zabezpečené generování ID a ověřování záloh. Zkontroluj https:// a prohlížeč.');
    }
    if(!standalone){
      // Supabase may fall back to memory, but the POS must retain unacknowledged IDs.
      var probe='pub-bizz-storage-check:'+root.crypto.randomUUID();
      try{
        var storage=root.localStorage;
        storage.setItem(probe,probe);
        if(storage.getItem(probe)!==probe)throw new Error('Storage did not retain the probe');
        storage.removeItem(probe);
      }catch(e){
        throw new Error('Prohlížeč nemůže uložit přihlášení a nepotvrzené operace. Povol data webu a použij běžné okno s volným místem.');
      }
    }
  }
  root.POSRuntime={assertReady:assertReady,fail:fail,getError:function(){return failure;}};
  root.addEventListener('error',function(event){
    var target=event.target;
    if(target&&target.tagName==='SCRIPT'&&target.src){
      fail('Nepodařilo se načíst všechny součásti pokladny. Obnov stránku a zkontroluj připojení.');
    }
  },true);
  document.addEventListener('DOMContentLoaded',function(){
    try{assertReady();}catch(e){fail(e.message);}
  });
})(window);
