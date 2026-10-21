(function(root){
  'use strict';
  const E=s=>String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  const norm=s=>s.toLocaleLowerCase('cs').normalize('NFD').replace(/[\u0300-\u036f]/g,'');
  function render(s) {
    const meta=POSCloud.meta,recipes=s.recipes||{},active=s.products.filter(p=>p.active),mapped=active.filter(p=>recipes[p.id]).length;
    const stock=new Map(meta.stock.map(x=>[x.id,x]));
    const readable=r=>r.mode==='no_stock'?'Bez odpisu · '+r.reason:r.components.map(c=>`${c.quantity} ${c.unit} ${stock.get(c.productId)?.name||'Nedostupná surovina'}`).join(' + ');
    return `<section class="page"><div class="workspace-heading"><div><h1>Pokladna a sklad</h1><p>Stejné zásoby jako ve fakturách a inventurách PUB GURU.</p></div><span class="tag">${mapped} / ${active.length} položek nastaveno</span></div><div class="panel"><h3>Odpis podle jedné porce</h3><p>Pro každou položku vyber suroviny a množství z vašeho skladu. Koktejl může odepisovat několik surovin. Dokud receptura chybí, prodej zůstává ve frontě k doplnění. Výběr „bez odpisu“ je určen například pro službu.</p></div>${meta.issueCount?`<div class="panel"><h3>Odpisy ke kontrole · ${meta.issueCount}</h3><p>Po doplnění receptury můžeš chybějící odpis provést i k už zaplacenému prodeji.</p><div class="stock-issues">${meta.issues.map(i=>`<div class="stock-issue"><div><strong>${E(i.quantity)}× ${E(i.label)}</strong><p>${E(i.reason)} · ${E(i.receipt_id.slice(0,8))}</p></div>${['missing_recipe','awaiting_stock'].includes(i.status)?`<button class="secondary" data-action="${recipes[i.pos_product_id]?'resolveStock':'recipe'}" data-id="${E(recipes[i.pos_product_id]?i.receipt_id+':'+i.line_id:i.pos_product_id)}">${recipes[i.pos_product_id]?'Provést odpis':'Nastavit recepturu'}</button>`:'<span class="tag orange">Nedostatek kusů ve skladu</span>'}</div>`).join('')}</div>${meta.issueCount>meta.issues.length?'<p class="section-gap">Zobrazeno nejnovějších 200 záznamů. Další se načtou po vyřešení chybějících odpisů.</p>':''}</div>`:''}<div class="search"><label class="sr-only" for="recipe-search">Najít položku pro recepturu</label><input id="recipe-search" type="search" placeholder="Najít nápoj nebo číslo z Agnisu…"></div><div class="table-wrap"><table><thead><tr><th>Položka ceníku</th><th>Suroviny na jednu porci</th><th></th></tr></thead><tbody>${active.map(p=>`<tr data-recipe-search="${E(norm(p.name+' '+p.sourceCode))}"><td><strong>${E(p.name)}</strong><br><span class="muted small">Agnis #${E(p.sourceCode)}</span></td><td>${recipes[p.id]?E(readable(recipes[p.id])):'<span class="tag orange">Chybí receptura</span>'}</td><td><button class="secondary" data-action="recipe" data-id="${E(p.id)}">${recipes[p.id]?'Upravit':'Napojit sklad'}</button></td></tr>`).join('')}</tbody></table></div></section>`;
  }
  function bind(){document.querySelector('#recipe-search')?.addEventListener('input',e=>{const q=norm(e.target.value);document.querySelectorAll('[data-recipe-search]').forEach(r=>r.hidden=!r.dataset.recipeSearch.includes(q));});}
  function edit(s,id,dialog,command,toast){
    const p=s.products.find(x=>x.id===id),stock=POSCloud.meta.stock;if(!p)throw new Error('Položka neexistuje.');
    const recipe=s.recipes?.[id]||{version:0,mode:'recipe',reason:'',components:[]};
    let counter=0;
    const row=c=>`<div class="recipe-row" data-row="${counter++}"><label class="field">Surovina ze skladu<select class="recipe-product" required><option value="">Vyber surovinu…</option>${stock.map(x=>`<option value="${E(x.id)}" ${x.id===c?.productId?'selected':''}>${E(x.name)}</option>`).join('')}</select></label><label class="field">Množství / porce<input class="recipe-quantity" type="number" inputmode="decimal" min="0.001" max="1000000" step="0.001" value="${E(c?.quantity??'')}" required></label><span class="recipe-unit">${stock.find(x=>x.id===c?.productId)?.unit_mode==='counted'?'ks':'ml'}</span><button type="button" class="iconbutton recipe-remove" aria-label="Odebrat surovinu">×</button></div>`;
    dialog('Skladový odpis · '+p.name,`<p class="help">Zadej skutečnou spotřebu na <strong>jednu prodanou porci</strong>. Například 0,04 l je 40 ml. Velikost lahve není velikost porce.${POSCore.shotVolumeMl(p)?` Pro přepínač 2 cl nastav běžnou ${POSCore.shotVolumeMl(p)/10}cl porci v mililitrech; malý panák se přepočítá na 20 ml.`:''}</p><label class="field">Typ prodeje<select name="saleStockType"><option value="mix">Míchaný nápoj / vlastní spotřeba</option><option value="pieces">Balený nápoj · 1 ks za prodej</option><option value="shot">Samostatný panák · 4 cl (2 cl volbou v pokladně)</option><option value="no_stock">Neskladová položka</option></select></label><p class="help" id="stock-type-help">Vyber konkrétní skladovou položku; podle názvu se automaticky nepřiřazuje.</p><label class="field">Způsob odpisu<select name="recipeMode"><option value="recipe" ${recipe.mode==='recipe'?'selected':''}>Odepsat suroviny ze skladu</option><option value="no_stock" ${recipe.mode==='no_stock'?'selected':''}>Položka nemá skladový odpis</option></select></label><div id="recipe-components" class="section-gap">${(recipe.components.length?recipe.components:[null]).map(row).join('')}</div><button type="button" id="recipe-add" class="secondary section-gap">+ Další surovina</button><label class="field section-gap">Poznámka / důvod bez odpisu<input name="recipeReason" maxlength="240" value="${E(recipe.reason)}"></label>`,async f=>{
      const components=Array.from(document.querySelectorAll('.recipe-row')).map(r=>{const productId=r.querySelector('.recipe-product').value;return{productId,quantity:Number(r.querySelector('.recipe-quantity').value),unit:stock.find(x=>x.id===productId)?.unit_mode==='counted'?'ks':'ml'};});
      const type=document.querySelector('#dialog-form').elements.saleStockType.value;
      if(type==='pieces'||type==='shot'){
        const expectedUnit=type==='pieces'?'ks':'ml',expectedQty=type==='pieces'?1:POSCore.shotVolumeMl(p);
        if(!expectedQty||components.length!==1||!components[0].productId||components[0].unit!==expectedUnit||components[0].quantity!==expectedQty)
          throw new Error('Vyber jednu odpovídající skladovou položku ('+expectedQty+' '+expectedUnit+' na prodej).');
      }
      await command('recipe',{productId:id,version:recipe.version,mode:f.get('recipeMode'),reason:f.get('recipeReason'),components});
    },'Uložit recepturu',()=>toast('Receptura uložená. Nové prodeje se budou odepisovat podle ní.'));
    const form=document.querySelector('#dialog-form');
    const mode=()=>{const enabled=form.elements.recipeMode.value==='recipe';document.querySelector('#recipe-components').hidden=!enabled;document.querySelector('#recipe-add').hidden=!enabled;document.querySelectorAll('.recipe-product,.recipe-quantity').forEach(x=>x.required=enabled);form.elements.recipeReason.required=!enabled;};
    function wire(){document.querySelectorAll('.recipe-row').forEach(r=>{r.querySelector('.recipe-remove').onclick=()=>r.remove();r.querySelector('.recipe-product').onchange=e=>{r.querySelector('.recipe-unit').textContent=stock.find(x=>x.id===e.target.value)?.unit_mode==='counted'?'ks':'ml';};});mode();}
    document.querySelector('#recipe-add').onclick=()=>{document.querySelector('#recipe-components').insertAdjacentHTML('beforeend',row(null));wire();};
    form.elements.recipeMode.onchange=mode;wire();
    const type=form.elements.saleStockType;
    const quantity=()=>document.querySelector('.recipe-quantity');
    const selectedStock=()=>stock.find(x=>x.id===document.querySelector('.recipe-product')?.value);
    const initial=recipe.mode==='no_stock'?'no_stock':
      recipe.components?.length===1&&recipe.components[0].unit==='ks'&&recipe.components[0].quantity===1?'pieces':
      recipe.components?.length===1&&recipe.components[0].unit==='ml'&&recipe.components[0].quantity===POSCore.shotVolumeMl(p)?'shot':'mix';
    type.value=initial;
    const applyType=()=>{
      const simple=['pieces','shot'].includes(type.value);
      const isNoStock=type.value==='no_stock';
      form.elements.recipeMode.value=isNoStock?'no_stock':'recipe';
      mode();
      if(simple){
        const wanted=type.value==='pieces'?'counted':'measured';
        const rows=[...document.querySelectorAll('.recipe-row')];
        rows.slice(1).forEach(r=>r.remove());
        const field=quantity(),selector=document.querySelector('.recipe-product');
        [...selector.options].forEach(opt=>{if(!opt.value)return;const item=stock.find(x=>x.id===opt.value);opt.disabled=!!item&&((item.unit_mode==='counted')!==(wanted==='counted'));});
        if(selectedStock()&&((selectedStock().unit_mode==='counted')!==(wanted==='counted')))selector.value='';
        field.value=type.value==='pieces'?1:POSCore.shotVolumeMl(p)||'';
        field.readOnly=true;
        document.querySelector('.recipe-unit').textContent=type.value==='pieces'?'ks':'ml';
      } else {
        document.querySelectorAll('.recipe-product option').forEach(o=>o.disabled=false);
        if(quantity())quantity().readOnly=false;
      }
      document.querySelector('#recipe-add').hidden=type.value!=='mix';
      document.querySelector('#stock-type-help').textContent=type.value==='pieces'?'Každý prodej odečte právě 1 kus ze zvolené skladové položky.':type.value==='shot'?'Jedna velká porce odečte 40 ml, tlačítko 2 cl odečte 20 ml.':type.value==='no_stock'?'Pouze pro skutečně neskladové položky.':'Sestav spotřebu míchaného nápoje z jednotlivých surovin.';
    };
    type.addEventListener('change',applyType);
    if(!POSCore.shotVolumeMl(p)){
      type.querySelector('option[value="shot"]').disabled=true;
      if(type.value==='shot')type.value='mix';
    }
    applyType();
  }
  root.POSStockUI={render,bind,edit};
})(globalThis);
