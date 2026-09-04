'use strict';

(function () {
  function onReady() {
    const button = document.getElementById('saveReceiptBtn');
    if (button && !button.dataset.pubGuruGuarded) {
      button.dataset.pubGuruGuarded = '1';
      button.addEventListener('click', event => {
        const role = window.PubGuruPermissions?.role || window.PubGuruBackend?.context()?.role;
        if (role === 'owner' || role === 'manager') {
          event.preventDefault();
          event.stopImmediatePropagation();
        }
      }, true);
    }

    const toast = document.getElementById('toast');
    if (toast && !toast.dataset.pubGuruObserved) {
      toast.dataset.pubGuruObserved = '1';
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
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', onReady);
  else onReady();
})();
