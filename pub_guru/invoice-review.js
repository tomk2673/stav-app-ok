'use strict';

(function () {
  let ctx = null;
  let products = [];
  let currentInvoice = null;
  let currentLines = [];

  const client = () => window.PubGuruBackend.client;
  const $ = id => document.getElementById(id);
  const esc = v => String(v ?? '').replace(/[&<>'"]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;',"'":'&#39;','"':'&quot;'}[c]));
  const n = v => { const x = Number(String(v ?? '').replace(/\s/g,'').replace(',','.')); return Number.isFinite(x) ? x : 0; };
  const money = v => new Intl.NumberFormat('cs-CZ',{style:'currency',currency:'CZK',maximumFractionDigits:2}).format(n(v));

  function toast(message, ms = 4500) {
    const el = $('toast'); el.textContent = message; el.classList.remove('hidden');
    clearTimeout(toast.t); toast.t = setTimeout(() => el.classList.add('hidden'), ms);
  }

  function extractVolumeMl(text) {
    const s = String(text || '');
    const ml = s.match(/(\d{2,4})\s*ml\b/i); if (ml) return n(ml[1]);
    const l = s.match(/(\d+(?:[.,]\d+)?)\s*l\b/i); if (l) return n(l[1]) * 1000;
    return 0;
  }

  async function ensureRole() {
    ctx = await window.PubGuruBackend.loadContext();
    if (!ctx?.user || !ctx?.organization || !ctx?.venue) { location.replace('start.html'); return false; }
    if (!['owner','manager'].includes(ctx.role)) { location.replace('index.html#invoices'); return false; }
    $('roleBadge').textContent = ctx.role === 'owner' ? 'Majitel' : 'Vedoucí';
    return true;
  }

  async function loadProducts() {
    const { data, error } = await client().from('products')
      .select('id,client_key,name,ean,volume_ml,current_purchase_price')
      .eq('organization_id', ctx.organization.id).is('archived_at', null).order('name');
    if (error) throw error;
    products = data || [];
  }

  function productOptions(selected) {
    return `<option value="">Vyber produkt…</option>` + products.map(p =>
      `<option value="${p.id}" ${p.id === selected ? 'selected' : ''}>${esc(p.name)}${p.ean ? ` · ${esc(p.ean)}` : ''}${p.volume_ml ? ` · ${n(p.volume_ml)} ml` : ''}</option>`
    ).join('');
  }

  async function loadQueue() {
    const { data, error } = await client().from('invoices')
      .select('id,supplier_name,invoice_number,issue_date,total_amount,status,created_at,created_by')
      .eq('organization_id', ctx.organization.id).eq('venue_id', ctx.venue.id)
      .in('status', ['review','approved']).order('created_at', { ascending: false }).limit(100);
    if (error) throw error;
    $('queueCount').textContent = String(data?.length || 0);
    $('queue').innerHTML = data?.length ? data.map(i => `
      <button class="queue-item ${currentInvoice?.id === i.id ? 'active' : ''}" data-id="${i.id}">
        <strong>${esc(i.supplier_name || 'Bez dodavatele')}</strong>
        <small>${esc(i.invoice_number || 'bez čísla')} · ${esc(i.issue_date || '')} · ${money(i.total_amount || 0)} · ${i.status === 'approved' ? 'rozpracované schválení' : 'ke kontrole'}</small>
      </button>`).join('') : '<div class="empty">Žádná faktura nečeká na schválení.</div>';
    document.querySelectorAll('.queue-item').forEach(btn => btn.addEventListener('click', () => openInvoice(btn.dataset.id)));
  }

  async function openInvoice(id) {
    const [invoiceResult, linesResult] = await Promise.all([
      client().from('invoices').select('id,supplier_name,invoice_number,issue_date,total_amount,status,raw_extraction').eq('id', id).single(),
      client().from('invoice_lines').select('id,raw_name,product_id,quantity,unit_price,line_total,status,original_values').eq('invoice_id', id).order('created_at')
    ]);
    if (invoiceResult.error) throw invoiceResult.error;
    if (linesResult.error) throw linesResult.error;
    currentInvoice = invoiceResult.data;
    currentLines = linesResult.data || [];
    $('supplier').value = currentInvoice.supplier_name || '';
    $('number').value = currentInvoice.invoice_number || '';
    $('date').value = currentInvoice.issue_date || '';
    $('invoiceStatus').textContent = currentInvoice.status;
    $('rawOcr').textContent = currentInvoice.raw_extraction?.raw_text || '';
    $('editor').classList.remove('hidden'); $('emptyEditor').classList.add('hidden');
    renderLines(); await loadQueue();
  }

  function renderLines() {
    $('lines').innerHTML = currentLines.length ? currentLines.map((line, index) => {
      const p = products.find(x => x.id === line.product_id);
      const detected = extractVolumeMl(line.raw_name);
      const volume = p?.volume_ml ? n(p.volume_ml) : detected;
      const status = line.status === 'ignored' ? 'ignored' : 'approved';
      return `<div class="review-line" data-index="${index}">
        <label class="raw">Text z faktury<input class="raw-name" value="${esc(line.raw_name)}" readonly /></label>
        <label class="product">Produkt<select class="product-id">${productOptions(line.product_id)}</select></label>
        <label>Ks<input class="qty" type="number" min="0" step="0.01" value="${line.quantity ?? ''}" /></label>
        <label>Cena/ks<input class="price" type="number" min="0" step="0.01" value="${line.unit_price ?? ''}" /></label>
        <label>Objem ml<input class="volume" type="number" min="1" step="1" value="${volume || ''}" /></label>
        <label>Akce<select class="line-status"><option value="approved" ${status === 'approved' ? 'selected' : ''}>Schválit</option><option value="ignored" ${status === 'ignored' ? 'selected' : ''}>Ignorovat</option></select></label>
      </div>`;
    }).join('') : '<div class="empty">Faktura nemá žádné řádky.</div>';
  }

  function readRows() {
    return [...document.querySelectorAll('.review-line')].map(row => {
      const source = currentLines[Number(row.dataset.index)];
      return {
        id: source.id,
        rawName: row.querySelector('.raw-name').value,
        productId: row.querySelector('.product-id').value,
        qty: n(row.querySelector('.qty').value),
        price: n(row.querySelector('.price').value),
        volume: n(row.querySelector('.volume').value),
        status: row.querySelector('.line-status').value
      };
    });
  }

  async function ensureHistory(lineId, productId, price) {
    const existing = await client().from('purchase_price_history').select('id').eq('invoice_line_id', lineId).maybeSingle();
    if (existing.error) throw existing.error;
    if (!existing.data) {
      const insert = await client().from('purchase_price_history').insert({
        organization_id: ctx.organization.id, venue_id: ctx.venue.id, product_id: productId,
        invoice_line_id: lineId, unit_price: price
      });
      if (insert.error) throw insert.error;
    }
  }

  async function postInvoice() {
    if (!currentInvoice) return;
    const rows = readRows();
    const approved = rows.filter(r => r.status === 'approved');
    if (!approved.length) return toast('Schval alespoň jednu položku.');
    for (const row of approved) {
      if (!row.productId) return toast(`Vyber produkt pro: ${row.rawName}`);
      if (row.qty <= 0) return toast(`Doplň množství pro: ${row.rawName}`);
      if (row.volume <= 0) return toast(`Doplň objem balení v ml pro: ${row.rawName}`);
    }

    $('postBtn').disabled = true; $('postBtn').textContent = 'Zaúčtovávám…';
    try {
      let total = 0;
      for (const row of rows) {
        if (row.status === 'approved') total += row.qty * row.price;
        const updateLine = await client().from('invoice_lines').update({
          product_id: row.status === 'approved' ? row.productId : null,
          quantity: row.qty || null,
          unit_price: row.price || null,
          line_total: row.qty && row.price ? row.qty * row.price : null,
          status: row.status,
          match_method: row.status === 'approved' ? 'manager_confirmed' : 'manager_ignored',
          match_confidence: row.status === 'approved' ? 1 : null
        }).eq('id', row.id);
        if (updateLine.error) throw updateLine.error;

        if (row.status === 'approved') {
          const product = products.find(p => p.id === row.productId);
          const productUpdate = await client().from('products').update({
            volume_ml: row.volume,
            current_purchase_price: row.price,
            updated_at: new Date().toISOString()
          }).eq('id', row.productId);
          if (productUpdate.error) throw productUpdate.error;
          await ensureHistory(row.id, row.productId, row.price);
          if (product) { product.volume_ml = row.volume; product.current_purchase_price = row.price; }
        }
      }

      const invoiceUpdate = await client().from('invoices').update({
        supplier_name: $('supplier').value.trim(), invoice_number: $('number').value.trim(),
        issue_date: $('date').value || null, total_amount: total, status: 'approved'
      }).eq('id', currentInvoice.id).in('status', ['review','approved']);
      if (invoiceUpdate.error) throw invoiceUpdate.error;

      const audit = await client().from('audit_events').insert({
        organization_id: ctx.organization.id, venue_id: ctx.venue.id, actor_user_id: ctx.user.id,
        event_type: 'invoice.posted', entity_type: 'invoice', entity_id: currentInvoice.id,
        after_data: { approved_lines: approved.length, total, supplier: $('supplier').value.trim(), invoice_number: $('number').value.trim() }
      });
      if (audit.error) throw audit.error;

      toast(`Faktura schválena. ${approved.length} položek bylo naskladněno.`, 6000);
      currentInvoice = null; currentLines = [];
      $('editor').classList.add('hidden'); $('emptyEditor').classList.remove('hidden');
      sessionStorage.removeItem('pub_guru_backend_sync_v1');
      await loadQueue();
    } finally {
      $('postBtn').disabled = false; $('postBtn').textContent = 'Schválit a naskladnit';
    }
  }

  async function init() {
    try {
      if (!await ensureRole()) return;
      await loadProducts(); await loadQueue();
      $('postBtn').addEventListener('click', () => postInvoice().catch(e => { console.error(e); toast(`Zaúčtování selhalo: ${e.message}`, 7000); }));
    } catch (e) { console.error(e); toast(`Nelze načíst frontu: ${e.message}`, 7000); }
  }

  document.addEventListener('DOMContentLoaded', init);
})();
