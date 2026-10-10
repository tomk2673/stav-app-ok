'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { webcrypto } = require('node:crypto');
const { JSDOM } = require('jsdom');

const root = path.resolve(__dirname, '../../pub_guru');
const ocrText = 'Dodavatel: Test supplier\nČíslo dokladu: 123456\nCena/ks bez DPH · DPH 0%\nTest vodka 1 ks 10,00 10,00\nCelkem: 10,00';
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

async function harness({ payload = {}, visionOk = true, native = false, nativeFails = false, serverVision = true, pdfPages=1, text=ocrText, expectedLines=1 } = {}) {
  const html = fs.readFileSync(path.join(root, 'invoice-capture.html'), 'utf8');
  const dom = new JSDOM(html, { url: 'https://invoices.test/pub_guru/invoice-capture.html', runScripts: 'outside-only' });
  const w = dom.window, writes = [], calls = [];
  w.document.getElementById('useServerVision').checked=serverVision;
  Object.defineProperty(w, 'crypto', { value: webcrypto });
  w.console = { error: assert.fail, warn() {} };
  w.PubGuruBackend = {
    loadContext: async () => ({ organization: { id: 'org-test' }, venue: { id: 'venue-test' }, user: { id: 'user-test' }, role: 'staff' }),
    client: {
      auth: { getSession: async () => ({ data: { session: { access_token: 'test-only' } } }) },
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
    return { ok: visionOk, status: visionOk ? 200 : 503,
      json: async () => visionOk ? { invoice: visionInvoice, ...payload } : { error: 'vision_not_configured' } };
  };
  w.Tesseract = { recognize: async () => { calls.push('tesseract'); return { data: { text } }; } };
  w.HTMLCanvasElement.prototype.getContext = function () {
    return { getImageData: () => ({ data: new Uint8ClampedArray(this.width * this.height * 4) }), putImageData() {} };
  };
  w.HTMLCanvasElement.prototype.toDataURL = () => 'data:image/jpeg;base64,dGVzdA==';
  w.pdfjsLib = {
    GlobalWorkerOptions: {},
    getDocument: () => ({ promise: Promise.resolve({ numPages: pdfPages,
      getPage: async () => ({ getViewport: () => ({ width: 4, height: 4 }), render: () => ({ promise: Promise.resolve() }) }) }) })
  };
  if (native) {
    w.webkit = { messageHandlers: { pubGuruVision: { postMessage({ requestId }) {
      calls.push('native');
      queueMicrotask(() => w.PubGuruNativeOCR.resolve(nativeFails
        ? { requestId, error: 'native unavailable' }
        : { requestId, text, confidence: 1 }));
    } } } };
  }
  for (const name of ['native-vision-bridge.js', 'invoice-capture-v3.js', 'invoice-reading-guard.js']) {
    w.eval(fs.readFileSync(path.join(root, name), 'utf8'));
  }
  await until(() => w.document.getElementById('invoiceFile').onchange, 'invoice capture initialized');

  return {
    dom, w, writes, calls,
    async capture() {
      const file = new w.File(['test PDF'], 'invoice.pdf', { type: 'application/pdf' });
      file.arrayBuffer = async () => new TextEncoder().encode('test PDF').buffer;
      const previousCalls = calls.length;
      w.document.getElementById('invoiceFile').onchange({ target: { files: [file] } });
      await until(() => calls.length > previousCalls && w.document.getElementById('ocrProgress').style.width === '100%', 'document read');
      assert.equal(w.document.getElementById('lineCount').textContent, String(expectedLines));
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

test('default document reading is local and does not invoke a paid API',async()=>{
  const h=await harness({serverVision:false});
  try{
    await h.capture();
    assert.deepEqual(h.calls,['tesseract']);
    assertProvenance(await h.submit(),'tesseract-browser-v3',null);
  }finally{h.dom.window.close();}
});

test('queued document keeps the upload fingerprint, does not invent a date, and cannot be manually submitted during saving',async()=>{
  const h=await harness();
  try{
    const file=new h.w.File(['compressed'], 'source.pdf',{type:'application/pdf'});
    file.arrayBuffer=async()=>new TextEncoder().encode('compressed').buffer;
    h.w.PubGuruInvoiceCapture.beginQueue();
    const result=await h.w.PubGuruInvoiceCapture.readQueued(file,{source_fingerprint:'original-upload-hash'});
    assert.deepEqual(h.calls,['tesseract'],'batch always uses local OCR');
    assert.equal(result.issue_date,null,'missing original issue date must stay missing');
    assert.equal(result.lines.length,1);
    assert.equal(result.provider,'tesseract-browser-v3');
    assert.equal(h.w.document.getElementById('submitBtn').disabled,true);
    h.w.document.getElementById('submitBtn').click();
    assert.equal(h.writes.length,0,'saving belongs to the atomic queue RPC');
    assert.equal(h.w.document.getElementById('ocrText').disabled,true,'editing stays locked until persistence finishes');
    h.w.PubGuruInvoiceCapture.clearQueued();h.w.PubGuruInvoiceCapture.endQueue();
    assert.equal(h.w.PubGuruInvoiceCapture.hasDraft(),false);
    assert.equal(h.w.document.getElementById('ocrText').disabled,false);
  }finally{h.dom.window.close();}
});

test('queue refuses to overwrite a manual draft and reports unreadable item text',async()=>{
  const h=await harness({serverVision:false});
  try{
    await h.capture();
    const file=new h.w.File(['test'], 'invoice.pdf',{type:'application/pdf'});
    file.arrayBuffer=async()=>new TextEncoder().encode('test').buffer;
    await assert.rejects(h.w.PubGuruInvoiceCapture.readQueued(file,{source_fingerprint:'hash'}),/rozepsaný doklad/);
    assert.equal(h.w.document.getElementById('lineCount').textContent,'1');
    h.w.PubGuruInvoiceCapture.clear();
    h.w.Tesseract.recognize=async()=>({data:{text:'This photo contains no item quantities or prices'}});
    await assert.rejects(h.w.PubGuruInvoiceCapture.readQueued(file,{source_fingerprint:'hash'}),/žádná položka/);
    assert.equal(h.w.PubGuruInvoiceCapture.isBusy(),false);
  }finally{h.dom.window.close();}
});

test('queued PDFs read every page rather than silently stopping after the fourth',async()=>{
  const h=await harness({serverVision:false,pdfPages:5});
  try{
    const file=new h.w.File(['test'], 'invoice.pdf',{type:'application/pdf'});
    file.arrayBuffer=async()=>new TextEncoder().encode('test').buffer;
    const result=await h.w.PubGuruInvoiceCapture.readQueued(file,{source_fingerprint:'original'});
    assert.equal(h.calls.length,5);assert.equal(result.lines.length,5);
    assert.match(result.raw_text,/STRANA 5/);
  }finally{h.dom.window.close();}
});

test('supplier quantities with one or three decimal places are not multiplied by 1000',async()=>{
  const text='Dodavatel: Test supplier\nČíslo dokladu: 123456\nCena/ks bez DPH · DPH 0%\n'+
    '0361 CO2 15kg 1,000 ks 570,25 570,25\n0323 0323 Pivoplyn 201 (15kg) 2.000 ks 599,17 1198,34\n'+
    '0211 Vratná záloha -1,000 ks 1000,- -1000,-\nTest voda 1,5 ks 10,00 15,00\nTest soda 0.125 ks 10,00 1,25\nTest obaly 1000 ks 1,00 1000,00\nCelkem: 1784,84';
  const h=await harness({serverVision:false,text,expectedLines:6});
  try{
    await h.capture();
    const quantities=[...h.w.document.querySelectorAll('.qty')].map(x=>Number(x.value));
    assert.deepEqual(quantities,[1,2,-1,1.5,0.125,1000]);
    assert.equal(h.w.document.querySelector('.rawName').value,'CO2 15kg');
    assert.match(h.w.document.querySelector('.line-meta').textContent,/kód 0361/);
    assert.equal(h.w.document.querySelectorAll('.price')[2].value,'1000.00');
  }finally{h.dom.window.close();}
});

test('ROJAL decimal quantities retain their VAT and printed line totals',async()=>{
  const text='ROJAL spol. s r.o.\nČíslo dokladu: 123456\nID zboží Název zboží\nAB-123 Test vodka\n21% 1,000 KS 121,00 121,00\nCelkem [CZK]: 121,00';
  const h=await harness({serverVision:false,text});
  try{
    await h.capture();
    assert.equal(h.w.document.querySelector('.qty').value,'1');
    assert.equal(h.w.document.querySelector('.price').value,'100.00');
    assert.match(h.w.document.querySelector('.line-meta').textContent,/DPH 21%/);
  }finally{h.dom.window.close();}
});

for(const [label,totalText,expected] of [
  ['excise note on one line','Kč: 5 812,00\nSpotřební daň obsažená v prodejní ceně celkem 629,20Kč',5812],
  ['excise note on a separate line','Kc: 5 812,00\nSpotřební daň obsažená v prodejní ceně\ncelkem 629,20Kč',5812],
  ['gross before net summary','Celkem s DPH: 5.812,00\nCelkem bez DPH: 4803,31\nCelkem DPH: 1008,69',5812],
  ['amount due before excise','Celkem k úhradě: 5 812,00\nSpotřební daň obsažená v prodejní ceně celkem 629,20 Kč',5812],
  ['printed dash notation','K úhradě: 1000,-',1000],
  ['conflicting totals','Celkem: 5 812,00\nCelkem: 6 000,00',null],
  ['excise is the only amount','Spotřební daň obsažená v prodejní ceně\ncelkem 629,20 Kč',null]
]){
  test('invoice total distinguishes '+label,async()=>{
    const text=ocrText.replace('Celkem: 10,00',totalText);
    const h=await harness({serverVision:false,text});
    try{
      await h.capture();
      assert.equal(h.w.PubGuruInvoiceCapture.printedTotal(),expected);
      if(expected===null){
        assert.equal(h.w.document.getElementById('submitBtn').disabled,true);
        h.w.document.getElementById('submitBtn').click();
        assert.equal(h.writes.length,0);
      }
    }finally{h.dom.window.close();}
  });
}

test('unknown generic price basis and VAT stay missing rather than becoming zero-tax net prices',async()=>{
  const h=await harness({serverVision:false,text:ocrText.replace('Cena/ks bez DPH · DPH 0%\n','')});
  try{
    await h.capture();
    assert.equal(h.w.document.querySelector('.price').value,'');
    assert.match(h.w.document.querySelector('.line-meta').textContent,/nepřečtená sazba DPH/);
    assert.match(h.w.document.querySelector('.line-meta').textContent,/není jasné/);
    assert.equal(h.w.document.getElementById('submitBtn').disabled,true);
  }finally{h.dom.window.close();}
});

test('editing numeric inputs preserves decimal quantities and decimal prices on persistence',async()=>{
  const h=await harness({serverVision:false});
  try{
    await h.capture();
    for(const [selector,value] of [['.qty','1.5'],['.price','9.5']]){
      const input=h.w.document.querySelector(selector);input.value=value;input.dispatchEvent(new h.w.Event('input',{bubbles:true}));
    }
    await h.submit();
    const line=h.writes.find(x=>x.table==='invoice_lines').data;
    assert.equal(line.quantity,1.5);
    assert.equal(line.unit_price_net,9.5);
  }finally{h.dom.window.close();}
});

test('grouped quantities and alphanumeric invoice identifiers remain readable',async()=>{
  const text=ocrText.replace('Číslo dokladu: 123456','Faktura č.: FV-2026/100').replace('1 ks','1 234,000 ks');
  const h=await harness({serverVision:false,text});
  try{
    await h.capture();
    assert.equal(h.w.document.querySelector('.qty').value,'1234');
    assert.equal(h.w.document.getElementById('number').value,'FV-2026/100');
  }finally{h.dom.window.close();}
});

test('the reading gate checks the current OCR text rather than a stale parsed total',async()=>{
  const h=await harness({serverVision:false});
  try{
    await h.capture();
    const input=h.w.document.getElementById('ocrText');
    input.value=ocrText.replace('Celkem: 10,00','Spotřební daň obsažená v prodejní ceně celkem 629,20 Kč');
    input.dispatchEvent(new h.w.Event('input',{bubbles:true}));
    assert.equal(h.w.PubGuruInvoiceCapture.printedTotal(),null);
    assert.equal(h.w.document.getElementById('submitBtn').disabled,true);
    assert.equal(h.writes.length,0);
  }finally{h.dom.window.close();}
});
