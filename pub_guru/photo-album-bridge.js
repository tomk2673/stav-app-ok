'use strict';

(function () {
  const handler = () => window.webkit?.messageHandlers?.pubGuruPhotos;
  const pending = new Map();

  function call(action, extra = {}) {
    if (!handler()) return Promise.reject(new Error('Nativní přístup k Fotkám není dostupný.'));
    const requestId = crypto.randomUUID();
    return new Promise((resolve, reject) => {
      pending.set(requestId, { resolve, reject });
      handler().postMessage({ requestId, action, ...extra });
      setTimeout(() => {
        if (!pending.has(requestId)) return;
        pending.delete(requestId);
        reject(new Error('iPhone Fotky neodpověděly včas.'));
      }, 120000);
    });
  }

  window.PubGuruNativePhotos = {
    available: () => !!handler(),
    resolve(payload) {
      const item = pending.get(payload?.requestId);
      if (!item) return;
      pending.delete(payload.requestId);
      if (payload.error) item.reject(new Error(payload.error));
      else item.resolve(payload);
    }
  };

  async function initAlbumUI() {
    if (!handler()) return;
    const wrap = document.getElementById('nativeAlbumWrap');
    const select = document.getElementById('nativeAlbumSelect');
    const syncBtn = document.getElementById('nativeAlbumSync');
    if (!wrap || !select || !syncBtn) return;

    wrap.classList.remove('hidden');
    try {
      const response = await call('listAlbums');
      const albums = Array.isArray(response.albums) ? response.albums : [];
      if (!albums.length) {
        select.innerHTML = '<option value="">Žádné dostupné album</option>';
        syncBtn.disabled = true;
        return;
      }
      const saved = localStorage.getItem('pub_guru_invoice_album_id') || '';
      select.innerHTML = '<option value="">Vyber album faktur…</option>' + albums.map(a =>
        `<option value="${String(a.id).replace(/"/g,'&quot;')}" ${a.id === saved ? 'selected' : ''}>${String(a.title || 'Album').replace(/[&<>]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;'}[c]))}${a.shared ? ' · sdílené' : ''}</option>`
      ).join('');
      syncBtn.disabled = !select.value;
      select.addEventListener('change', () => {
        if (select.value) localStorage.setItem('pub_guru_invoice_album_id', select.value);
        syncBtn.disabled = !select.value;
      });
    } catch (error) {
      console.error(error);
      select.innerHTML = '<option value="">Povol přístup k Fotkám</option>';
    }

    syncBtn.addEventListener('click', async () => {
      if (!select.value || !window.PubGuruFastCapture?.queueNativeImages) return;
      const original = syncBtn.textContent;
      syncBtn.disabled = true;
      syncBtn.textContent = 'Načítám nové…';
      try {
        const response = await call('syncAlbum', { albumId: select.value, limit: 30 });
        const images = Array.isArray(response.images) ? response.images : [];
        if (!images.length) {
          syncBtn.textContent = 'Žádné nové faktury';
          setTimeout(() => { syncBtn.textContent = original; syncBtn.disabled = false; }, 1800);
          return;
        }
        const result = await window.PubGuruFastCapture.queueNativeImages(images);
        if (result?.completedAssetIds?.length) {
          await call('markImported', { assetIds: result.completedAssetIds });
        }
        syncBtn.textContent = `Načteno ${result?.queued || 0}`;
        setTimeout(() => { syncBtn.textContent = original; syncBtn.disabled = false; }, 1800);
      } catch (error) {
        console.error(error);
        syncBtn.textContent = 'Synchronizace selhala';
        setTimeout(() => { syncBtn.textContent = original; syncBtn.disabled = false; }, 2200);
      }
    });
  }

  document.addEventListener('DOMContentLoaded', initAlbumUI);
})();
