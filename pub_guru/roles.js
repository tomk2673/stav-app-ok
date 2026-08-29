'use strict';

(function () {
  const ROLE_LABELS = { owner: 'Majitel', manager: 'Vedoucí', staff: 'Zaměstnanec', accountant: 'Účetní', service: 'Servis' };

  const PERMISSIONS = {
    owner: { dashboard: true, invoices: 'post', closings: 'correct', inventory: true, sales: true, products: 'edit', settings: true, finances: true, team: true },
    manager: { dashboard: true, invoices: 'post', closings: 'correct', inventory: true, sales: true, products: 'edit', settings: true, finances: true, team: false },
    staff: { dashboard: false, invoices: 'capture', closings: 'create', inventory: true, sales: false, products: 'read', settings: false, finances: false, team: false },
    accountant: { dashboard: true, invoices: 'read', closings: 'read', inventory: false, sales: false, products: 'read', settings: false, finances: true, team: false },
    service: { dashboard: false, invoices: false, closings: false, inventory: false, sales: false, products: 'read', settings: false, finances: false, team: false }
  };

  function hide(selector) { document.querySelectorAll(selector).forEach(el => el.classList.add('hidden')); }
  function show(selector) { document.querySelectorAll(selector).forEach(el => el.classList.remove('hidden')); }

  function switchTo(view) {
    const btn = document.querySelector(`.nav-btn[data-view="${view}"]`);
    if (btn) btn.click();
  }

  async function apply() {
    if (!window.PubGuruBackend) return;
    let ctx;
    try { ctx = await window.PubGuruBackend.loadContext(); }
    catch (error) { console.error('Role context failed', error); return; }
    if (!ctx?.role) return;

    const role = ctx.role;
    const p = PERMISSIONS[role] || PERMISSIONS.staff;
    document.documentElement.dataset.pubGuruRole = role;
    window.PubGuruPermissions = Object.freeze({ role, label: ROLE_LABELS[role] || role, ...p });

    const topbar = document.querySelector('.topbar');
    if (topbar && !document.getElementById('roleBadge')) {
      const badge = document.createElement('span');
      badge.id = 'roleBadge';
      badge.className = 'badge muted';
      badge.textContent = ROLE_LABELS[role] || role;
      topbar.appendChild(badge);
    }

    if (!p.dashboard) hide('.nav-btn[data-view="dashboard"]');
    if (!p.invoices) hide('.nav-btn[data-view="invoices"]');
    if (!p.closings) hide('a[href="closings.html"]');
    if (!p.inventory) hide('.nav-btn[data-view="inventory"]');
    if (!p.sales) hide('.nav-btn[data-view="sales"]');
    if (!p.products) hide('.nav-btn[data-view="products"]');
    if (!p.settings) hide('.nav-btn[data-view="settings"]');

    if (p.products !== 'edit') {
      hide('#newProductBtn');
      document.querySelectorAll('.edit-product').forEach(btn => btn.classList.add('hidden'));
    }

    if (p.invoices === 'capture') {
      const save = document.getElementById('saveReceiptBtn');
      if (save) save.textContent = 'Odeslat vedoucímu ke kontrole';
      const title = document.querySelector('#view-invoices .panel-head h2');
      if (title) title.textContent = 'Faktura ke kontrole';
    }

    if (!p.finances) {
      hide('#profitSummary');
      hide('#salesList');
      hide('#view-dashboard');
      hide('#productPurchasePrice');
    }

    if (role === 'staff') {
      const active = document.querySelector('.nav-btn.active');
      if (!active || active.dataset.view === 'dashboard' || active.dataset.view === 'sales' || active.dataset.view === 'products' || active.dataset.view === 'settings') {
        switchTo('inventory');
      }
    }
  }

  document.addEventListener('DOMContentLoaded', apply);
})();
