'use strict';

(function () {
  const LOCAL_STATE_KEY = 'stav_app_v1';
  let syncing = null;
  let localStateRetries = 0;

  function readLocal() {
    try { return JSON.parse(localStorage.getItem(LOCAL_STATE_KEY) || 'null'); }
    catch { return null; }
  }
  function writeLocal(value) { localStorage.setItem(LOCAL_STATE_KEY, JSON.stringify(value)); }

  function unitMode(value) {
    return ['liquid', 'unit', 'counted'].includes(value) ? value : 'liquid';
  }

  function toDbProduct(p, organizationId) {
    return {
      organization_id: organizationId,
      client_key: p.id,
      name: p.name,
      category: p.category || null,
      ean: p.barcode || null,
      volume_ml: p.volumeMl || null,
      abv: p.abv ?? null,
      shot_ml: p.shotMl || null,
      sale_price: Number(p.salePrice || 0),
      current_purchase_price: Number(p.purchasePrice || 0),
      tare_g: p.tareG ?? null,
      full_weight_g: p.fullWeightG ?? null,
      ml_per_g: p.coefMlPerG ?? null,
      ref_temp_c: p.refTempC ?? 20,
      temp_coeff_pct_per_10c: p.tempCoeffPctPer10C ?? null,
      calibration_status: ['missing','provisional','verified'].includes(p.calibrationStatus) ? p.calibrationStatus : 'missing',
      aliases: Array.isArray(p.aliases) ? p.aliases : [],
      unit_mode: unitMode(p.unitMode),
      item_kind: p.unitMode === 'counted' ? p.itemKind : 'product',
      item_subtype: p.unitMode === 'counted' ? p.itemSubtype : null,
      count_unit: p.countUnit || 'ks',
      storage_zone_key: p.zoneId || null,
      updated_at: new Date().toISOString()
    };
  }

  function fromDbProduct(p, fallback = {}) {
    return {
      ...fallback,
      id: p.client_key,
      backendId: p.id,
      name: p.name,
      category: p.category || '',
      barcode: p.ean || '',
      volumeMl: p.volume_ml == null ? null : Number(p.volume_ml),
      abv: p.abv == null ? null : Number(p.abv),
      shotMl: p.shot_ml == null ? 40 : Number(p.shot_ml),
      salePrice: Number(p.sale_price || 0),
      purchasePrice: Number(p.current_purchase_price || 0),
      tareG: p.tare_g == null ? null : Number(p.tare_g),
      fullWeightG: p.full_weight_g == null ? null : Number(p.full_weight_g),
      coefMlPerG: p.ml_per_g == null ? null : Number(p.ml_per_g),
      refTempC: p.ref_temp_c == null ? 20 : Number(p.ref_temp_c),
      tempCoeffPctPer10C: p.temp_coeff_pct_per_10c == null ? 1.25 : Number(p.temp_coeff_pct_per_10c),
      zoneId: p.storage_zone_key || fallback.zoneId || 'shelf',
      calibrationStatus: p.calibration_status || 'missing',
      unitMode: unitMode(p.unit_mode),
      itemKind: p.item_kind || 'product',
      itemSubtype: p.item_subtype || null,
      countUnit: p.count_unit || 'ks',
      aliases: Array.isArray(p.aliases) ? p.aliases : [],
      updatedAt: p.updated_at || fallback.updatedAt || new Date().toISOString(),
      createdAt: p.created_at || fallback.createdAt || new Date().toISOString()
    };
  }

  function fromDbMovement(m, productClientKey) {
    return {
      id: `db_${m.id}`,
      backendId: m.id,
      type: m.movement_type === 'manual_correction' ? 'adjustment' : m.movement_type,
      productId: productClientKey,
      quantityMl: Number(m.quantity_ml || 0),
      quantityUnits: m.quantity_units == null ? null : Number(m.quantity_units),
      requestedQuantityUnits: m.requested_quantity_units == null ? null : Number(m.requested_quantity_units),
      untrackedUnits: Number(m.untracked_units || 0),
      date: String(m.occurred_at || m.created_at).slice(0, 10),
      note: m.reason || '',
      sourceType: m.source_type || null,
      sourceId: m.source_id || null,
      createdAt: m.created_at || m.occurred_at
    };
  }

  async function syncMissingProducts(client, ctx, local) {
    const { data: existing, error } = await client.from('products').select('client_key').eq('organization_id', ctx.organization.id);
    if (error) throw error;
    if (!['owner','manager'].includes(ctx.role)) return false;
    const products = Array.isArray(local?.products) ? local.products : [];
    const existingKeys = new Set((existing || []).map(p => p.client_key).filter(Boolean));
    const missing = products.filter(p => p?.id && !existingKeys.has(p.id));
    if (!missing.length) return false;
    const insert = await client.from('products').insert(missing.map(p => toDbProduct(p, ctx.organization.id)));
    if (insert.error) throw insert.error;
    return true;
  }

  async function sync() {
    if (!window.PubGuruBackend) return;
    const ctx = await window.PubGuruBackend.loadContext();
    if (!ctx?.user || !ctx?.organization || !ctx?.venue) return;
    const client = window.PubGuruBackend.client;
    const local = readLocal();
    if (!local) {
      if (localStateRetries++ < 20) setTimeout(run, 100);
      return;
    }
    localStateRetries = 0;

    await syncMissingProducts(client, ctx, local);

    const snapshot = await client.rpc('pos_inventory_snapshot', {p_venue: ctx.venue.id});
    if (snapshot.error) throw snapshot.error;
    if (!snapshot.data) throw new Error('Provozovna není dostupná.');
    const productsResult = {data:snapshot.data.products};

    const byLocalId = new Map((local.products || []).map(p => [p.id, p]));
    const remoteProducts = (productsResult.data || []).filter(p => p.client_key).map(p => fromDbProduct(p, byLocalId.get(p.client_key) || {}));
    const uuidToClient = new Map((productsResult.data || []).map(p => [p.id, p.client_key]));

    const movementsResult = {data:snapshot.data.movements};
    const remoteMovements = (movementsResult.data || []).map(m => [m, uuidToClient.get(m.product_id)])
      .filter(([, key]) => key).map(([m, key]) => fromDbMovement(m, key));

    const latest = readLocal() || local;
    if (!latest.legacyMovements && Array.isArray(latest.movements) && latest.movements.some(m => !String(m.id || '').startsWith('db_'))) latest.legacyMovements = latest.movements;
    const update = {products:remoteProducts, movements:remoteMovements, backend:{organizationId:ctx.organization.id,venueId:ctx.venue.id,syncedAt:snapshot.data.asOf,pendingPosCount:snapshot.data.pendingPosCount}};
    if (window.PubGuruApplyStockSnapshot) window.PubGuruApplyStockSnapshot(update);
    else writeLocal({...latest,...update});
    const status = document.getElementById('stock-sync-status');
    if (status) status.textContent = `Společný sklad ověřen ${new Date(snapshot.data.asOf).toLocaleTimeString('cs-CZ')}${snapshot.data.pendingPosCount ? ` · ${snapshot.data.pendingPosCount} odpisů z pokladny čeká na recepturu` : ''}`;
  }

  function refresh() {
    if (!syncing) syncing=sync().finally(()=>{syncing=null;});
    return syncing;
  }
  window.PubGuruDataSync = {refresh};
  const run = () => refresh().catch(error => {
    console.error('PUB GURU data sync failed', error);
    const status = document.getElementById('stock-sync-status');
    if (status) status.textContent = 'Stav skladu není aktuálně ověřený. Zkontroluj připojení.';
  });
  setInterval(()=>{if(!document.hidden)run();},10000);
  window.addEventListener('focus',run);
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', run);
  else run();
})();

