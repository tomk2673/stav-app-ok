'use strict';

(function(){
  let mappings=[];
  let ctx=null;
  let applying=false;
  const $=id=>document.getElementById(id);

  function normalize(s){
    return String(s||'').toLowerCase().normalize('NFD')
      .replace(/[\u0300-\u036f]/g,'')
      .replace(/[^a-z0-9]+/g,' ').trim();
  }

  function supplierKey(){
    const supplier=normalize($('supplier')?.value||'');
    if(supplier.includes('rojal')) return 'rojal';
    const raw=$('ocrText')?.value||'';
    if(/\bROJAL\b/i.test(raw)) return 'rojal';
    return supplier.replace(/\s+/g,'_').slice(0,80)||'unknown';
  }

  function codeFromMeta(line){
    const meta=line.querySelector('.line-meta')?.textContent||'';
    const m=meta.match(/k[oó]d\s+([A-Z0-9-]+)/i);
    return m?m[1].toUpperCase():'';
  }

  function applyMappings(){
    if(applying||!mappings.length) return;
    applying=true;
    try{
      const sk=supplierKey();
      document.querySelectorAll('#lines .line').forEach(line=>{
        const select=line.querySelector('.productId');
        if(!select||select.value) return;
        const code=codeFromMeta(line);
        if(!code) return;
        const hit=mappings.find(m=>m.supplier_key===sk&&String(m.source_code||'').toUpperCase()===code);
        if(!hit||![...select.options].some(o=>o.value===hit.product_id)) return;
        select.value=hit.product_id;
        select.dispatchEvent(new Event('change',{bubbles:true}));
        const meta=line.querySelector('.line-meta');
        if(meta&&!/naučené párování/i.test(meta.textContent)) meta.textContent += ' · ✓ naučené párování';
      });
    }finally{applying=false;}
  }

  async function init(){
    ctx=await window.PubGuruBackend.loadContext();
    if(!ctx?.organization) return;
    const r=await window.PubGuruBackend.client.from('supplier_product_mappings')
      .select('supplier_key,source_code,product_id,normalized_raw_name,confidence')
      .eq('organization_id',ctx.organization.id);
    if(r.error){console.warn('Supplier learning unavailable',r.error);return;}
    mappings=r.data||[];
    const target=$('lines');
    if(target){
      new MutationObserver(()=>applyMappings()).observe(target,{childList:true,subtree:true});
      applyMappings();
    }
    $('supplier')?.addEventListener('change',applyMappings);
  }

  document.addEventListener('DOMContentLoaded',()=>init().catch(err=>console.warn('Invoice learning init failed',err)));
})();
