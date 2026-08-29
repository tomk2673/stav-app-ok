'use strict';

(function () {
  const LOCAL_STATE_KEY = 'stav_app_v1';
  let ctx = null;

  const readLocal = () => {
    try { return JSON.parse(localStorage.getItem(LOCAL_STATE_KEY) || 'null'); }
    catch { return null; }
  };

  function payloadFromLocal(p) {
    return {
      organization_id: ctx.organization.id,
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
      unit_mode: p.unitMode === 'unit' ? 'unit' : 'liquid',
      storage_zone_key: p.zoneId || null,
      updated_at: new Date().toISOString()
    };
  }

  async function syncOneProduct(name, barcode) {
    if (!['owner','manager'].includes(ctx?.role)) return;
    const state = readLocal();
    const products = state?.products || [];
    const product = products.find(p => barcode && p.barcode === barcode) || products.find(p => p.name === name);
    if (!product) return;
    const payload = payloadFromLocal(product);
    const client = window.PubGuruBackend.client;
    const lookup = await client.from('products')
      .select('id').eq('organization_id', ctx.organization.id).eq('client_key', product.id).maybeSingle();
    if (lookup.error) throw lookup.error;

    if (lookup.data) {
      const update = await client.from('products').update(payload).eq('id', lookup.data.id);
      if (update.error) throw update.error;
    } else {
      const insert = await client.from('products').insert(payload);
      if (insert.error) throw insert.error;
    }

    const audit = await client.from('audit_events').insert({
      organization_id: ctx.organization.id,
      venue_id: ctx.venue?.id || null,
      actor_user_id: ctx.user.id,
      event_type: 'product.saved',
      entity_type: 'product',
      after_data: { client_key: product.id, name: product.name, ean: product.barcode || null, calibration_status: product.calibrationStatus }
    });
    if (audit.error) throw audit.error;
  }

  async function init() {
    if (!window.PubGuruBackend) return;
    ctx = await window.PubGuruBackend.loadContext();
    if (!ctx?.organization) return;

    const form = document.getElementById('productForm');
    form?.addEventListener('submit', () => {
      const name = document.getElementById('productName')?.value?.trim() || '';
      const barcode = document.getElementById('productBarcode')?.value?.trim() || '';
      setTimeout(() => {
        syncOneProduct(name, barcode).catch(error => {
          console.error('Product backend sync failed', error);
          window.toast?.(`Uložení produktu do databáze selhalo: ${error.message}`, 6000);
        });
      }, 0);
    }, true);
  }

  document.addEventListener('DOMContentLoaded', () => {
    init().catch(error => console.error('Operations backend init failed', error));
  });
})();
