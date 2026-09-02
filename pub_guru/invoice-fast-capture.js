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
    if (!file.type.startsWith('image/')) return file;
    const image = new Image();
    const url = URL.createObjectURL(file);
    image.src = url;
    await image.decode();

    const maxSide = 2560;
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

    const blob = await new Promise(resolve => canvas.toBlob(resolve, 'image/jpeg', 0.82));
    if (!blob) throw new Error('Nepodařilo se připravit fotografii.');
    return blob;
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

  async function queueCapture(file) {
    if (busy) return;
    busy = true;
    const camera = $('cameraFile');

    try {
      setProgress('Ukládám doklad…', 8);
      const ctx = await window.PubGuruBackend.loadContext();
      if (!ctx?.user || !ctx?.organization || !ctx?.venue) throw new Error('Chybí přihlášená provozovna.');

      const fingerprint = await sha256(file);
      setProgress('Kontroluji duplicitu…', 18);
      const duplicate = await duplicateExists(ctx, fingerprint);
      if (duplicate) {
        $('duplicateBadge').textContent = 'duplicitní';
        $('duplicateBadge').className = 'badge danger';
        toast(duplicate.type === 'invoice' ? 'Tento doklad už je ve Fakturách.' : 'Tento doklad už čeká na zpracování.', 5500);
        return;
      }

      const optimized = await compressImage(file);
      setProgress('Odesílám malý snímek…', 48);

      const jobId = crypto.randomUUID();
      const path = `${ctx.organization.id}/${ctx.venue.id}/${ctx.user.id}/${jobId}.jpg`;
      const upload = await db().storage.from('invoice-sources').upload(path, optimized, {
        contentType: 'image/jpeg',
        cacheControl: '3600',
        upsert: false
      });
      if (upload.error) throw upload.error;

      setProgress('Řadím ke zpracování…', 78);
      const insert = await db().from('invoice_capture_jobs').insert({
        id: jobId,
        organization_id: ctx.organization.id,
        venue_id: ctx.venue.id,
        created_by: ctx.user.id,
        source_path: path,
        source_file_name: file.name || `doklad-${new Date().toISOString()}.jpg`,
        source_fingerprint: fingerprint,
        mime_type: 'image/jpeg',
        status: 'queued'
      });

      if (insert.error) {
        await db().storage.from('invoice-sources').remove([path]);
        throw insert.error;
      }

      setProgress('Uloženo. Můžeš pokračovat.', 100);
      $('duplicateBadge').textContent = 'čeká na zpracování';
      $('duplicateBadge').className = 'badge muted';
      toast('📷 Doklad uložen. Můžeš hned fotit další.', 5200);
      window.dispatchEvent(new CustomEvent('pubguru:invoice-queued', { detail: { jobId } }));
      setTimeout(() => $('ocrProgressWrap')?.classList.add('hidden'), 1600);
    } finally {
      busy = false;
      if (camera) camera.value = '';
    }
  }

  document.addEventListener('change', event => {
    const target = event.target;
    if (!(target instanceof HTMLInputElement) || target.id !== 'cameraFile') return;
    const file = target.files?.[0];
    if (!file) return;

    event.preventDefault();
    event.stopPropagation();
    event.stopImmediatePropagation();

    queueCapture(file).catch(error => {
      console.error(error);
      setProgress('Uložení selhalo.', 0);
      toast(`Uložení dokladu selhalo: ${error.message}`, 7000);
    });
  }, true);
})();
