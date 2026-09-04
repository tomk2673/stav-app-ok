'use strict';

const STORAGE_KEY = 'stav_app_v1';
const today = () => new Date().toISOString().slice(0, 10);
const monthStart = () => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-01`;
};
const uid = (prefix = 'id') => `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
const slugId = value => `p_${value.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '')}`;
const num = value => {
  if (typeof value === 'number') return Number.isFinite(value) ? value : 0;
  const parsed = Number(String(value ?? '').replace(/\s/g, '').replace(',', '.'));
  return Number.isFinite(parsed) ? parsed : 0;
};
const money = value => new Intl.NumberFormat('cs-CZ', { style: 'currency', currency: 'CZK', maximumFractionDigits: 0 }).format(num(value));
const decimal = (value, digits = 1) => new Intl.NumberFormat('cs-CZ', { maximumFractionDigits: digits, minimumFractionDigits: 0 }).format(num(value));
const mlText = value => `${decimal(value, 0)} ml`;
const esc = value => String(value ?? '').replace(/[&<>'"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' }[c]));

const COUNTED_ITEM_DEFINITIONS = {
  packaging_crate: {
    kind: 'packaging', subtype: 'crate', name: 'Přepravka – vratný obal', category: 'Vratné obaly', countUnit: 'ks',
    aliases: ['přepravka', 'přepravky', 'vratná přepravka', 'obal přepravka', 'pivní bedna', 'bedna vratná']
  },
  packaging_bottle: {
    kind: 'packaging', subtype: 'bottle', name: 'Sklo / vratná láhev', category: 'Vratné obaly', countUnit: 'ks',
    aliases: ['sklo', 'vratné sklo', 'vratná láhev', 'vratné lahve', 'obal láhev', 'záloha láhev']
  },
  packaging_keg: {
    kind: 'packaging', subtype: 'keg', name: 'Sud / KEG – vratný obal', category: 'Vratné obaly', countUnit: 'ks',
    aliases: ['sud', 'sudy', 'keg', 'vratný sud', 'vratný keg', 'obal sud', 'záloha keg']
  },
  consumable_waste_bags: {
    kind: 'consumable', subtype: 'waste_bags', name: 'Pytle na odpad', category: 'Spotřební materiál', countUnit: 'bal.',
    aliases: ['pytle na odpadky', 'odpadkové pytle', 'sáčky do koše', 'pytle do koše', 'pytle 120 l', 'pytle 60 l']
  },
  consumable_cleaning: {
    kind: 'consumable', subtype: 'cleaning', name: 'Úklidová chemie', category: 'Spotřební materiál', countUnit: 'bal.',
    aliases: ['chemie na úklid', 'čisticí prostředek', 'čistič', 'odmašťovač', 'prostředek na podlahy', 'wc čistič']
  },
  consumable_sanitation: {
    kind: 'consumable', subtype: 'sanitation', name: 'Sanitační chemie', category: 'Spotřební materiál', countUnit: 'bal.',
    aliases: ['chemie na sanitaci', 'sanitační prostředek', 'sanitace', 'dezinfekce', 'dezinfekční prostředek', 'čištění pivního vedení']
  }
};

function normalizedText(value) {
  return String(value || '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[^a-z0-9]+/g, ' ').trim();
}

function detectCountedItemKey(text) {
  const value = normalizedText(text);
  if (!value) return null;
  const hasPackagingContext = /\b(vratn\w*|obal\w*|zaloha|depozit\w*|prazdn\w*|return\w*)\b/.test(value);
  const hasCleaningContext = /\b(uklid\w*|cistic\w*|cistid\w*|odmast\w*|detergent\w*|saponat\w*|jar|savo|wc gel)\b/.test(value);
  if (/\b(preprav\w*|bedn\w*|crate\w*)\b/.test(value)) return 'packaging_crate';
  if (/\b(sklo|skla|sklem)\b/.test(value) && hasCleaningContext && !hasPackagingContext) return 'consumable_cleaning';
  if (/\b(sklo|skla|sklem)\b/.test(value)) return 'packaging_bottle';
  if (hasPackagingContext && /\b(lahv\w*|bottle\w*)\b/.test(value)) return 'packaging_bottle';
  const wordCount = value.split(/\s+/).length;
  if (/\b(keg\w*|sud\w*)\b/.test(value) && (hasPackagingContext || wordCount <= 3)) return 'packaging_keg';
  if (/\b(pytl\w*|sack\w*)\b/.test(value) && (/\b(odpad\w*|kos\w*|igelit\w*|ldpe|hdpe)\b/.test(value) || /\b\d{2,3}\s*l\b/.test(value))) return 'consumable_waste_bags';
  if (/\b(sanit\w*|dezinf\w*|desinf\w*|pivn\w* vedeni|star san|chemipro|chlor\w*)\b/.test(value)) return 'consumable_sanitation';
  if (hasCleaningContext) return 'consumable_cleaning';
  return null;
}

function seedProduct(name, category, salePrice, abv = null, zoneId = 'shelf', extras = {}) {
  return {
    id: slugId(name),
    name,
    category,
    barcode: '',
    volumeMl: extras.volumeMl ?? null,
    abv,
    shotMl: extras.shotMl ?? 40,
    salePrice: salePrice ?? 0,
    purchasePrice: extras.purchasePrice ?? 0,
    tareG: null,
    fullWeightG: null,
    coefMlPerG: null,
    refTempC: 20,
    tempCoeffPctPer10C: 1.25,
    zoneId,
    calibrationStatus: extras.calibrationStatus ?? 'missing',
    unitMode: extras.unitMode ?? 'liquid',
    itemKind: extras.itemKind ?? 'product',
    itemSubtype: extras.itemSubtype ?? null,
    countUnit: extras.countUnit ?? 'ks',
    aliases: Array.isArray(extras.aliases) ? [...extras.aliases] : [],
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString()
  };
}

function seedProducts() {
  const p = [];
  const add = (...args) => p.push(seedProduct(...args));
  add('Becherovka 38%', 'Likéry', 70, 38);
  add('Becherovka Lemond', 'Likéry', 70, 20);
  add('Fernet Stock', 'Likéry', 60, 38);
  add('Fernet Stock Citrus', 'Likéry', 60, 27);
  add('Jägermeister', 'Likéry', 65, 35, 'fridge');
  add('Jägermeister Scharf', 'Likéry', 65, 33, 'fridge');
  add('Zelená', 'Likéry', 50, null);
  add('Gruzignac 5*', 'Cognac / Brandy', 90, 40);
  add('Metaxa 5*', 'Cognac / Brandy', 70, 38);
  add('Tuzemský Božkov', 'Rumy', 55, 37.5);
  add('Malibu', 'Rumy', 70, 21);
  add('Captain Morgan Spiced', 'Rumy', 70, 35);
  add('Bacardi Spiced', 'Rumy', 70, 35);
  add('Bacardi Superior', 'Rumy', 70, 37.5);
  add('Havana Club 3y', 'Rumy', 70, 37.5);
  add('Legendario Elixir', 'Rumy', 90, 38);
  add('Heffron 5y', 'Rumy', 65, 38);
  add('Republica Božkov 8y', 'Rumy', 65, 38);
  add('Brugal 5y', 'Rumy', 90, 38);
  add('Kraken Black Spiced', 'Rumy', 95, 40);
  add('Bumbu Original 15y', 'Rumy', 130, 40);
  add('Dictador 12y', 'Rumy', 130, 40);
  add('El Dorado 12y', 'Rumy', 130, 40);
  add('El Dorado 15y', 'Rumy', 155, 43);
  add('Diplomatico Reserva 15y', 'Rumy', 160, 40);
  add('Pyrat XO', 'Rumy', 140, 40);
  add('Zacapa 23y', 'Rumy', 185, 40);
  add('Plantation XO', 'Rumy', 185, 40);
  add('Blue Mauritius', 'Rumy', 165, 40);
  add('Don Papa Baroko', 'Rumy', 150, 40);
  add('Don Papa', 'Rumy', 140, 40);
  add('Stará myslivecká Reserve', 'Whisky', 70, 40);
  add("Jack Daniel's", 'Whisky', 90, 40);
  add("Jack Daniel's Honey", 'Whisky', 95, 35);
  add("Jack Daniel's Apple", 'Whisky', 95, 35);
  add("Jack Daniel's Fire", 'Whisky', 95, 35);
  add('Jameson', 'Whisky', 70, 40);
  add('Tullamore Dew', 'Whisky', 70, 40);
  add('Jim Beam', 'Whisky', 90, 40);
  add('Famous Grouse', 'Whisky', 80, 40);
  add('Talisker 10y', 'Whisky', 145, 45.8);
  add('Highland Park 12y', 'Whisky', 160, 40);
  add('Vodka Finlandia', 'Destiláty', 70, 40, 'fridge');
  add('Vodka Nemiroff', 'Destiláty', 70, 40, 'fridge');
  add('Gin Beefeater', 'Destiláty', 70, 40);
  add('Gin Beefeater Pink', 'Destiláty', 85, 37.5);
  add('Gin Bombay', 'Destiláty', 95, 40);
  add('Gin Malfy Original', 'Destiláty', 110, 41);
  add('Gin Malfy Limone', 'Destiláty', 120, 41);
  add('Gin Malfy Arancia', 'Destiláty', 120, 41);
  add("Gin Hendrick's", 'Destiláty', 130, 41.4);
  add('Tequila El Jimador Gold', 'Destiláty', 90, 38);
  add('Tequila El Jimador Silver', 'Destiláty', 90, 38);
  add('RJ Hruškovice', 'Destiláty', 90, 42);
  add('RJ Slivovice', 'Destiláty', 90, 45);
  add('RJ Hruška zlatá', 'Destiláty', 95, 40);
  add('Fleret Slivovice', 'Destiláty', 90, null);
  add('RJ Absinth', 'Destiláty', 90, 70);
  add('Bohemia sekt 0,75 l', 'Víno a sekt', 350, null, 'shelf', { volumeMl: 750, shotMl: 750 });
  add('Corona Mexico 0,33 l', 'Pivo balené', 69, null, 'fridge', { volumeMl: 330, shotMl: 330, unitMode: 'unit' });
  add('Heineken 0,33 l', 'Pivo balené', 59, null, 'fridge', { volumeMl: 330, shotMl: 330, unitMode: 'unit' });
  add('Birell světlé 0,33 l', 'Pivo balené', 45, 0.5, 'fridge', { volumeMl: 330, shotMl: 330, unitMode: 'unit' });
  add('Red Bull 0,25 l', 'Nealko', 80, 0, 'fridge', { volumeMl: 250, shotMl: 250, unitMode: 'unit' });
  Object.values(COUNTED_ITEM_DEFINITIONS).forEach(def => add(def.name, def.category, 0, null, 'shelf', {
    unitMode: 'counted', itemKind: def.kind, itemSubtype: def.subtype, countUnit: def.countUnit,
    aliases: def.aliases, calibrationStatus: 'verified', shotMl: 1
  }));
  return p;
}

function ensureCountedCatalog(products) {
  const result = Array.isArray(products) ? products.map(p => ({
    ...p,
    aliases: Array.isArray(p.aliases) ? p.aliases : [],
    itemKind: p.itemKind || 'product',
    countUnit: p.countUnit || 'ks'
  })) : [];
  const seeds = seedProducts().filter(p => p.unitMode === 'counted');
  seeds.forEach(seed => {
    const exists = result.some(p => p.unitMode === 'counted' && p.itemKind === seed.itemKind && p.itemSubtype === seed.itemSubtype);
    if (!exists) result.push(seed);
  });
  return result;
}

function defaultState() {
  return {
    version: 2,
    products: seedProducts(),
    zones: [
      { id: 'fridge', name: 'Lednice', tempC: 4 },
      { id: 'shelf', name: 'Barová police', tempC: 20 }
    ],
    settings: { toleranceMl: 10, defaultTempCoeffPctPer10C: 1.25 },
    movements: [],
    invoices: [],
    inventorySessions: [],
    currentInventory: { id: uid('inv'), date: today(), zoneId: 'shelf', tempC: 20, lines: [] }
  };
}

function loadState() {
  try {
    if (typeof localStorage === 'undefined') return defaultState();
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return defaultState();
    const parsed = JSON.parse(raw);
    const fallback = defaultState();
    return {
      ...fallback,
      ...parsed,
      settings: { ...fallback.settings, ...(parsed.settings || {}) },
      zones: Array.isArray(parsed.zones) && parsed.zones.length ? parsed.zones : fallback.zones,
      version: 2,
      products: ensureCountedCatalog(Array.isArray(parsed.products) && parsed.products.length ? parsed.products : fallback.products),
      movements: parsed.movements || [],
      invoices: parsed.invoices || [],
      inventorySessions: parsed.inventorySessions || [],
      currentInventory: parsed.currentInventory || fallback.currentInventory
    };
  } catch (error) {
    console.error(error);
    return defaultState();
  }
}

let state = loadState();
let currentInventoryProductId = null;
let invoiceDraftLines = [];
let scanner = null;
let scannerCallback = null;
let selectProductCallback = null;

function saveState(render = true) {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  if (render) renderAll();
}

function productById(id) { return state.products.find(p => p.id === id); }
function zoneById(id) { return state.zones.find(z => z.id === id) || state.zones[0]; }
function isCountedItem(p) { return p?.unitMode === 'counted'; }
function isPackaging(p) { return isCountedItem(p) && p.itemKind === 'packaging'; }
function isConsumable(p) { return isCountedItem(p) && p.itemKind === 'consumable'; }
function countedItemLabel(p) {
  if (isPackaging(p)) return `Vratný obal · ${p.itemSubtype === 'crate' ? 'přepravka' : p.itemSubtype === 'bottle' ? 'sklo' : 'sud / KEG'}`;
  if (isConsumable(p)) return 'Spotřební materiál';
  return 'Kusová položka';
}
function productComplete(p) { return isCountedItem(p) || !!(p.volumeMl && p.tareG !== null && p.coefMlPerG); }
function stockMl(productId) { return state.movements.filter(m => m.productId === productId).reduce((sum, m) => sum + num(m.quantityMl), 0); }
function stockUnits(productId) { return Math.max(0, state.movements.filter(m => m.productId === productId).reduce((sum, m) => sum + num(m.quantityUnits), 0)); }
function movementCount(productId) { return state.movements.filter(m => m.productId === productId).length; }
function unitCostPerMl(p) { return p?.volumeMl ? num(p.purchasePrice) / num(p.volumeMl) : 0; }
function saleValuePerMl(p) { return p?.shotMl ? num(p.salePrice) / num(p.shotMl) : 0; }
function productStockText(p) { return isCountedItem(p) ? `${decimal(stockUnits(p.id), 2)} ${esc(p.countUnit || 'ks')}` : mlText(stockMl(p.id)); }
function movementQuantity(m, p) { return isCountedItem(p) ? num(m.quantityUnits) : num(m.quantityMl); }
function movementQuantityText(m, p) { return isCountedItem(p) ? `${decimal(Math.abs(num(m.quantityUnits)), 2)} ${esc(p.countUnit || 'ks')}` : mlText(Math.abs(num(m.quantityMl))); }
function statusBadge(status) {
  const map = {
    approved: ['ok', 'schváleno'], ok: ['ok', 'souhlasí'], resolved: ['ok', 'vyřešeno'],
    provisional: ['warn', 'provizorní'], review: ['warn', 'zkontrolovat'], warning: ['warn', 'zkontrolovat'], baseline: ['muted', 'počáteční stav'],
    issue: ['danger', 'problém'], missing: ['danger', 'chybí'], new: ['muted', 'nová'], skipped: ['muted', 'přeskočeno'],
    packaging: ['ok', 'vratný obal'], consumable: ['warn', 'spotřební']
  };
  const [cls, label] = map[status] || ['muted', status || '—'];
  return `<span class="badge ${cls}">${label}</span>`;
}

function toast(message, ms = 3000) {
  const el = document.getElementById('toast');
  el.textContent = message;
  el.classList.remove('hidden');
  clearTimeout(toast._timer);
  toast._timer = setTimeout(() => el.classList.add('hidden'), ms);
}

function switchView(view) {
  const titles = {
    dashboard: ['Přehled', 'Co dnes potřebuje zásah.'],
    invoices: ['Faktury', 'OCR, párování příjmů, vratných obalů a spotřeby.'],
    inventory: ['Inventura', 'EAN → váha → skutečný stav.'],
    sales: ['Prodej a zisk', 'Náklady, tržby a marže za období.'],
    products: ['Produkty', 'EAN, tára, hustotní koeficient a teplota.'],
    settings: ['Nastavení', 'Zóny, tolerance a záloha dat.']
  };
  document.querySelectorAll('.view').forEach(el => el.classList.toggle('active', el.id === `view-${view}`));
  document.querySelectorAll('.nav-btn').forEach(el => el.classList.toggle('active', el.dataset.view === view));
  document.getElementById('pageTitle').textContent = titles[view][0];
  document.getElementById('pageSubtitle').textContent = titles[view][1];
  window.scrollTo({ top: 0, behavior: 'smooth' });
}

function renderDashboard() {
  const currentMonthSales = state.movements.filter(m => m.type === 'sale' && m.date >= monthStart() && m.date <= today());
  const revenue = currentMonthSales.reduce((s, m) => s + num(m.revenue), 0);
  const cost = currentMonthSales.reduce((s, m) => s + num(m.cost), 0);
  const grossProfit = revenue - cost;
  const stockValue = state.products.reduce((sum, p) => sum + (isCountedItem(p)
    ? (isConsumable(p) ? stockUnits(p.id) * num(p.purchasePrice) : 0)
    : Math.max(0, stockMl(p.id)) * unitCostPerMl(p)), 0);
  const packagingProducts = state.products.filter(isPackaging);
  const packagingUnits = packagingProducts.reduce((sum, p) => sum + stockUnits(p.id), 0);
  const packagingValue = packagingProducts.reduce((sum, p) => sum + stockUnits(p.id) * num(p.purchasePrice), 0);
  const incomplete = state.products.filter(p => !isCountedItem(p) && (!productComplete(p) || p.calibrationStatus !== 'verified')).length;
  const issues = [
    ...state.currentInventory.lines.filter(l => l.status === 'issue'),
    ...state.inventorySessions.flatMap(s => s.lines || []).filter(l => l.status === 'issue'),
    ...state.invoices.flatMap(i => i.lines || []).filter(l => l.state === 'review'),
    ...state.movements.filter(m => num(m.untrackedUnits) > 0 && !m.resolvedAt)
  ];
  const cards = [
    ['Hodnota zásob', money(stockValue), 'podle posledních nákupních cen'],
    ['Vratné obaly', money(packagingValue), `${decimal(packagingUnits, 0)} ks v evidenci`],
    ['Hrubý zisk měsíc', money(grossProfit), revenue ? `marže ${decimal((grossProfit / revenue) * 100, 1)} %` : 'zatím bez prodejů'],
    ['Nevyřešené položky', decimal(issues.length, 0), 'kontrola před finančním závěrem'],
    ['Kalibrace k doplnění', decimal(incomplete, 0), `${state.products.length} produktů v katalogu`]
  ];
  document.getElementById('dashboardCards').innerHTML = cards.map(([label, value, trend]) => `
    <div class="metric"><span class="label">${label}</span><strong>${value}</strong><span class="trend">${trend}</span></div>
  `).join('');

  const attention = [];
  state.currentInventory.lines.filter(l => l.status === 'issue').slice(0, 4).forEach(l => {
    const p = productById(l.productId);
    const difference = isCountedItem(p) ? num(l.diffUnits) : num(l.diffMl);
    const differenceText = isCountedItem(p) ? `${decimal(Math.abs(difference), 2)} ${esc(p.countUnit || 'ks')}` : mlText(Math.abs(difference));
    const financialImpact = isCountedItem(p) ? num(l.costDifference) : num(l.saleDifference);
    attention.push(`<div class="item-row"><div><strong>${esc(p?.name || 'Produkt')}</strong><div class="meta">Inventura ${difference < 0 ? 'manko' : 'přebytek'} ${differenceText}</div></div><span class="money ${difference < 0 ? 'negative' : 'positive'}">${difference < 0 ? '−' : '+'}${money(Math.abs(financialImpact || 0))}</span></div>`);
  });
  const remainingAttention = Math.max(0, 5 - attention.length);
  if (remainingAttention) {
    state.movements.filter(m => num(m.untrackedUnits) > 0 && !m.resolvedAt).slice(-remainingAttention).reverse().forEach(m => {
      const p = productById(m.productId);
      attention.push(`<div class="item-row"><div><strong>${esc(p?.name || 'Kusová položka')}</strong><div class="meta">Vráceno ${decimal(m.untrackedUnits, 2)} ${esc(p?.countUnit || 'jedn.')} mimo počáteční evidenci; sklad zůstal na 0</div></div>${statusBadge('warning')}</div>`);
    });
  }
  state.products.filter(p => !isCountedItem(p) && !productComplete(p)).slice(0, Math.max(0, 5 - attention.length)).forEach(p => {
    attention.push(`<div class="item-row"><div><strong>${esc(p.name)}</strong><div class="meta">Chybí objem, tára nebo koeficient ml/g</div></div>${statusBadge('missing')}</div>`);
  });
  document.getElementById('attentionList').innerHTML = attention.length ? attention.join('') : '<div class="empty-state">Žádné otevřené výjimky. Sklad dnes nevrčí.</div>';

  const movementLabels = { receipt: 'Naskladnění', return: 'Vrácení dodavateli', sale: 'Prodej', adjustment: 'Inventurní korekce' };
  const movements = [...state.movements].sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt))).slice(0, 7);
  document.getElementById('movementList').innerHTML = movements.length ? movements.map(m => {
    const p = productById(m.productId);
    const quantity = movementQuantity(m, p);
    const untracked = num(m.untrackedUnits);
    const sign = quantity < 0 ? '−' : quantity > 0 ? '+' : '';
    return `<div class="item-row"><div><strong>${esc(p?.name || 'Produkt')}</strong><div class="meta">${movementLabels[m.type] || m.type} · ${esc(m.date || '')}${untracked ? ` · ${decimal(untracked, 2)} ${esc(p?.countUnit || 'ks')} mimo počáteční evidenci` : ''}</div></div><span class="money ${quantity < 0 ? 'negative' : quantity > 0 ? 'positive' : ''}">${sign}${movementQuantityText(m, p)}</span></div>`;
  }).join('') : '<div class="empty-state">Zatím žádné skladové pohyby.</div>';
}

function productOptions(selected = '', includeBlank = true, filter = () => true) {
  const sorted = [...state.products].filter(filter).sort((a, b) => a.name.localeCompare(b.name, 'cs'));
  return `${includeBlank ? '<option value="">Vyber produkt</option>' : ''}${sorted.map(p => `<option value="${p.id}" ${p.id === selected ? 'selected' : ''}>${isCountedItem(p) ? `${isPackaging(p) ? 'OBAL' : 'SPOTŘEBA'} · ` : ''}${esc(p.name)}</option>`).join('')}`;
}
function zoneOptions(selected = '') {
  return state.zones.map(z => `<option value="${z.id}" ${z.id === selected ? 'selected' : ''}>${esc(z.name)} · ${decimal(z.tempC, 1)} °C</option>`).join('');
}

function renderProducts() {
  const query = document.getElementById('productSearch')?.value?.trim().toLowerCase() || '';
  const onlyIncomplete = document.getElementById('onlyIncomplete')?.checked || false;
  const rows = [...state.products]
    .filter(p => !query || `${p.name} ${p.category} ${p.barcode} ${(p.aliases || []).join(' ')}`.toLowerCase().includes(query))
    .filter(p => !onlyIncomplete || (!isCountedItem(p) && (!productComplete(p) || p.calibrationStatus !== 'verified')))
    .sort((a, b) => a.category.localeCompare(b.category, 'cs') || a.name.localeCompare(b.name, 'cs'));
  document.getElementById('productTable').innerHTML = rows.length ? rows.map(p => {
    const status = isPackaging(p) ? 'packaging' : isConsumable(p) ? 'consumable' : p.calibrationStatus === 'verified' && productComplete(p) ? 'verified' : p.calibrationStatus === 'provisional' ? 'provisional' : 'missing';
    return `<div class="product-row" data-product-id="${p.id}">
      <div><strong>${esc(p.name)}</strong><div class="muted">${esc(p.barcode || 'EAN nedoplněn')} · ${isCountedItem(p) ? `${countedItemLabel(p)} · ${esc(p.countUnit || 'ks')}` : p.volumeMl ? `${decimal(p.volumeMl, 0)} ml` : 'objem nedoplněn'}</div></div>
      <div class="product-category-cell"><span class="muted">Kategorie</span><br>${esc(p.category || '—')}</div>
      <div><span class="muted">Zóna</span><br>${esc(zoneById(p.zoneId)?.name || '—')}</div>
      <div class="stock"><span class="muted">Evidenční stav</span><br>${productStockText(p)}</div>
      <div class="actions">${statusBadge(status)}<br><button class="btn btn-small edit-product" data-id="${p.id}">Upravit</button></div>
    </div>`;
  }).join('') : '<div class="empty-state">Žádný produkt neodpovídá filtru.</div>';
  document.querySelectorAll('.edit-product').forEach(btn => btn.addEventListener('click', () => openProductModal(btn.dataset.id)));
}

function openProductModal(productId = null, prefill = {}) {
  const p = productId ? productById(productId) : {
    id: '', name: '', category: '', barcode: prefill.barcode || '', volumeMl: null, abv: null, shotMl: 40, salePrice: 0,
    purchasePrice: 0, tareG: null, fullWeightG: null, coefMlPerG: null, refTempC: 20,
    tempCoeffPctPer10C: state.settings.defaultTempCoeffPctPer10C, zoneId: 'shelf', calibrationStatus: 'missing',
    unitMode: 'liquid', itemKind: 'product', itemSubtype: null, countUnit: 'ks'
  };
  document.getElementById('productModalTitle').textContent = productId ? 'Upravit produkt' : 'Nový produkt';
  document.getElementById('productId').value = p.id || '';
  document.getElementById('productName').value = p.name || '';
  document.getElementById('productCategory').value = p.category || '';
  document.getElementById('productBarcode').value = p.barcode || '';
  document.getElementById('productItemMode').value = productItemMode(p);
  document.getElementById('productCountUnit').value = p.countUnit || (isConsumable(p) ? 'bal.' : 'ks');
  document.getElementById('productVolume').value = p.volumeMl ?? '';
  document.getElementById('productAbv').value = p.abv ?? '';
  document.getElementById('productShot').value = p.shotMl ?? 40;
  document.getElementById('productSalePrice').value = p.salePrice ?? '';
  document.getElementById('productPurchasePrice').value = p.purchasePrice ?? '';
  document.getElementById('productTare').value = p.tareG ?? '';
  document.getElementById('productFullWeight').value = p.fullWeightG ?? '';
  document.getElementById('productCoef').value = p.coefMlPerG ?? '';
  document.getElementById('productRefTemp').value = p.refTempC ?? 20;
  document.getElementById('productTempCoeff').value = p.tempCoeffPctPer10C ?? state.settings.defaultTempCoeffPctPer10C;
  document.getElementById('productZone').innerHTML = zoneOptions(p.zoneId);
  document.getElementById('productCalibration').value = p.calibrationStatus || 'missing';
  updateProductModeUI();
  updateCoefHelper();
  document.getElementById('productModal').classList.remove('hidden');
}
function closeModal(id) { document.getElementById(id).classList.add('hidden'); }
function productItemMode(p) {
  if (isPackaging(p)) return `packaging_${p.itemSubtype || 'crate'}`;
  if (isConsumable(p)) return `consumable_${p.itemSubtype || 'cleaning'}`;
  return p?.unitMode === 'unit' ? 'unit' : 'liquid';
}
function updateProductModeUI() {
  const mode = document.getElementById('productItemMode').value;
  const definition = COUNTED_ITEM_DEFINITIONS[mode] || null;
  const counted = !!definition;
  document.querySelectorAll('#productForm .liquid-only-field').forEach(el => el.classList.toggle('hidden', counted));
  document.querySelectorAll('#productForm .counted-only-field').forEach(el => el.classList.toggle('hidden', !counted));
  document.getElementById('productPurchasePriceText').textContent = counted ? 'Poslední cena / záloha za jednotku' : 'Poslední nákupní cena balení';
  if (definition && !document.getElementById('productCategory').value.trim()) document.getElementById('productCategory').value = definition.category;
  if (definition && !document.getElementById('productCountUnit').value.trim()) document.getElementById('productCountUnit').value = definition.countUnit;
}
function updateCoefHelper() {
  const mode = document.getElementById('productItemMode').value;
  if (mode.startsWith('packaging_') || mode.startsWith('consumable_')) return 0;
  const volume = num(document.getElementById('productVolume').value);
  const tare = num(document.getElementById('productTare').value);
  const full = num(document.getElementById('productFullWeight').value);
  const liquidWeight = full - tare;
  const coef = volume && liquidWeight > 0 ? volume / liquidWeight : 0;
  document.getElementById('coefHelper').textContent = coef ? `${decimal(volume, 0)} ml ÷ ${decimal(liquidWeight, 1)} g = ${decimal(coef, 4)} ml/g` : 'Doplň objem, táru a plnou hmotnost.';
  return coef;
}

function renderInvoiceLines() {
  document.getElementById('invoiceLineCount').textContent = String(invoiceDraftLines.length);
  const wrap = document.getElementById('invoiceLines');
  wrap.innerHTML = invoiceDraftLines.length ? invoiceDraftLines.map((line, i) => {
    const matchedProduct = productById(line.productId);
    const countedHint = isCountedItem(matchedProduct)
      ? `<small class="line-kind">${esc(countedItemLabel(matchedProduct))} · stav nikdy neklesne pod 0</small>`
      : '';
    return `
    <div class="invoice-line" data-index="${i}">
      <label class="raw-field">Text z faktury<input class="line-raw" value="${esc(line.rawName)}" /></label>
      <label class="product-field">Produkt<select class="line-product">${productOptions(line.productId)}</select>${countedHint}</label>
      <label>Množství<input class="line-qty" type="number" step="0.01" value="${line.qty}" /></label>
      <label>Cena / jedn.<input class="line-price" type="number" step="0.01" value="${line.unitPrice || ''}" /></label>
      <label class="state-field">Stav<select class="line-state">
        <option value="new" ${line.state === 'new' ? 'selected' : ''}>Nová</option>
        <option value="review" ${line.state === 'review' ? 'selected' : ''}>Zkontrolovat</option>
        <option value="approved" ${line.state === 'approved' ? 'selected' : ''}>Schválená</option>
        <option value="skipped" ${line.state === 'skipped' ? 'selected' : ''}>Přeskočit</option>
      </select></label>
      <button class="icon-btn remove-line" title="Odstranit">×</button>
    </div>
  `;
  }).join('') : '<div class="empty-state">OCR text rozlož na položky nebo přidej řádek ručně.</div>';

  wrap.querySelectorAll('.invoice-line').forEach(row => {
    const i = Number(row.dataset.index);
    row.querySelector('.line-raw').addEventListener('input', e => invoiceDraftLines[i].rawName = e.target.value);
    row.querySelector('.line-product').addEventListener('change', e => { invoiceDraftLines[i].productId = e.target.value; if (e.target.value && invoiceDraftLines[i].state === 'new') invoiceDraftLines[i].state = 'review'; renderInvoiceLines(); });
    row.querySelector('.line-qty').addEventListener('input', e => invoiceDraftLines[i].qty = num(e.target.value));
    row.querySelector('.line-price').addEventListener('input', e => invoiceDraftLines[i].unitPrice = num(e.target.value));
    row.querySelector('.line-state').addEventListener('change', e => invoiceDraftLines[i].state = e.target.value);
    row.querySelector('.remove-line').addEventListener('click', () => { invoiceDraftLines.splice(i, 1); renderInvoiceLines(); });
  });
}

function normalizeWords(text) {
  return normalizedText(text).split(/\s+/).filter(w => w.length > 1);
}
function similarity(a, b) {
  const aw = new Set(normalizeWords(a));
  const bw = new Set(normalizeWords(b));
  if (!aw.size || !bw.size) return 0;
  const intersection = [...aw].filter(w => bw.has(w)).length;
  return intersection / Math.max(aw.size, bw.size);
}
function bestProductMatch(text) {
  const countedKey = detectCountedItemKey(text);
  if (countedKey) {
    const definition = COUNTED_ITEM_DEFINITIONS[countedKey];
    const candidates = state.products.filter(p => isCountedItem(p) && p.itemKind === definition.kind && p.itemSubtype === definition.subtype);
    let bestCounted = candidates[0] || null;
    let bestCountedScore = 0;
    candidates.forEach(p => {
      const s = Math.max(similarity(text, p.name), ...(p.aliases || []).map(a => similarity(text, a)));
      if (s > bestCountedScore) { bestCountedScore = s; bestCounted = p; }
    });
    if (bestCounted) return { product: bestCounted, score: Math.max(0.9, bestCountedScore), countedKey };
  }
  let best = null;
  let score = 0;
  state.products.forEach(p => {
    const s = Math.max(similarity(text, p.name), ...(p.aliases || []).map(a => similarity(text, a)));
    if (s > score) { score = s; best = p; }
  });
  return score >= 0.38 ? { product: best, score } : null;
}
function extractVolumeMl(text) {
  const ml = String(text).match(/(\d{2,4})\s*ml\b/i);
  if (ml) return num(ml[1]);
  const liters = String(text).match(/(\d+(?:[.,]\d+)?)\s*l\b/i);
  if (liters) return num(liters[1]) * 1000;
  return null;
}
function extractInvoiceQuantity(text, countedKey = null) {
  const plain = String(text || '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
  const explicit = plain.match(/(-?\s*\d+(?:[,.]\d+)?)\s*(ks|kus\w*|bal\w*|kart\w*|role|lahv\w*|btl)\b/i);
  if (explicit) return num(explicit[1]);
  const packagingPatterns = {
    packaging_crate: 'preprav\\w*|bedn\\w*|crate\\w*',
    packaging_bottle: 'sklo|lahv\\w*|bottle\\w*',
    packaging_keg: 'sud\\w*|keg\\w*'
  };
  if (packagingPatterns[countedKey]) {
    const afterPackaging = plain.match(new RegExp(`(?:${packagingPatterns[countedKey]})\\s*(?:[:x-]\\s*)?(-?\\s*\\d+(?:[,.]\\d+)?)\\b(?!\\s*(?:ml|l)\\b)`, 'i'));
    if (afterPackaging) return num(afterPackaging[1]);
  }
  return 1;
}
function signedInvoiceQuantity(qty, unitPrice) {
  const quantity = num(qty);
  if (quantity < 0) return quantity;
  return num(unitPrice) < 0 ? -quantity : quantity;
}
function boundCountedQuantity(availableQuantity, requestedQuantity) {
  const requested = num(requestedQuantity);
  if (requested >= 0) return { applied: requested, untracked: 0 };
  const available = Math.max(0, num(availableQuantity));
  const applied = -Math.min(available, Math.abs(requested));
  return { applied, untracked: Math.max(0, Math.abs(requested) - Math.abs(applied)) };
}
function capCountedMovement(productId, requestedQuantity) {
  return boundCountedQuantity(stockUnits(productId), requestedQuantity);
}
function parseInvoiceText() {
  const text = document.getElementById('ocrText').value;
  if (!text.trim()) return toast('Nejdřív nahraj fakturu nebo vlož OCR text.');
  const lines = text.split(/\r?\n/).map(l => l.replace(/\s+/g, ' ').trim()).filter(Boolean);
  const invoiceNo = text.match(/(?:faktura|daňový doklad|doklad)\s*(?:č\.?|číslo|no\.?|#)?\s*[:\-]?\s*([A-Z0-9\-/]{4,})/i);
  const dateMatch = text.match(/(?:datum vystavení|vystaveno|datum)\s*[:\-]?\s*(\d{1,2}[.\-/]\d{1,2}[.\-/]\d{2,4})/i);
  if (invoiceNo) document.getElementById('invoiceNumber').value = invoiceNo[1];
  if (dateMatch) {
    const parts = dateMatch[1].split(/[.\-/]/).map(Number);
    if (parts.length === 3) {
      const y = parts[2] < 100 ? 2000 + parts[2] : parts[2];
      document.getElementById('invoiceDate').value = `${y}-${String(parts[1]).padStart(2, '0')}-${String(parts[0]).padStart(2, '0')}`;
    }
  }
  const ignored = /(celkem|dph|základ|zaklad|splatnost|odběratel|dodavatel|ičo|dic|bankovní|variabilní|faktura)/i;
  const candidates = [];
  lines.forEach(line => {
    if (line.length < 5 || ignored.test(line) || !/[A-Za-zÁ-ž]/.test(line)) return;
    const numberMatches = [...line.matchAll(/-?\d+(?:[ .]\d{3})*(?:[,.]\d{1,2})?/g)];
    if (!numberMatches.length) return;
    const unitPrice = num(numberMatches[numberMatches.length - 1][0]);
    const firstNumberIndex = numberMatches[0].index ?? line.length;
    let rawName = line.slice(0, firstNumberIndex).replace(/[|;:]+$/g, '').trim();
    if (rawName.length < 3) rawName = line.replace(/\s+-?\d+(?:[,.]\d+)?\s*$/, '').trim();
    const match = bestProductMatch(rawName);
    const qty = extractInvoiceQuantity(line, match?.countedKey || detectCountedItemKey(rawName));
    const detectedVolumeMl = extractVolumeMl(line);
    if (rawName.length >= 3 && unitPrice >= 0) candidates.push({
      id: uid('line'), rawName, productId: match?.product?.id || '', qty, unitPrice,
      detectedVolumeMl, state: match ? 'review' : 'new'
    });
  });
  invoiceDraftLines = candidates.slice(0, 80);
  renderInvoiceLines();
  toast(invoiceDraftLines.length ? `Nalezeno ${invoiceDraftLines.length} kandidátních řádků. Zkontroluj je.` : 'Položky se nepodařilo bezpečně rozdělit. Přidej je ručně.');
}

async function recognizeCanvas(canvas, pageLabel = '') {
  if (!window.Tesseract) throw new Error('OCR knihovna se nenačetla. Zkontroluj internetové připojení.');
  const progress = document.getElementById('ocrProgress');
  const status = document.getElementById('ocrStatus');
  const result = await window.Tesseract.recognize(canvas, 'ces+eng', {
    logger: message => {
      if (message.status) status.textContent = `${pageLabel}${message.status}`;
      if (typeof message.progress === 'number') progress.style.width = `${Math.round(message.progress * 100)}%`;
    }
  });
  return result.data.text;
}

async function handleInvoiceFile(file) {
  if (!file) return;
  const progressWrap = document.getElementById('ocrProgressWrap');
  const progress = document.getElementById('ocrProgress');
  const status = document.getElementById('ocrStatus');
  const preview = document.getElementById('invoicePreview');
  progressWrap.classList.remove('hidden');
  progress.style.width = '0%';
  status.textContent = 'Načítám doklad…';
  let text = '';
  try {
    if (file.type === 'application/pdf') {
      if (!window.pdfjsLib) throw new Error('PDF knihovna se nenačetla.');
      window.pdfjsLib.GlobalWorkerOptions.workerSrc = 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js';
      const pdf = await window.pdfjsLib.getDocument({ data: await file.arrayBuffer() }).promise;
      const maxPages = Math.min(pdf.numPages, 4);
      for (let pageNumber = 1; pageNumber <= maxPages; pageNumber++) {
        status.textContent = `Připravuji stranu ${pageNumber}/${maxPages}…`;
        const page = await pdf.getPage(pageNumber);
        const viewport = page.getViewport({ scale: 2 });
        preview.width = viewport.width;
        preview.height = viewport.height;
        preview.classList.remove('hidden');
        await page.render({ canvasContext: preview.getContext('2d'), viewport }).promise;
        text += `\n--- STRANA ${pageNumber} ---\n${await recognizeCanvas(preview, `Strana ${pageNumber}: `)}`;
      }
    } else {
      const image = new Image();
      image.src = URL.createObjectURL(file);
      await image.decode();
      const maxWidth = 1800;
      const scale = Math.min(1, maxWidth / image.naturalWidth);
      preview.width = Math.round(image.naturalWidth * scale);
      preview.height = Math.round(image.naturalHeight * scale);
      const ctx = preview.getContext('2d');
      ctx.drawImage(image, 0, 0, preview.width, preview.height);
      preview.classList.remove('hidden');
      URL.revokeObjectURL(image.src);
      text = await recognizeCanvas(preview);
    }
    document.getElementById('ocrText').value = text.trim();
    status.textContent = 'OCR dokončeno. Teď zkontroluj text a najdi položky.';
    progress.style.width = '100%';
    toast('OCR dokončeno.');
  } catch (error) {
    console.error(error);
    status.textContent = error.message;
    toast(`OCR se nepodařilo: ${error.message}`, 5000);
  }
}

function saveReceipt() {
  syncInvoiceDraftFromDom();
  const approved = invoiceDraftLines.filter(l => l.state === 'approved' && l.productId && num(l.qty) !== 0);
  if (!approved.length) return toast('Nejdřív označ alespoň jednu položku jako schválenou.');
  const blockers = [];
  const orderedApproved = [...approved].sort((a, b) => Number(signedInvoiceQuantity(a.qty, a.unitPrice) < 0) - Number(signedInvoiceQuantity(b.qty, b.unitPrice) < 0));
  orderedApproved.forEach(line => {
    const p = productById(line.productId);
    if (!p) return blockers.push(line.rawName);
    if (isCountedItem(p)) return;
    if (!p.volumeMl && line.detectedVolumeMl) p.volumeMl = line.detectedVolumeMl;
    if (!p.volumeMl) blockers.push(p.name);
  });
  if (blockers.length) return toast(`Doplň objem balení: ${blockers.slice(0, 3).join(', ')}${blockers.length > 3 ? '…' : ''}`, 5000);
  const invoiceId = uid('invoice');
  const date = document.getElementById('invoiceDate').value || today();
  let untrackedTotal = 0;
  orderedApproved.forEach(line => {
    const p = productById(line.productId);
    const unitPrice = Math.abs(num(line.unitPrice));
    const requestedQuantity = signedInvoiceQuantity(line.qty, line.unitPrice);
    if (unitPrice > 0) p.purchasePrice = unitPrice;
    const alias = String(line.rawName || '').trim();
    const knownNames = [p.name, ...(p.aliases || [])].map(normalizedText);
    if (alias.length >= 3 && !knownNames.includes(normalizedText(alias))) p.aliases = [...(p.aliases || []), alias].slice(-30);
    p.updatedAt = new Date().toISOString();
    const movement = {
      id: uid('mov'), type: requestedQuantity < 0 ? 'return' : 'receipt', productId: p.id,
      date, unitPrice, invoiceId, note: line.rawName, createdAt: new Date().toISOString()
    };
    if (isCountedItem(p)) {
      const bounded = capCountedMovement(p.id, requestedQuantity);
      movement.quantityUnits = bounded.applied;
      movement.requestedQuantityUnits = requestedQuantity;
      movement.untrackedUnits = bounded.untracked;
      untrackedTotal += bounded.untracked;
    } else {
      movement.quantityMl = requestedQuantity * num(p.volumeMl);
    }
    state.movements.push(movement);
  });
  state.invoices.push({
    id: invoiceId,
    supplier: document.getElementById('supplierName').value.trim(),
    number: document.getElementById('invoiceNumber').value.trim(),
    date,
    rawText: document.getElementById('ocrText').value,
    lines: invoiceDraftLines.map(l => ({ ...l })),
    createdAt: new Date().toISOString()
  });
  invoiceDraftLines = [];
  document.getElementById('ocrText').value = '';
  document.getElementById('invoiceFile').value = '';
  renderInvoiceLines();
  saveState();
  toast(untrackedTotal
    ? `Zpracováno ${approved.length} položek. ${decimal(untrackedTotal, 2)} vrácených jednotek mimo evidenci bylo ponecháno na stavu 0.`
    : `Zpracováno ${approved.length} položek.` , 5000);
}
function syncInvoiceDraftFromDom() {
  document.querySelectorAll('#invoiceLines .invoice-line').forEach(row => {
    const i = Number(row.dataset.index);
    invoiceDraftLines[i].rawName = row.querySelector('.line-raw').value;
    invoiceDraftLines[i].productId = row.querySelector('.line-product').value;
    invoiceDraftLines[i].qty = num(row.querySelector('.line-qty').value);
    invoiceDraftLines[i].unitPrice = num(row.querySelector('.line-price').value);
    invoiceDraftLines[i].state = row.querySelector('.line-state').value;
  });
}

function ensureCurrentInventory() {
  if (!state.currentInventory) state.currentInventory = { id: uid('inv'), date: today(), zoneId: 'shelf', tempC: 20, lines: [] };
}
function renderInventorySetup() {
  ensureCurrentInventory();
  const zoneSelect = document.getElementById('inventoryZone');
  zoneSelect.innerHTML = zoneOptions(state.currentInventory.zoneId);
  document.getElementById('inventoryTemp').value = state.currentInventory.tempC;
  document.getElementById('inventoryDate').value = state.currentInventory.date || today();
}
function selectInventoryProduct(productId) {
  currentInventoryProductId = productId;
  const p = productById(productId);
  if (!p) return;
  const zone = zoneById(p.zoneId);
  document.getElementById('currentProductBadge').textContent = p.barcode || 'EAN nedoplněn';
  document.getElementById('inventoryMeasureEmpty').classList.add('hidden');
  document.getElementById('inventoryMeasureForm').classList.remove('hidden');
  document.getElementById('currentProductCard').innerHTML = `<div><div class="name">${esc(p.name)}</div><div class="sub">${esc(p.category)} · ${isCountedItem(p) ? `${countedItemLabel(p)} · ${esc(p.countUnit || 'ks')}` : p.volumeMl ? `${decimal(p.volumeMl, 0)} ml` : 'objem chybí'} · ${esc(zone?.name || '')}</div></div>${statusBadge(isPackaging(p) ? 'packaging' : isConsumable(p) ? 'consumable' : productComplete(p) ? p.calibrationStatus : 'missing')}`;
  document.getElementById('grossWeightText').textContent = isCountedItem(p) ? `Skutečný počet (${p.countUnit || 'ks'})` : 'Hmotnost otevřené lahve v g';
  document.getElementById('grossWeight').step = isCountedItem(p) ? '0.01' : '0.1';
  document.getElementById('sealedCountLabel').classList.toggle('hidden', isCountedItem(p));
  document.getElementById('itemTempLabel').classList.toggle('hidden', isCountedItem(p));
  document.getElementById('grossWeight').value = '';
  document.getElementById('sealedCount').value = '0';
  document.getElementById('itemTemp').value = zone?.tempC ?? state.currentInventory.tempC;
  document.getElementById('inventoryNote').value = '';
  updateMeasurementPreview();
  closeModal('selectProductModal');
  setTimeout(() => document.getElementById('grossWeight').focus(), 50);
}
function calculateMeasurement(p, grossWeight, sealedCount, itemTemp) {
  if (isCountedItem(p)) {
    const expectedUnits = stockUnits(p.id);
    const actualUnits = Math.max(0, num(grossWeight));
    const diffUnits = actualUnits - expectedUnits;
    const costDifference = diffUnits * num(p.purchasePrice);
    const hasBaseline = movementCount(p.id) > 0;
    const status = !hasBaseline ? 'baseline' : Math.abs(diffUnits) < 0.001 ? 'ok' : 'issue';
    return { valid: true, counted: true, actualUnits, expectedUnits, diffUnits, costDifference, status, hasBaseline };
  }
  const expectedMl = stockMl(p.id);
  const hasBaseline = movementCount(p.id) > 0;
  if (!p.volumeMl || p.tareG === null || !p.coefMlPerG) return { valid: false, expectedMl, hasBaseline, reason: 'Doplň objem balení, táru a koeficient ml/g.' };
  const netG = Math.max(0, num(grossWeight) - num(p.tareG));
  const refOpenMl = netG * num(p.coefMlPerG);
  const deltaT = num(itemTemp) - num(p.refTempC);
  const tempFactor = 1 + (num(p.tempCoeffPctPer10C) / 100) * (deltaT / 10);
  const openMlAtTemp = Math.max(0, Math.min(num(p.volumeMl), refOpenMl * tempFactor));
  const actualMl = num(sealedCount) * num(p.volumeMl) + openMlAtTemp;
  const diffMl = actualMl - expectedMl;
  const costDifference = diffMl * unitCostPerMl(p);
  const saleDifference = diffMl * saleValuePerMl(p);
  const tolerance = num(state.settings.toleranceMl);
  const status = !hasBaseline ? 'baseline' : Math.abs(diffMl) <= tolerance ? 'ok' : 'issue';
  return { valid: true, netG, refOpenMl, openMlAtTemp, actualMl, expectedMl, diffMl, costDifference, saleDifference, tempFactor, status, hasBaseline };
}
function updateMeasurementPreview() {
  const p = productById(currentInventoryProductId);
  const wrap = document.getElementById('measurementResult');
  if (!p) { wrap.innerHTML = ''; return; }
  const result = calculateMeasurement(p, document.getElementById('grossWeight').value, document.getElementById('sealedCount').value, document.getElementById('itemTemp').value);
  if (!result.valid) {
    wrap.innerHTML = `<div class="calc-block"><span>Nelze vypočítat</span><strong class="warning">Chybí kalibrace</strong></div><div class="calc-block"><span>Co doplnit</span><strong style="font-size:14px">${esc(result.reason)}</strong></div>`;
    return;
  }
  if (result.counted) {
    const unit = esc(p.countUnit || 'ks');
    wrap.innerHTML = `
      <div class="calc-block"><span>Skutečný stav</span><strong>${decimal(result.actualUnits, 2)} ${unit}</strong></div>
      <div class="calc-block"><span>Očekávaný stav</span><strong>${decimal(result.expectedUnits, 2)} ${unit}</strong></div>
      <div class="calc-block"><span>Rozdíl</span><strong class="${result.diffUnits < 0 ? 'negative' : result.diffUnits > 0 ? 'positive' : ''}">${result.diffUnits >= 0 ? '+' : ''}${decimal(result.diffUnits, 2)} ${unit}</strong></div>
      <div class="calc-block"><span>Finanční dopad</span><strong class="${result.costDifference < 0 ? 'negative' : 'positive'}">${result.costDifference >= 0 ? '+' : ''}${money(result.costDifference)}</strong></div>
      <div class="calc-block"><span>Stav měření</span><strong>${result.status === 'baseline' ? 'Počáteční stav' : result.status === 'ok' ? 'Souhlasí' : 'Prověřit'}</strong></div>`;
    return;
  }
  wrap.innerHTML = `
    <div class="calc-block"><span>Skutečný stav</span><strong>${mlText(result.actualMl)}</strong></div>
    <div class="calc-block"><span>Očekávaný stav</span><strong>${mlText(result.expectedMl)}</strong></div>
    <div class="calc-block"><span>Rozdíl</span><strong class="${result.diffMl < 0 ? 'negative' : result.diffMl > 0 ? 'positive' : ''}">${result.diffMl >= 0 ? '+' : ''}${mlText(result.diffMl)}</strong></div>
    <div class="calc-block"><span>Otevřená lahev při ${decimal(document.getElementById('itemTemp').value, 1)} °C</span><strong>${mlText(result.openMlAtTemp)}</strong></div>
    <div class="calc-block"><span>Prodejní dopad</span><strong class="${result.saleDifference < 0 ? 'negative' : 'positive'}">${result.saleDifference >= 0 ? '+' : ''}${money(result.saleDifference)}</strong></div>
    <div class="calc-block"><span>Stav měření</span><strong>${result.status === 'baseline' ? 'Počáteční stav' : result.status === 'ok' ? 'Souhlasí' : 'Prověřit'}</strong></div>
  `;
}
function saveInventoryLine(forceIssue = false) {
  const p = productById(currentInventoryProductId);
  if (!p) return toast('Vyber produkt.');
  const grossInput = document.getElementById('grossWeight').value;
  const gross = num(grossInput);
  if (grossInput === '' || (!isCountedItem(p) && !gross)) return toast(isCountedItem(p) ? 'Zadej skutečný počet.' : 'Zadej hmotnost lahve.');
  const result = calculateMeasurement(p, gross, document.getElementById('sealedCount').value, document.getElementById('itemTemp').value);
  if (!result.valid) return toast(result.reason, 5000);
  const line = {
    id: uid('invline'), productId: p.id, grossWeightG: gross, sealedCount: num(document.getElementById('sealedCount').value),
    tempC: num(document.getElementById('itemTemp').value), note: document.getElementById('inventoryNote').value.trim(),
    ...result, status: forceIssue ? 'issue' : result.status, measuredAt: new Date().toISOString()
  };
  const existingIndex = state.currentInventory.lines.findIndex(l => l.productId === p.id);
  if (existingIndex >= 0) state.currentInventory.lines[existingIndex] = line; else state.currentInventory.lines.push(line);
  saveState();
  renderInventory();
  toast(`${p.name}: stav uložen.`);
}
function renderInventoryLines() {
  const lines = state.currentInventory.lines || [];
  document.getElementById('inventoryProgressBadge').textContent = `${lines.length} položek`;
  document.getElementById('inventoryLines').innerHTML = lines.length ? lines.map(l => {
    const p = productById(l.productId);
    const details = isCountedItem(p)
      ? `${decimal(l.actualUnits, 2)} ${esc(p.countUnit || 'ks')} · rozdíl ${num(l.diffUnits) >= 0 ? '+' : ''}${decimal(l.diffUnits, 2)} ${esc(p.countUnit || 'ks')}`
      : `${mlText(l.actualMl)} · rozdíl ${l.diffMl >= 0 ? '+' : ''}${mlText(l.diffMl)} · ${decimal(l.tempC, 1)} °C`;
    return `<div class="item-row"><div><strong>${esc(p?.name || 'Produkt')}</strong><div class="meta">${details}</div></div><div>${statusBadge(l.status)}<button class="btn btn-small edit-inv-line" data-id="${l.productId}">Opravit</button></div></div>`;
  }).join('') : '<div class="empty-state">Žádná změřená položka.</div>';
  document.querySelectorAll('.edit-inv-line').forEach(btn => btn.addEventListener('click', () => {
    const line = state.currentInventory.lines.find(l => l.productId === btn.dataset.id);
    selectInventoryProduct(btn.dataset.id);
    if (line) {
      document.getElementById('grossWeight').value = isCountedItem(productById(line.productId)) ? line.actualUnits : line.grossWeightG;
      document.getElementById('sealedCount').value = line.sealedCount;
      document.getElementById('itemTemp').value = line.tempC;
      document.getElementById('inventoryNote').value = line.note || '';
      updateMeasurementPreview();
    }
  }));
}
function renderInventory() {
  renderInventorySetup();
  renderInventoryLines();
}
function closeInventory() {
  const lines = state.currentInventory.lines || [];
  if (!lines.length) return toast('Inventura zatím nemá žádnou položku.');
  if (!confirm(`Uzavřít inventuru s ${lines.length} položkami a dorovnat evidenční sklad na skutečnost?`)) return;
  lines.forEach(line => {
    const p = productById(line.productId);
    if (isCountedItem(p)) {
      const currentExpected = stockUnits(line.productId);
      const adjustment = Math.max(0, num(line.actualUnits)) - currentExpected;
      if (Math.abs(adjustment) > 0.001) state.movements.push({
        id: uid('mov'), type: 'adjustment', productId: line.productId, quantityUnits: adjustment,
        requestedQuantityUnits: adjustment, untrackedUnits: 0, date: state.currentInventory.date,
        inventoryId: state.currentInventory.id, note: line.note || line.status, createdAt: new Date().toISOString()
      });
      state.movements.filter(m => m.productId === line.productId && num(m.untrackedUnits) > 0 && !m.resolvedAt).forEach(m => {
        m.resolvedAt = new Date().toISOString();
        m.resolvedByInventoryId = state.currentInventory.id;
      });
      return;
    }
    const currentExpected = stockMl(line.productId);
    const adjustment = num(line.actualMl) - currentExpected;
    if (Math.abs(adjustment) > 0.001) state.movements.push({
      id: uid('mov'), type: 'adjustment', productId: line.productId, quantityMl: adjustment,
      date: state.currentInventory.date, inventoryId: state.currentInventory.id, note: line.note || line.status, createdAt: new Date().toISOString()
    });
  });
  state.inventorySessions.push({ ...state.currentInventory, closedAt: new Date().toISOString() });
  const zoneId = state.currentInventory.zoneId;
  const tempC = state.currentInventory.tempC;
  state.currentInventory = { id: uid('inv'), date: today(), zoneId, tempC, lines: [] };
  currentInventoryProductId = null;
  document.getElementById('inventoryMeasureForm').classList.add('hidden');
  document.getElementById('inventoryMeasureEmpty').classList.remove('hidden');
  saveState();
  toast('Inventura uzavřena a sklad dorovnán.');
}

function openSelectProduct(callback) {
  selectProductCallback = callback;
  document.getElementById('selectProductSearch').value = '';
  renderSelectProductList();
  document.getElementById('selectProductModal').classList.remove('hidden');
}
function renderSelectProductList() {
  const q = document.getElementById('selectProductSearch').value.toLowerCase().trim();
  const list = [...state.products].filter(p => !q || `${p.name} ${p.barcode}`.toLowerCase().includes(q)).sort((a, b) => a.name.localeCompare(b.name, 'cs')).slice(0, 100);
  document.getElementById('selectProductList').innerHTML = list.map(p => `<button class="select-item" data-id="${p.id}"><strong>${esc(p.name)}</strong><small>${esc(p.barcode || 'EAN nedoplněn')} · ${esc(zoneById(p.zoneId)?.name || '')}</small></button>`).join('');
  document.querySelectorAll('.select-item').forEach(btn => btn.addEventListener('click', () => {
    const cb = selectProductCallback;
    closeModal('selectProductModal');
    if (cb) cb(btn.dataset.id);
  }));
}

async function openScanner(callback) {
  scannerCallback = callback;
  document.getElementById('scannerModal').classList.remove('hidden');
  document.getElementById('manualBarcode').value = '';
  if (!window.Html5Qrcode) {
    document.getElementById('scannerReader').innerHTML = '<div class="empty-state">Kamera skeneru se nenačetla. Použij ruční EAN.</div>';
    return;
  }
  try {
    scanner = new window.Html5Qrcode('scannerReader');
    const formats = window.Html5QrcodeSupportedFormats ? [
      Html5QrcodeSupportedFormats.EAN_13, Html5QrcodeSupportedFormats.EAN_8,
      Html5QrcodeSupportedFormats.UPC_A, Html5QrcodeSupportedFormats.UPC_E,
      Html5QrcodeSupportedFormats.CODE_128
    ] : undefined;
    await scanner.start({ facingMode: 'environment' }, { fps: 10, qrbox: { width: 280, height: 150 }, formatsToSupport: formats }, decoded => handleBarcode(decoded), () => {});
  } catch (error) {
    console.warn(error);
    document.getElementById('scannerReader').innerHTML = '<div class="empty-state">Kamera není dostupná. Na iPhonu otevři aplikaci přes HTTPS a povol kameru, nebo zadej EAN ručně.</div>';
  }
}
async function closeScanner() {
  try { if (scanner) await scanner.stop(); } catch (_) {}
  try { if (scanner) await scanner.clear(); } catch (_) {}
  scanner = null;
  document.getElementById('scannerModal').classList.add('hidden');
  document.getElementById('scannerReader').innerHTML = '';
}
async function handleBarcode(code) {
  const barcode = String(code || '').trim();
  if (!barcode) return;
  const p = state.products.find(x => x.barcode === barcode);
  const cb = scannerCallback;
  await closeScanner();
  if (p) {
    if (cb) cb(p.id);
  } else {
    toast(`EAN ${barcode} zatím není spárovaný. Založ nebo uprav produkt.`, 5000);
    openProductModal(null, { barcode });
  }
}

function renderSaleProductSelect() {
  const select = document.getElementById('saleProduct');
  const current = select.value;
  select.innerHTML = productOptions(current, true, p => !isCountedItem(p));
}
function updateSaleFormFromProduct() {
  const p = productById(document.getElementById('saleProduct').value);
  if (!p) return updateSalePreview();
  document.getElementById('saleShotMl').value = p.shotMl || 40;
  document.getElementById('saleUnitPrice').value = p.salePrice || 0;
  updateSalePreview();
}
function updateSalePreview() {
  const p = productById(document.getElementById('saleProduct').value);
  const portions = num(document.getElementById('salePortions').value);
  const shot = num(document.getElementById('saleShotMl').value);
  const price = num(document.getElementById('saleUnitPrice').value);
  const volume = portions * shot;
  const revenue = portions * price;
  const cost = p ? volume * unitCostPerMl(p) : 0;
  const profit = revenue - cost;
  document.getElementById('salePreview').innerHTML = `
    <div class="calc-block"><span>Výdej ze skladu</span><strong>${mlText(volume)}</strong></div>
    <div class="calc-block"><span>Tržba</span><strong>${money(revenue)}</strong></div>
    <div class="calc-block"><span>Hrubý zisk</span><strong class="${profit >= 0 ? 'positive' : 'negative'}">${money(profit)}</strong></div>`;
}
function saveSale(event) {
  event.preventDefault();
  const p = productById(document.getElementById('saleProduct').value);
  if (!p) return toast('Vyber produkt.');
  const portions = num(document.getElementById('salePortions').value);
  const shotMl = num(document.getElementById('saleShotMl').value);
  const unitPrice = num(document.getElementById('saleUnitPrice').value);
  const quantityMl = portions * shotMl;
  if (!quantityMl) return toast('Zadej prodané množství.');
  const revenue = portions * unitPrice;
  const cost = quantityMl * unitCostPerMl(p);
  state.movements.push({
    id: uid('mov'), type: 'sale', productId: p.id, quantityMl: -quantityMl, portions, shotMl, unitPrice,
    revenue, cost, date: document.getElementById('saleDate').value || today(), createdAt: new Date().toISOString()
  });
  saveState();
  document.getElementById('salePortions').value = '1';
  updateSalePreview();
  toast(`Prodej ${p.name} zapsán.`);
}
function renderProfit() {
  const from = document.getElementById('periodFrom').value || monthStart();
  const to = document.getElementById('periodTo').value || today();
  const sales = state.movements.filter(m => m.type === 'sale' && m.date >= from && m.date <= to).sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
  const revenue = sales.reduce((s, m) => s + num(m.revenue), 0);
  const cost = sales.reduce((s, m) => s + num(m.cost), 0);
  const profit = revenue - cost;
  const margin = revenue ? (profit / revenue) * 100 : 0;
  document.getElementById('profitSummary').innerHTML = `
    <div class="profit-box"><span>Tržba</span><strong>${money(revenue)}</strong></div>
    <div class="profit-box"><span>Náklady</span><strong>${money(cost)}</strong></div>
    <div class="profit-box"><span>Hrubý zisk</span><strong class="${profit >= 0 ? 'positive' : 'negative'}">${money(profit)} · ${decimal(margin, 1)} %</strong></div>`;
  document.getElementById('salesList').innerHTML = sales.length ? sales.slice(0, 100).map(m => {
    const p = productById(m.productId);
    return `<div class="item-row"><div><strong>${esc(p?.name || 'Produkt')}</strong><div class="meta">${esc(m.date)} · ${decimal(m.portions, 2)} × ${decimal(m.shotMl, 0)} ml</div></div><div class="money">${money(m.revenue - m.cost)}</div></div>`;
  }).join('') : '<div class="empty-state">V tomto období nejsou zapsané prodeje.</div>';
}

function renderSettings() {
  document.getElementById('toleranceMl').value = state.settings.toleranceMl;
  document.getElementById('defaultTempCoeff').value = state.settings.defaultTempCoeffPctPer10C;
  const wrap = document.getElementById('zonesEditor');
  wrap.innerHTML = state.zones.map((z, i) => `<div class="item-row zone-row" data-index="${i}"><div style="display:grid;grid-template-columns:1fr 120px;gap:8px;flex:1"><input class="zone-name" value="${esc(z.name)}"><input class="zone-temp" type="number" step="0.1" value="${z.tempC}"></div><button class="icon-btn remove-zone">×</button></div>`).join('');
  wrap.querySelectorAll('.zone-row').forEach(row => {
    const i = Number(row.dataset.index);
    row.querySelector('.zone-name').addEventListener('change', e => { state.zones[i].name = e.target.value.trim() || state.zones[i].name; saveState(); });
    row.querySelector('.zone-temp').addEventListener('change', e => { state.zones[i].tempC = num(e.target.value); saveState(); });
    row.querySelector('.remove-zone').addEventListener('click', () => {
      const zone = state.zones[i];
      if (state.zones.length <= 1) return toast('Musí zůstat alespoň jedna zóna.');
      if (state.products.some(p => p.zoneId === zone.id)) return toast('Zóna je přiřazená produktům. Nejdřív je přesuň.');
      state.zones.splice(i, 1); saveState();
    });
  });
}

function renderAll() {
  renderDashboard();
  renderProducts();
  renderInventory();
  renderSaleProductSelect();
  renderProfit();
  renderSettings();
  renderInvoiceLines();
}

function setupEvents() {
  document.querySelectorAll('.nav-btn').forEach(btn => btn.addEventListener('click', () => switchView(btn.dataset.view)));
  document.querySelectorAll('[data-close-modal]').forEach(btn => btn.addEventListener('click', () => closeModal(btn.dataset.closeModal)));
  document.querySelectorAll('.modal').forEach(modal => modal.addEventListener('click', e => { if (e.target === modal && modal.id !== 'scannerModal') closeModal(modal.id); }));

  document.getElementById('newProductBtn').addEventListener('click', () => openProductModal());
  document.getElementById('productSearch').addEventListener('input', renderProducts);
  document.getElementById('onlyIncomplete').addEventListener('change', renderProducts);
  document.getElementById('productItemMode').addEventListener('change', () => {
    const definition = COUNTED_ITEM_DEFINITIONS[document.getElementById('productItemMode').value];
    if (definition) {
      document.getElementById('productCountUnit').value = definition.countUnit;
      const category = document.getElementById('productCategory');
      const defaultCategories = new Set(Object.values(COUNTED_ITEM_DEFINITIONS).map(item => item.category));
      if (!category.value.trim() || defaultCategories.has(category.value.trim())) category.value = definition.category;
    }
    updateProductModeUI();
  });
  ['productVolume', 'productTare', 'productFullWeight'].forEach(id => document.getElementById(id).addEventListener('input', updateCoefHelper));
  document.getElementById('useAutoCoefBtn').addEventListener('click', () => {
    const coef = updateCoefHelper();
    if (!coef) return toast('Nejdřív doplň objem, táru a plnou hmotnost.');
    document.getElementById('productCoef').value = coef.toFixed(6);
    document.getElementById('productCalibration').value = 'provisional';
  });
  document.getElementById('productForm').addEventListener('submit', event => {
    event.preventDefault();
    const id = document.getElementById('productId').value || uid('p');
    const old = productById(id);
    const selectedMode = document.getElementById('productItemMode').value;
    const countedDefinition = COUNTED_ITEM_DEFINITIONS[selectedMode] || null;
    const counted = !!countedDefinition;
    const p = {
      ...(old || {}), id,
      name: document.getElementById('productName').value.trim(),
      category: document.getElementById('productCategory').value.trim(),
      barcode: document.getElementById('productBarcode').value.trim(),
      volumeMl: counted ? null : num(document.getElementById('productVolume').value) || null,
      abv: counted || document.getElementById('productAbv').value === '' ? null : num(document.getElementById('productAbv').value),
      shotMl: counted ? 1 : num(document.getElementById('productShot').value) || 40,
      salePrice: counted ? 0 : num(document.getElementById('productSalePrice').value),
      purchasePrice: num(document.getElementById('productPurchasePrice').value),
      tareG: counted || document.getElementById('productTare').value === '' ? null : num(document.getElementById('productTare').value),
      fullWeightG: counted || document.getElementById('productFullWeight').value === '' ? null : num(document.getElementById('productFullWeight').value),
      coefMlPerG: counted || document.getElementById('productCoef').value === '' ? null : num(document.getElementById('productCoef').value),
      refTempC: num(document.getElementById('productRefTemp').value),
      tempCoeffPctPer10C: num(document.getElementById('productTempCoeff').value),
      zoneId: document.getElementById('productZone').value,
      calibrationStatus: counted ? 'verified' : document.getElementById('productCalibration').value,
      unitMode: counted ? 'counted' : selectedMode,
      itemKind: counted ? countedDefinition.kind : 'product',
      itemSubtype: counted ? countedDefinition.subtype : null,
      countUnit: counted ? (document.getElementById('productCountUnit').value.trim() || countedDefinition.countUnit) : 'ks',
      aliases: counted
        ? [...new Set([...(old?.itemKind === countedDefinition.kind && old?.itemSubtype === countedDefinition.subtype ? old.aliases || [] : []), ...countedDefinition.aliases])]
        : old?.aliases || [],
      createdAt: old?.createdAt || new Date().toISOString(), updatedAt: new Date().toISOString()
    };
    const duplicate = state.products.find(x => x.barcode && p.barcode && x.barcode === p.barcode && x.id !== p.id);
    if (duplicate) return toast(`EAN už používá ${duplicate.name}.`, 5000);
    if (old) state.products[state.products.findIndex(x => x.id === id)] = p; else state.products.push(p);
    closeModal('productModal'); saveState(); toast('Produkt uložen.');
  });

  document.getElementById('invoiceFile').addEventListener('change', e => handleInvoiceFile(e.target.files[0]));
  document.getElementById('parseInvoiceBtn').addEventListener('click', parseInvoiceText);
  document.getElementById('clearOcrBtn').addEventListener('click', () => { document.getElementById('ocrText').value = ''; invoiceDraftLines = []; renderInvoiceLines(); });
  document.getElementById('addInvoiceLineBtn').addEventListener('click', () => { invoiceDraftLines.push({ id: uid('line'), rawName: '', productId: '', qty: 1, unitPrice: 0, state: 'new' }); renderInvoiceLines(); });
  document.getElementById('saveReceiptBtn').addEventListener('click', saveReceipt);

  document.getElementById('inventoryZone').addEventListener('change', e => {
    state.currentInventory.zoneId = e.target.value;
    state.currentInventory.tempC = zoneById(e.target.value).tempC;
    document.getElementById('inventoryTemp').value = state.currentInventory.tempC;
    saveState(false);
  });
  document.getElementById('inventoryTemp').addEventListener('change', e => { state.currentInventory.tempC = num(e.target.value); saveState(false); });
  document.getElementById('inventoryDate').addEventListener('change', e => { state.currentInventory.date = e.target.value; saveState(false); });
  document.getElementById('inventorySelectBtn').addEventListener('click', () => openSelectProduct(selectInventoryProduct));
  document.getElementById('inventoryScanBtn').addEventListener('click', () => openScanner(selectInventoryProduct));
  document.getElementById('quickScanBtn').addEventListener('click', () => openScanner(id => { switchView('inventory'); selectInventoryProduct(id); }));
  ['grossWeight', 'sealedCount', 'itemTemp'].forEach(id => document.getElementById(id).addEventListener('input', updateMeasurementPreview));
  document.getElementById('inventoryMeasureForm').addEventListener('submit', e => { e.preventDefault(); saveInventoryLine(false); });
  document.getElementById('markIssueBtn').addEventListener('click', () => saveInventoryLine(true));
  document.getElementById('closeInventoryBtn').addEventListener('click', closeInventory);

  document.getElementById('selectProductSearch').addEventListener('input', renderSelectProductList);
  document.getElementById('closeScannerBtn').addEventListener('click', closeScanner);
  document.getElementById('manualBarcodeBtn').addEventListener('click', () => handleBarcode(document.getElementById('manualBarcode').value));
  document.getElementById('manualBarcode').addEventListener('keydown', e => { if (e.key === 'Enter') handleBarcode(e.target.value); });

  document.getElementById('saleProduct').addEventListener('change', updateSaleFormFromProduct);
  ['salePortions', 'saleShotMl', 'saleUnitPrice'].forEach(id => document.getElementById(id).addEventListener('input', updateSalePreview));
  document.getElementById('saleForm').addEventListener('submit', saveSale);
  ['periodFrom', 'periodTo'].forEach(id => document.getElementById(id).addEventListener('change', renderProfit));

  document.getElementById('toleranceMl').addEventListener('change', e => { state.settings.toleranceMl = num(e.target.value); saveState(); });
  document.getElementById('defaultTempCoeff').addEventListener('change', e => { state.settings.defaultTempCoeffPctPer10C = num(e.target.value); saveState(); });
  document.getElementById('addZoneBtn').addEventListener('click', () => { state.zones.push({ id: uid('zone'), name: 'Nová zóna', tempC: 20 }); saveState(); });
  document.getElementById('exportBtn').addEventListener('click', () => {
    const blob = new Blob([JSON.stringify(state, null, 2)], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob); a.download = `stav-zaloha-${today()}.json`; a.click(); URL.revokeObjectURL(a.href);
  });
  document.getElementById('importFile').addEventListener('change', async e => {
    try {
      const imported = JSON.parse(await e.target.files[0].text());
      if (!imported.products || !imported.movements) throw new Error('Soubor nemá očekávanou strukturu.');
      state = { ...imported, version: 2, products: ensureCountedCatalog(imported.products) }; saveState(); toast('Záloha importována.');
    } catch (error) { toast(`Import selhal: ${error.message}`, 5000); }
    e.target.value = '';
  });
  document.getElementById('resetBtn').addEventListener('click', () => {
    if (!confirm('Opravdu smazat všechna lokální data aplikace?')) return;
    state = defaultState(); localStorage.removeItem(STORAGE_KEY); saveState(); toast('Lokální data byla smazána.');
  });
}

function init() {
  ensureCurrentInventory();
  if (!localStorage.getItem(STORAGE_KEY)) saveState(false);
  document.getElementById('invoiceDate').value = today();
  document.getElementById('saleDate').value = today();
  document.getElementById('periodFrom').value = monthStart();
  document.getElementById('periodTo').value = today();
  setupEvents();
  renderAll();
  updateSalePreview();
  if ('serviceWorker' in navigator && location.protocol !== 'file:') navigator.serviceWorker.register('./sw.js').catch(console.warn);
}

if (typeof document !== 'undefined') document.addEventListener('DOMContentLoaded', init);

if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    detectCountedItemKey,
    bestProductMatch,
    extractInvoiceQuantity,
    signedInvoiceQuantity,
    boundCountedQuantity,
    capCountedMovement,
    ensureCountedCatalog,
    isCountedItem,
    isPackaging,
    isConsumable
  };
}
