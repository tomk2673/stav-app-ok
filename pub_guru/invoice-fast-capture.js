'use strict';

(function () {
  const $ = id => document.getElementById(id);
  const db = () => window.PubGuruBackend.client;
  let busy = false;

  function toast(message, ms = 4200) {
    const el = $('toast');
    if (!el) return;
    el.textContent = message;
    el.classList.remove('hidden');
    clearTimeout(toast.t);
    toast.t = setTimeout(() => el.classList.add('hidden'), ms);
  }

  async function sha256(file) {
    const hash = await crypto.subtle.digest('SHA-256', await file.arrayBuffer());
    return [...new Uint8Array(hash)].map(b => b.toString(16).padStart(2, '0')).join('');
  }

  async function compressImage(file) {
    if (!file.type.startsWith('image/')) return { blob: file, mime: file.type || 'application/octet-stream', ext: file.type === 'application/pdf' ? 'pdf' : 'bin' };
    const image = new Image();
    const url = URL.createObjectURL(file);
    image.src = url;
    await image.decode();

    const maxSide = 2200;
    const scale = Math.min(1, maxSide / Math.max(image.naturalWidth, image.naturalHeight));
    const width = Math.max(1, Math.round(image.naturalWidth * scale));
    const height = Math.max(1, Math.round(image.naturalHeight * scale));
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext('2d', { alpha: false });
    ctx.fillStyle = '#fff';
    ctx.fillRect(0, 0, width, height);
    ctx.drawImage(image, 0, 0, width, height);
    URL.revokeObjectURL(url);

    const blob = await new Promise(resolve => canvas.toBlob(resolve, 'image/jpeg', 0.78));
    if (!blob) throw new Error('Nepodařilo se připravit fotografii.');
    return { blob, mime: 'image/jpeg', ext: 'jpg' };
  }

  function setProgress(text, pct) {
    const wrap = $('ocrProgressWrap');
    const status = $('ocrStatus');
    const bar = $('ocrProgress');
    wrap?.classList.remove('hidden');
    if (status) status.textContent = text;
    if (bar) bar.style.width = `${Math.max(0, Math.min(100, pct))}%`;
  }

  async function duplicateExists(ctx, fingerprint) {
    const invoice = await db().from('invoices').select('id,invoice_number')
      .eq('organization_id', ctx.organization.id)
      .eq('source_fingerprint', fingerprint)
      .maybeSingle();
    if (invoice.error) throw invoice.error;
    if (invoice.data) return { type: 'invoice', data: invoice.data };

    const queued = await db().from('invoice_capture_jobs').select('id,status')
      .eq('organization_id', ctx.organization.id)
      .eq('source_fingerprint', fingerprint)
      .maybeSingle();
    if (queued.error) throw queued.error;
    return queued.data ? { type: 'queue', data: queued.data } : null;
  }

  async function queueOne(file, ctx, progressLabel = '') {
    const fingerprint = await sha256(file);
    const duplicate = await duplicateExists(ctx, fingerprint);
    if (duplicate) return { status: 'duplicate' };

    const prepared = await compressImage(file);
    const jobId = crypto.randomUUID();
    const path = `${ctx.organization.id}/${ctx.venue.id}/${ctx.user.id}/${jobId}.${prepared.ext}`;

    if (progressLabel) setProgress(`${progressLabel} · odesílám`, 45);
    const upload = await db().storage.from('invoice-sources').upload(path, prepared.blob, {
      contentType: prepared.mime,
      cacheControl: '3600',
      upsert: false
    });
    if (upload.error) throw upload.error;

    const insert = await db().from('invoice_capture_jobs').insert({
      id: jobId,
      organization_id: ctx.organization.id,
      venue_id: ctx.venue.id,
      created_by: ctx.user.id,
      source_path: path,
      source_file_name: file.name || `doklad-${new Date().toISOString()}.${prepared.ext}`,
      source_fingerprint: fingerprint,
      mime_type: prepared.mime,
      status: 'queued'
    });

    if (insert.error) {
      await db().storage.from('invoice-sources').remove([path]);
      throw insert.error;
    }

    window.dispatchEvent(new CustomEvent('pubguru:invoice-queued', { detail: { jobId } }));
    return { status: 'queued', jobId };
  }

  async function queueFiles(files, source = 'batch') {
    if (busy || !files.length) return { queued: 0, duplicates: 0, failed: files.length };
    busy = true;
    const input = $(source === 'camera' ? 'cameraFile' : source === 'batch' ? 'batchFiles' : '');

    try {
      const ctx = await window.PubGuruBackend.loadContext();
      if (!ctx?.user || !ctx?.organization || !ctx?.venue) throw new Error('Chybí přihlášená provozovna.');

      let queued = 0, duplicates = 0, failed = 0;
      for (let i = 0; i < files.length; i++) {
        const file = files[i];
        const pct = Math.round((i / Math.max(1, files.length)) * 90) + 5;
        setProgress(files.length === 1 ? 'Ukládám doklad…' : `Ukládám ${i + 1}/${files.length}: ${file.name || 'doklad'}`, pct);
        try {
          const result = await queueOne(file, ctx, files.length > 1 ? `${i + 1}/${files.length}` : '');
          if (result.status === 'duplicate') duplicates++;
          else queued++;
        } catch (error) {
          failed++;
          console.error('Invoice queue failed', file?.name, error);
        }
      }

      setProgress(`Hotovo · uloženo ${queued}${duplicates ? ` · duplicitní ${duplicates}` : ''}${failed ? ` · chyba ${failed}` : ''}`, 100);
      if ($('duplicateBadge')) {
        $('duplicateBadge').textContent = queued ? `${queued} ve frontě` : (duplicates ? 'duplicitní' : 'chyba');
        $('duplicateBadge').className = failed ? 'badge danger' : 'badge muted';
      }

      if (source === 'camera' && queued) toast('📷 Doklad uložen. Můžeš hned fotit další.', 4300);
      else if (queued) toast(`✅ ${queued} faktur přidáno do fronty. Můžeš pokračovat.`, 5200);
      else if (duplicates) toast('Vybrané doklady už ve frontě nebo ve Fakturách jsou.', 5200);
      else toast('Nepodařilo se uložit žádný doklad.', 6000);

      setTimeout(() => $('ocrProgressWrap')?.classList.add('hidden'), 1800);
      return { queued, duplicates, failed };
    } finally {
      busy = false;
      if (input) input.value = '';
    }
  }

  async function dataUrlToFile(item, index) {
    const response = await fetch(item.dataUrl);
    const blob = await response.blob();
    const name = item.name || `icloud-faktura-${Date.now()}-${index + 1}.jpg`;
    return new File([blob], name, { type: blob.type || 'image/jpeg', lastModified: Date.now() });
  }

  async function queueNativeImages(items) {
    const completedAssetIds = [];
    let queued = 0, duplicates = 0, failed = 0;
    if (!Array.isArray(items) || !items.length) return { queued, duplicates, failed, completedAssetIds };
    const ctx = await window.PubGuruBackend.loadContext();
    if (!ctx?.user || !ctx?.organization || !ctx?.venue) throw new Error('Chybí přihlášená provozovna.');

    for (let i = 0; i < items.length; i++) {
      const item = items[i];
      setProgress(`iCloud album ${i + 1}/${items.length}`, Math.round((i / items.length) * 90) + 5);
      try {
        const file = await dataUrlToFile(item, i);
        const result = await queueOne(file, ctx, `${i + 1}/${items.length}`);
        if (result.status === 'duplicate') duplicates++;
        else queued++;
        if (item.assetId) completedAssetIds.push(item.assetId);
      } catch (error) {
        failed++;
        console.error('Native album invoice failed', item?.assetId, error);
      }
    }

    setProgress(`Album hotovo · nové ${queued}${duplicates ? ` · už uložené ${duplicates}` : ''}${failed ? ` · chyba ${failed}` : ''}`, 100);
    if (queued) toast(`☁️ ${queued} nových faktur z alba je ve frontě.`, 5200);
    setTimeout(() => $('ocrProgressWrap')?.classList.add('hidden'), 1800);
    return { queued, duplicates, failed, completedAssetIds };
  }

  window.PubGuruFastCapture = { queueFiles, queueNativeImages };

  document.addEventListener('change', event => {
    const target = event.target;
    if (!(target instanceof HTMLInputElement) || !['cameraFile', 'batchFiles'].includes(target.id)) return;
    const files = [...(target.files || [])];
    if (!files.length) return;

    event.preventDefault();
    event.stopPropagation();
    event.stopImmediatePropagation();

    queueFiles(files, target.id === 'cameraFile' ? 'camera' : 'batch').catch(error => {
      console.error(error);
      setProgress('Uložení selhalo.', 0);
      toast(`Uložení dokladu selhalo: ${error.message}`, 7000);
    });
  }, true);
})();
