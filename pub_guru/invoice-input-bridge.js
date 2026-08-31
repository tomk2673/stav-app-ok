'use strict';

document.addEventListener('DOMContentLoaded', () => {
  const camera = document.getElementById('cameraFile');
  const target = document.getElementById('invoiceFile');
  if (!camera || !target) return;

  camera.addEventListener('change', () => {
    const file = camera.files?.[0];
    if (!file) return;
    try {
      const transfer = new DataTransfer();
      transfer.items.add(file);
      target.files = transfer.files;
      target.dispatchEvent(new Event('change', { bubbles: true }));
    } catch (err) {
      console.error('Camera file bridge failed', err);
      const toast = document.getElementById('toast');
      if (toast) {
        toast.textContent = 'Fotku se nepodařilo předat do OCR. Zkus Vybrat z knihovny.';
        toast.classList.remove('hidden');
      }
    } finally {
      camera.value = '';
    }
  });
});
