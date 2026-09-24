'use strict';

(function () {
  const LOCAL_STATE_KEY = 'stav_app_v1';
  const SYNC_MARKER_KEY = 'pub_guru_backend_sync_v1';
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

    const productsResult = await client.from('products')
      .select('id,client_key,name,category,ean,volume_ml,abv,shot_ml,sale_price,current_purchase_price,tare_g,full_weight_g,ml_per_g,ref_temp_c,temp_coeff_pct_per_10c,calibration_status,aliases,unit_mode,item_kind,item_subtype,count_unit,storage_zone_key,created_at,updated_at')
      .eq('organization_id', ctx.organization.id).is('archived_at', null).order('name');
    if (productsResult.error) throw productsResult.error;

    const byLocalId = new Map((local.products || []).map(p => [p.id, p]));
    const remoteProducts = (productsResult.data || []).filter(p => p.client_key).map(p => fromDbProduct(p, byLocalId.get(p.client_key) || {}));
    const uuidToClient = new Map((productsResult.data || []).map(p => [p.id, p.client_key]));

    const movementsResult = await client.from('stock_movements')
      .select('id,product_id,movement_type,quantity_ml,quantity_units,requested_quantity_units,untracked_units,source_type,source_id,reason,occurred_at,created_at')
      .eq('organization_id', ctx.organization.id).eq('venue_id', ctx.venue.id).order('occurred_at', { ascending: true });
    if (movementsResult.error) throw movementsResult.error;
    const remoteMovements = (movementsResult.data || []).map(m => [m, uuidToClient.get(m.product_id)])
      .filter(([, key]) => key).map(([m, key]) => fromDbMovement(m, key));

    if (!local.legacyMovements && Array.isArray(local.movements) && local.movements.some(m => !String(m.id || '').startsWith('db_'))) local.legacyMovements = local.movements;
    local.products = remoteProducts.length ? remoteProducts : local.products;
    local.movements = remoteMovements;
    local.backend = { organizationId: ctx.organization.id, venueId: ctx.venue.id, syncedAt: new Date().toISOString() };
    writeLocal(local);

    const marker = JSON.stringify({ org: ctx.organization.id, venue: ctx.venue.id, productCount: remoteProducts.length, movementCount: remoteMovements.length });
    const previous = sessionStorage.getItem(SYNC_MARKER_KEY);
    if (previous !== marker) {
      sessionStorage.setItem(SYNC_MARKER_KEY, marker);
      location.reload();
    }
  }

  const run = () => sync().catch(error => {
    console.error('PUB GURU data sync failed', error);
    window.toast?.(`Synchronizace skladu selhala: ${error.message}`, 6000);
  });
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', run);
  else run();
})();
