'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { webcrypto } = require('node:crypto');
const { JSDOM } = require('jsdom');

const root = path.resolve(__dirname, '../../pub_guru');
const ocrText = 'Dodavatel: Test supplier\nČíslo dokladu: 123456\nTest vodka 1 ks 10,00 10,00\nCelkem: 10,00';
const visionInvoice = {
  supplier: 'Test supplier', invoice_number: 'TEST-1', issue_date: '2026-10-05',
  total_gross: 10, warnings: [],
  lines: [{ raw_name: 'Test vodka', quantity: 1, unit_price_net: 10,
    vat_rate: 0, line_total_net: 10, line_total_gross: 10, confidence: 1 }]
};

async function until(predicate, label) {
  for (let i = 0; i < 200; i++) {
    if (predicate()) return;
    await new Promise(resolve => setTimeout(resolve, 5));
  }
  throw new Error('Timed out: ' + label);
}

async function harness({ payload = {}, visionOk = true, native = false, nativeFails = false,
  serverVision = true, browser = true, nativeText = ocrText, pages = 1, serverHang = false } = {}) {
  const html = fs.readFileSync(path.join(root, 'invoice-capture.html'), 'utf8');
  const dom = new JSDOM(html, { url: 'https://invoices.test/pub_guru/invoice-capture.html', runScripts: 'outside-only' });
  const w = dom.window, writes = [], calls = [];
  let sessionReads = 0, nativeReads = 0;
  Object.defineProperty(w, 'crypto', { value: webcrypto });
  w.console = { error: assert.fail, warn() {} };
  w.PubGuruBackend = {
    loadContext: async () => ({ organization: { id: 'org-test' }, venue: { id: 'venue-test' }, user: { id: 'user-test' }, role: 'staff' }),
    client: {
      auth: { getSession: async () => { sessionReads++; return { data: { session: { access_token: 'test-only' } } }; } },
      from(table) {
        return {
          error: null,
          select() { return this; }, eq() { return this; }, is() { return this; },
          order: async () => ({ data: [], error: null }),
          maybeSingle: async () => ({ data: null, error: null }),
          insert(data) { writes.push({ table, data: JSON.parse(JSON.stringify(data)) }); return this; },
          single: async () => ({ data: { id: 'invoice-' + writes.length }, error: null })
        };
      }
    }
  };
  w.fetch = async (url, options) => {
    calls.push('vision');
    assert.equal(url, '/api/invoice-vision');
    assert.equal(options.headers.Authorization, 'Bearer test-only');
    const body = JSON.parse(options.body);
    assert.ok(body.data_url || body.file_data);
    if (serverHang) return new Promise((_, reject) => options.signal.addEventListener('abort', () => reject(new Error('Aborted'))));
    return { ok: visionOk, status: visionOk ? 200 : 503,
      json: async () => visionOk ? { invoice: visionInvoice, ...payload } : { error: 'vision_not_configured' } };
  };
  if (browser) w.Tesseract = { recognize: async () => { calls.push('tesseract'); return { data: { text: ocrText } }; } };
  w.HTMLCanvasElement.prototype.getContext = function () {
    return { getImageData: () => ({ data: new Uint8ClampedArray(this.width * this.height * 4) }), putImageData() {}, fillRect() {}, drawImage() {} };
  };
  w.Image = class { naturalWidth = 100; naturalHeight = 50; async decode() {} };
  w.URL.createObjectURL = () => 'blob:fixture-image';
  w.URL.revokeObjectURL = () => {};
  w.HTMLCanvasElement.prototype.toDataURL = () => 'data:image/jpeg;base64,dGVzdA==';
  w.pdfjsLib = {
    GlobalWorkerOptions: {},
    getDocument: () => ({ promise: Promise.resolve({ numPages: pages,
      getPage: async () => ({ getViewport: () => ({ width: 4, height: 4 }), render: () => ({ promise: Promise.resolve() }) }) }) })
  };
  if (native) {
    w.webkit = { messageHandlers: { pubGuruVision: { postMessage({ requestId }) {
      calls.push('native');
      nativeReads++;
      queueMicrotask(() => w.PubGuruNativeOCR.resolve((typeof nativeFails === 'function' ? nativeFails(nativeReads) : nativeFails)
        ? { requestId, error: 'native unavailable' }
        : { requestId, text: nativeText, confidence: 1 }));
    } } } };
  }
  if (serverHang) {
    const timeout = w.setTimeout.bind(w);
    w.setTimeout = (fn, ms, ...args) => timeout(fn, ms === 20000 ? 1 : ms, ...args);
  }
  for (const name of ['invoice-fast-capture.js', 'native-vision-bridge.js', 'ocr-text-normalizer.js', 'invoice-capture-v3.js', 'invoice-reading-guard.js']) {
    w.eval(fs.readFileSync(path.join(root, name), 'utf8'));
  }
  await until(() => w.document.getElementById('invoiceFile').onchange, 'invoice capture initialized');
  w.document.getElementById('useServerVision').checked = serverVision;

  return {
    dom, w, writes, calls,
    sessionReads: () => sessionReads,
    async capture(source = 'invoiceFile') {
      const camera = source === 'cameraFile';
      const file = new w.File(['test document'], camera ? 'invoice.jpg' : 'invoice.pdf', { type: camera ? 'image/jpeg' : 'application/pdf' });
      file.arrayBuffer = async () => new TextEncoder().encode('test PDF').buffer;
      const previousCalls = calls.length;
      const input = w.document.getElementById(source);
      Object.defineProperty(input, 'files', { configurable: true, value: [file] });
      input.dispatchEvent(new w.Event('change', { bubbles: true }));
      await until(() => calls.length > previousCalls && w.document.getElementById('ocrProgress').style.width === '100%', 'document read');
      assert.equal(w.document.getElementById('lineCount').textContent, '1');
    },
    async submit() {
      const submit = w.document.getElementById('submitBtn');
      assert.equal(submit.disabled, false, 'complete document must be submittable through the UI');
      const previousAudits = writes.filter(x => x.table === 'audit_events').length;
      submit.click();
      await until(() => writes.filter(x => x.table === 'audit_events').length > previousAudits, 'invoice and audit saved');
      const invoice = writes.filter(x => x.table === 'invoices').at(-1)?.data;
      const audit = writes.filter(x => x.table === 'audit_events').at(-1)?.data;
      assert.ok(invoice && audit, 'invoice and audit must both be persisted');
      assert.equal(audit.event_type, 'invoice.captured_for_review');
      assert.equal(audit.after_data.captured_lines, 1);
      return { invoice, audit: audit.after_data };
    },
    failVision() { visionOk = false; }
  };
}

function assertProvenance({ invoice, audit }, provider, model) {
  assert.equal(invoice.extraction_provider, provider);
  assert.equal(audit.extraction_provider, invoice.extraction_provider, 'audit must identify the same extraction provider as the invoice');
  assert.equal(audit.extraction_model, model);
  if (model) assert.equal(audit.extraction_model, invoice.raw_extraction.crop.model);
}

for (const native of [false, true]) {
  test('successful server Vision persists matching provenance with native OCR ' + (native ? 'available' : 'absent'), async () => {
    const h = await harness({ native, payload: { provider: 'openai-vision', model: 'vision-test-model' } });
    try {
      await h.capture();
      assert.deepEqual(h.calls, ['vision'], 'successful Vision must bypass OCR');
      const saved = await h.submit();
      assert.equal(saved.invoice.raw_extraction.crop.vision, true);
      assertProvenance(saved, 'openai-vision', 'vision-test-model');
    } finally { h.dom.window.close(); }
  });
}

test('server Vision provider metadata is used by both invoice and audit', async () => {
  const h = await harness({ payload: { provider: 'vision-provider-from-response', model: 'vision-test-model' } });
  try {
    await h.capture();
    assertProvenance(await h.submit(), 'vision-provider-from-response', 'vision-test-model');
  } finally { h.dom.window.close(); }
});

test('server Vision without optional metadata keeps its default provider and a null model', async () => {
  const h = await harness();
  try {
    await h.capture();
    assertProvenance(await h.submit(), 'openai-vision', null);
  } finally { h.dom.window.close(); }
});

for (const [label, options, provider, calls] of [
  ['browser OCR', {}, 'tesseract-browser-v3', ['vision', 'tesseract']],
  ['native OCR', { native: true }, 'apple-vision-native', ['vision', 'native']],
  ['browser OCR after native failure', { native: true, nativeFails: true }, 'tesseract-browser-v3', ['vision', 'native', 'tesseract']]
]) {
  test('failed server Vision records actual ' + label + ' provenance without an AI model', async () => {
    const h = await harness({ visionOk: false, ...options });
    try {
      await h.capture();
      assert.deepEqual(h.calls, calls);
      assertProvenance(await h.submit(), provider, null);
    } finally { h.dom.window.close(); }
  });
}

test('a subsequent OCR fallback replaces the previous document Vision provider and model', async () => {
  const h = await harness({ payload: { provider: 'openai-vision', model: 'previous-vision-model' } });
  try {
    await h.capture();
    assertProvenance(await h.submit(), 'openai-vision', 'previous-vision-model');
    h.failVision();
    await h.capture();
    assert.deepEqual(h.calls, ['vision', 'vision', 'tesseract']);
    const saved = await h.submit();
    assertProvenance(saved, 'tesseract-browser-v3', null);
    assert.notEqual(saved.invoice.raw_extraction.crop.vision, true);
  } finally { h.dom.window.close(); }
});

test('server Vision with an unreadable document total remains blocked for review', async () => {
  const h = await harness({ payload: { invoice: { ...visionInvoice, total_gross: null } } });
  try {
    await h.capture();
    assert.equal(h.w.document.getElementById('submitBtn').disabled, true);
    assert.match(h.w.document.getElementById('invoiceReadGateText').textContent, /CELKEM/);
    h.w.document.getElementById('submitBtn').click();
    assert.equal(h.writes.length, 0, 'missing total must not be invented or persisted');
  } finally { h.dom.window.close(); }
});

for (const [label, options, provider, calls] of [
  ['iOS native OCR', { native: true }, 'apple-vision-native', ['native']],
  ['iOS without a Tesseract CDN', { native: true, browser: false }, 'apple-vision-native', ['native']],
  ['Safari / PWA', {}, 'tesseract-browser-v3', ['tesseract']],
  ['iOS recognition error', { native: true, nativeFails: true }, 'tesseract-browser-v3', ['native', 'tesseract']],
  ['iOS empty result', { native: true, nativeText: ' \n' }, 'tesseract-browser-v3', ['native', 'tesseract']]
]) test(label + ' reads a camera image, parses and saves without any paid Vision call', async () => {
  const h = await harness({ serverVision: false, ...options });
  try {
    await h.capture('cameraFile');
    assert.deepEqual(h.calls, calls);
    assert.equal(h.sessionReads(), 0, 'local OCR must not require an API bearer token');
    const saved = await h.submit();
    assertProvenance(saved, provider, null);
    assert.match(saved.invoice.raw_extraction.raw_text, /Test vodka/);
    assert.equal(h.writes.find(x => x.table === 'invoice_lines').data.quantity, 1);
    assert.equal(h.writes.some(x => x.table === 'invoice_capture_jobs'), false, 'single camera capture must reach OCR instead of being intercepted by the batch queue');
    assert.match(h.w.document.getElementById('ocrMode').textContent, options.native ? /iOS aplikace/ : /Safari \/ PWA/);
  } finally { h.dom.window.close(); }
});

test('the invoice page defaults to local OCR and keeps the explicit batch input', async () => {
  const html = fs.readFileSync(path.join(root, 'invoice-capture.html'), 'utf8');
  const dom = new JSDOM(html);
  try {
    assert.equal(dom.window.document.getElementById('useServerVision').checked, false);
    assert.ok(dom.window.document.getElementById('batchFiles').multiple);
  } finally { dom.window.close(); }
});

test('server Vision timeout falls back to local OCR instead of leaving an invoice stuck', async () => {
  const h = await harness({ serverHang: true });
  try {
    await h.capture();
    assert.deepEqual(h.calls, ['vision', 'tesseract']);
    assertProvenance(await h.submit(), 'tesseract-browser-v3', null);
  } finally { h.dom.window.close(); }
});

test('mixed native and browser PDF OCR retains both providers in invoice and audit', async () => {
  const h = await harness({ serverVision: false, native: true, pages: 2, nativeFails: n => n === 2 });
  try {
    // Both pages contain the same fixture, so the parser will create two lines.
    const file = new h.w.File(['pdf'], 'invoice.pdf', { type: 'application/pdf' });
    file.arrayBuffer = async () => new Uint8Array([1]).buffer;
    h.w.document.getElementById('invoiceFile').onchange({ target: { files: [file] } });
    await until(() => h.w.document.getElementById('ocrProgress').style.width === '100%', 'PDF read');
    h.w.document.getElementById('submitBtn').click();
    await until(() => h.writes.some(x => x.table === 'audit_events'), 'mixed-provider audit');
    const invoice = h.writes.find(x => x.table === 'invoices').data;
    const audit = h.writes.find(x => x.table === 'audit_events').data;
    assert.equal(invoice.extraction_provider, 'apple-vision-native+tesseract-browser-v3');
    assert.equal(audit.after_data.extraction_provider, invoice.extraction_provider);
    assert.deepEqual(invoice.raw_extraction.crop.providers, ['apple-vision-native', 'tesseract-browser-v3']);
  } finally { h.dom.window.close(); }
});

test('saving a local OCR invoice leaves existing approved invoice history readable', async () => {
  const h = await harness({ native: true, serverVision: false });
  const existing = Object.freeze({ id: 'old-invoice', organization_id: 'org-test', venue_id: 'venue-test',
    supplier_name: 'Existing supplier', invoice_number: 'OLD-2026', issue_date: '2026-10-01',
    total_amount_gross: 42, status: 'approved', payment_status: 'paid', payment_method: 'cash' });
  let history;
  try {
    h.w.localStorage.setItem('pub_guru_context_v1', '{"organization":{"id":"org-test"}}');
    await h.capture('cameraFile');
    const saved = await h.submit();
    assert.equal(h.w.localStorage.getItem('pub_guru_context_v1'), '{"organization":{"id":"org-test"}}');
    const ledger = [existing, { ...saved.invoice, id: 'new-review' }];
    history = new JSDOM(fs.readFileSync(path.join(root, 'invoice-history.html'), 'utf8'), {
      url: 'https://pub-bizz-pokladna.vercel.app/pub_guru/invoice-history.html', runScripts: 'outside-only'
    });
    const filters = [];
    history.window.PubGuruBackend = {
      loadContext: async () => ({ user: { id: 'user-test' }, role: 'owner', organization: { id: 'org-test' }, venue: { id: 'venue-test' } }),
      client: { from(table) {
        assert.equal(table, 'invoices');
        const eqs = [];
        return { select() { return this; }, eq(key, value) { eqs.push([key, value]); return this; },
          gte() { return this; }, lte() { return this; }, order() { return this; },
          async limit() { filters.push(...eqs); return { data: ledger.filter(row => eqs.every(([key, value]) => row[key] === value)), error: null }; }
        };
      } }
    };
    history.window.eval(fs.readFileSync(path.join(root, 'invoice-history.js'), 'utf8'));
    await until(() => history.window.document.getElementById('count').textContent === '1', 'existing history rendered');
    assert.match(history.window.document.getElementById('results').textContent, /Existing supplier.*OLD-2026/s);
    assert.match(history.window.document.getElementById('sum').textContent, /42/);
    assert.ok(filters.some(([key, value]) => key === 'organization_id' && value === 'org-test'));
    assert.ok(filters.some(([key, value]) => key === 'venue_id' && value === 'venue-test'));
    assert.equal(existing.invoice_number, 'OLD-2026');
    assert.equal(ledger[1].status, 'review', 'OCR cannot silently approve a new invoice');
  } finally { history?.window.close(); h.dom.window.close(); }
});
