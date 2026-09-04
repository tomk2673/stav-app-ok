'use strict';

(function () {
  async function initNavigation() {
    const hash = location.hash.replace('#','');
    if (hash) {
      const button = document.querySelector(`.nav-btn[data-view="${CSS.escape(hash)}"]`);
      if (button) setTimeout(() => button.click(), 0);
    }

    document.querySelectorAll('.nav-btn[data-view]').forEach(btn => btn.addEventListener('click', () => {
      history.replaceState(null, '', `#${btn.dataset.view}`);
    }));

    if (!window.PubGuruBackend) return;
    try {
      const ctx = await window.PubGuruBackend.loadContext();
      if (!['owner','manager'].includes(ctx?.role)) return;
      const nav = document.querySelector('.nav');
      if (!nav || nav.querySelector('a[href="invoice-review.html"]')) return;
      const link = document.createElement('a');
      link.className = 'pub-link';
      link.href = 'invoice-review.html';
      link.textContent = 'Faktury ke schválení';
      const invoiceButton = nav.querySelector('.nav-btn[data-view="invoices"]');
      invoiceButton?.insertAdjacentElement('afterend', link);
    } catch (error) { console.error('Navigation role load failed', error); }
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', initNavigation);
  else initNavigation();
})();
