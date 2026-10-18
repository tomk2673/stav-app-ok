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

  function originalFormat(file) {
    const types={'image/jpeg':'jpg','image/png':'png','image/heic':'heic','image/heif':'heif','application/pdf':'pdf'};
    const mime=file.type||(/\.heic$/i.test(file.name)?'image/heic':/\.heif$/i.test(file.name)?'image/heif':'');
    if(!types[mime])throw new Error('Originál musí být JPEG, PNG, HEIC/HEIF nebo PDF.');
    if(!file.size||file.size>8*1024*1024)throw new Error('Originál dokladu musí mít nejvýše 8 MB.');
    return {mime,ext:types[mime]};
  }

  async function preserveOriginal(file,ctx,fingerprint) {
    const {mime,ext}=originalFormat(file);
    const path=`${ctx.organization.id}/${ctx.venue.id}/${ctx.user.id}/original-${fingerprint}.${ext}`;
    const bucket=db().storage.from('invoice-sources');
    const upload=await bucket.upload(path,file,{contentType:mime,cacheControl:'3600',upsert:false});
    if(upload.error) {
      if(!['409','Duplicate'].includes(String(upload.error.statusCode||upload.error.status||upload.error.error)))throw upload.error;
      const saved=await bucket.download(path);
      if(saved.error)throw saved.error;
      if(!saved.data||await sha256(saved.data)!==fingerprint)throw new Error('Uložený originál neodpovídá vybranému souboru.');
    }
    return {path,mime,ext};
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

    const jobId = crypto.randomUUID();
    if (progressLabel) setProgress(`${progressLabel} · odesílám`, 45);
    const prepared=await preserveOriginal(file,ctx,fingerprint);
    const path=prepared.path;

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
      // A lost response can mean the job WAS inserted. Keep immutable bytes
      // for reconciliation/retry rather than deleting a committed job's source.
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
      window.dispatchEvent(new Event('pubguru:invoice-queue-ready'));
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

  window.PubGuruFastCapture = { queueFiles, queueNativeImages, preserveOriginal, isBusy:()=>busy };

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
