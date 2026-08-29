'use strict';

(function () {
  const LOCAL_STATE_KEY = 'stav_app_v1';
  let ctx = null;
  let sourceFingerprint = null;
  let sourceFileName = null;

  const backend = () => window.PubGuruBackend;
  const client = () => backend().client;
  const n = v => {
    const x = Number(String(v ?? '').replace(/\s/g, '').replace(',', '.'));
    return Number.isFinite(x) ? x : 0;
  };

  function localState() {
    try { return JSON.parse(localStorage.getItem(LOCAL_STATE_KEY) || 'null'); }
    catch { return null; }
  }
  function saveLocalState(value) { localStorage.setItem(LOCAL_STATE_KEY, JSON.stringify(value)); }
  function localProduct(id) { return localState()?.products?.find(p => p.id === id) || null; }

  async function hashFile(file) {
    const buf = await file.arrayBuffer();
    const hash = await crypto.subtle.digest('SHA-256', buf);
    return [...new Uint8Array(hash)].map(b => b.toString(16).padStart(2, '0')).join('');
  }

  async function ensureContext() {
    if (!backend()) return null;
    ctx = await backend().loadContext();
    if (!ctx?.user || !ctx?.organization || !ctx?.venue) {
      location.replace('start.html');
      return null;
    }
    return ctx;
  }

  function productPayload(localId, fallbackName) {
    const p = localProduct(localId);
    return {
      organization_id: ctx.organization.id,
      client_key: localId,
      name: p?.name || fallbackName || localId,
      category: p?.category || null,
      ean: p?.barcode || null,
      volume_ml: p?.volumeMl || null,
      abv: p?.abv ?? null,
      shot_ml: p?.shotMl || null,
      sale_price: p?.salePrice || 0,
      current_purchase_price: p?.purchasePrice || 0,
      tare_g: p?.tareG ?? null,
      full_weight_g: p?.fullWeightG ?? null,
      ml_per_g: p?.coefMlPerG ?? null,
      ref_temp_c: p?.refTempC ?? 20,
      temp_coeff_pct_per_10c: p?.tempCoeffPctPer10C ?? null,
      calibration_status: ['missing','provisional','verified'].includes(p?.calibrationStatus) ? p.calibrationStatus : 'missing',
      aliases: Array.isArray(p?.aliases) ? p.aliases : [],
      updated_at: new Date().toISOString()
    };
  }

  async function ensureProduct(localId, fallbackName) {
    const payload = productPayload(localId, fallbackName);
    let { data, error } = await client().from('products')
      .select('id,name,current_purchase_price,volume_ml')
      .eq('organization_id', ctx.organization.id).eq('client_key', localId).maybeSingle();
    if (error) throw error;
    if (data) {
      const update = await client().from('products').update(payload).eq('id', data.id);
      if (update.error) throw update.error;
      return { ...data, name: payload.name, current_purchase_price: payload.current_purchase_price, volume_ml: payload.volume_ml };
    }
    const inserted = await client().from('products').insert(payload)
      .select('id,name,current_purchase_price,volume_ml').single();
    if (inserted.error) throw inserted.error;
    return inserted.data;
  }

  function snapshotInvoice() {
    const rows = [...document.querySelectorAll('#invoiceLines .invoice-line')].map(row => {
      const productSelect = row.querySelector('.line-product');
      return {
        rawName: row.querySelector('.line-raw')?.value?.trim() || '',
        localProductId: productSelect?.value || '',
        productName: productSelect?.selectedOptions?.[0]?.textContent?.trim() || '',
        qty: n(row.querySelector('.line-qty')?.value),
        unitPrice: n(row.querySelector('.line-price')?.value),
        state: row.querySelector('.line-state')?.value || 'new'
      };
    });
    return {
      supplier: document.getElementById('supplierName')?.value?.trim() || '',
      number: document.getElementById('invoiceNumber')?.value?.trim() || '',
      date: document.getElementById('invoiceDate')?.value || new Date().toISOString().slice(0, 10),
      rawText: document.getElementById('ocrText')?.value || '',
      rows, fingerprint: sourceFingerprint, fileName: sourceFileName
    };
  }

  async function duplicateInvoice(fingerprint) {
    if (!fingerprint) return null;
    const { data, error } = await client().from('invoices')
      .select('id,invoice_number,issue_date,status')
      .eq('organization_id', ctx.organization.id).eq('source_fingerprint', fingerprint).maybeSingle();
    if (error) throw error;
    return data || null;
  }

  async function persistInvoice(snapshot) {
    const approved = snapshot.rows.filter(r => r.state === 'approved' && r.localProductId && r.qty > 0);
    if (!approved.length) return;
    if (snapshot.fingerprint && await duplicateInvoice(snapshot.fingerprint)) {
      window.toast?.('Faktura už je v PUB GURU databázi.', 5000); return;
    }

    const total = approved.reduce((s, r) => s + r.qty * r.unitPrice, 0);
    const { data: invoice, error: invoiceError } = await client().from('invoices').insert({
      organization_id: ctx.organization.id, venue_id: ctx.venue.id, supplier_name: snapshot.supplier,
      invoice_number: snapshot.number, issue_date: snapshot.date, total_amount: total,
      source_fingerprint: snapshot.fingerprint, source_file_name: snapshot.fileName,
      raw_extraction: { raw_text: snapshot.rawText, source: 'browser_ocr_v1' }, extraction_provider: 'tesseract-browser',
      status: 'posted', created_by: ctx.user.id, approved_at: new Date().toISOString(), approved_by: ctx.user.id
    }).select('id').single();
    if (invoiceError) throw invoiceError;

    for (const row of approved) {
      const product = await ensureProduct(row.localProductId, row.productName || row.rawName);
      const lineInsert = await client().from('invoice_lines').insert({
        invoice_id: invoice.id, organization_id: ctx.organization.id, raw_name: row.rawName, product_id: product.id,
        quantity: row.qty, unit: 'ks', unit_price: row.unitPrice, line_total: row.qty * row.unitPrice,
        match_method: 'confirmed_local_mapping', match_confidence: 1, status: 'approved',
        original_values: { raw_name: row.rawName, local_product_id: row.localProductId }
      }).select('id').single();
      if (lineInsert.error) throw lineInsert.error;

      const priceInsert = await client().from('purchase_price_history').insert({
        organization_id: ctx.organization.id, venue_id: ctx.venue.id, product_id: product.id,
        invoice_line_id: lineInsert.data.id, unit_price: row.unitPrice
      });
      if (priceInsert.error) throw priceInsert.error;

      const productUpdate = await client().from('products')
        .update({ current_purchase_price: row.unitPrice, updated_at: new Date().toISOString() }).eq('id', product.id);
      if (productUpdate.error) throw productUpdate.error;
    }

    const audit = await client().from('audit_events').insert({
      organization_id: ctx.organization.id, venue_id: ctx.venue.id, actor_user_id: ctx.user.id,
      event_type: 'invoice.posted', entity_type: 'invoice', entity_id: invoice.id,
      after_data: { supplier: snapshot.supplier, number: snapshot.number, date: snapshot.date, approved_lines: approved.length, total }
    });
    if (audit.error) throw audit.error;
    window.toast?.(`Faktura uložena do PUB GURU: ${approved.length} položek.`, 4500);
  }

  async function persistInventoryEvidence() {
    const state = localState();
    const inv = state?.currentInventory;
    const lines = inv?.lines || [];
    if (!lines.length) { window.toast?.('Inventura zatím nemá žádnou položku.'); return; }

    const { data: session, error: sessionError } = await client().from('inventory_sessions').insert({
      organization_id: ctx.organization.id,
      venue_id: ctx.venue.id,
      status: 'closed',
      started_at: inv.startedAt || new Date(`${inv.date || new Date().toISOString().slice(0,10)}T00:00:00`).toISOString(),
      closed_at: new Date().toISOString(),
      created_by: ctx.user.id
    }).select('id').single();
    if (sessionError) throw sessionError;

    let issueCount = 0;
    let purchaseImpact = 0;
    let saleImpact = 0;
    for (const line of lines) {
      const p = state.products?.find(x => x.id === line.productId);
      const product = await ensureProduct(line.productId, p?.name || 'Produkt');
      if (line.status === 'issue') issueCount += 1;
      purchaseImpact += n(line.costDifference ?? line.purchaseValueDifference);
      saleImpact += n(line.saleDifference ?? line.saleValueDifference);
      const insert = await client().from('inventory_lines').insert({
        inventory_session_id: session.id,
        organization_id: ctx.organization.id,
        product_id: product.id,
        expected_ml: n(line.expectedMl),
        measured_ml: n(line.actualMl ?? line.measuredMl),
        difference_ml: n(line.diffMl ?? line.differenceMl),
        gross_weight_g: n(line.grossWeightG),
        sealed_count: n(line.sealedCount),
        temperature_c: n(line.tempC),
        purchase_value_difference: n(line.costDifference ?? line.purchaseValueDifference),
        sale_value_difference: n(line.saleDifference ?? line.saleValueDifference),
        note: line.note || null,
        measured_at: line.measuredAt || new Date().toISOString(),
        measured_by: ctx.user.id,
        original_measurement: line
      });
      if (insert.error) throw insert.error;
    }

    const audit = await client().from('audit_events').insert({
      organization_id: ctx.organization.id,
      venue_id: ctx.venue.id,
      actor_user_id: ctx.user.id,
      event_type: 'inventory.closed_without_adjustment',
      entity_type: 'inventory_session',
      entity_id: session.id,
      after_data: { line_count: lines.length, issue_count: issueCount, purchase_value_difference: purchaseImpact, sale_value_difference: saleImpact }
    });
    if (audit.error) throw audit.error;

    state.inventorySessions = Array.isArray(state.inventorySessions) ? state.inventorySessions : [];
    state.inventorySessions.push({ ...inv, backendId: session.id, closedAt: new Date().toISOString(), adjustmentApplied: false });
    state.currentInventory = { id: `inv_${Date.now().toString(36)}`, date: new Date().toISOString().slice(0,10), zoneId: inv.zoneId || 'shelf', tempC: inv.tempC ?? 20, lines: [] };
    saveLocalState(state);
    window.toast?.(`Inventura uzavřena: ${lines.length} položek. Sklad nebyl automaticky přepsán.`, 5500);
    setTimeout(() => location.reload(), 900);
  }

  async function init() {
    try {
      if (!await ensureContext()) return;
      const fileInput = document.getElementById('invoiceFile');
      fileInput?.addEventListener('change', async event => {
        const file = event.target.files?.[0]; if (!file) return;
        try {
          sourceFingerprint = await hashFile(file); sourceFileName = file.name || 'invoice';
          const duplicate = await duplicateInvoice(sourceFingerprint);
          if (duplicate) window.toast?.(`Pozor: tento soubor už je uložen jako faktura ${duplicate.invoice_number || ''}.`, 5500);
        } catch (error) { console.error('Invoice fingerprint failed', error); }
      });

      document.getElementById('saveReceiptBtn')?.addEventListener('click', () => {
        const snapshot = snapshotInvoice();
        setTimeout(async () => {
          try { await persistInvoice(snapshot); }
          catch (error) { console.error(error); window.toast?.(`Databázové uložení faktury selhalo: ${error.message}`, 6500); }
        }, 0);
      }, true);

      document.getElementById('closeInventoryBtn')?.addEventListener('click', async event => {
        event.preventDefault();
        event.stopImmediatePropagation();
        try { await persistInventoryEvidence(); }
        catch (error) { console.error(error); window.toast?.(`Uzavření inventury selhalo: ${error.message}`, 6500); }
      }, true);
    } catch (error) {
      console.error(error); window.toast?.(`PUB GURU backend: ${error.message}`, 6500);
    }
  }

  document.addEventListener('DOMContentLoaded', init);
})();
