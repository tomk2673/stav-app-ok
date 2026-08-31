'use strict';

(function () {
  function onReady() {
    const button = document.getElementById('saveReceiptBtn');
    if (button) {
      button.addEventListener('click', event => {
        const role = window.PubGuruPermissions?.role || window.PubGuruBackend?.context()?.role;
        if (role === 'owner' || role === 'manager') {
          // invoice-backend.js has already captured the click and started the server workflow.
          // Stop the legacy STAV localStorage receipt handler from also creating a second local receipt.
          event.preventDefault();
          event.stopImmediatePropagation();
        }
      }, true);
    }

    const toast = document.getElementById('toast');
    if (toast) {
      const observer = new MutationObserver(() => {
        const text = toast.textContent || '';
        if (text.includes('Faktura uložena do PUB GURU') || text.includes('Faktura odeslána vedoucímu')) {
          sessionStorage.removeItem('pub_guru_backend_sync_v1');
          setTimeout(() => location.reload(), 800);
        }
      });
      observer.observe(toast, { childList: true, characterData: true, subtree: true });
    }
  }
  document.addEventListener('DOMContentLoaded', onReady);
})();
