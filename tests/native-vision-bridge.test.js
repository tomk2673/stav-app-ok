'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const root = path.resolve(__dirname, '..');
const read = file => fs.readFileSync(path.join(root, file), 'utf8');

function harness({ native = true, browser = true, postThrows = false } = {}) {
  const requests = [], fallbackInputs = [], timers = new Map();
  let sequence = 0;
  class HTMLCanvasElement {
    toDataURL(type, quality) {
      assert.equal(type, 'image/jpeg'); assert.equal(quality, 0.94);
      return 'data:image/jpeg;base64,dGVzdA==';
    }
  }
  const context = { HTMLCanvasElement, console: { warn() {} },
    setTimeout(fn, delay) { const id = ++sequence; timers.set(id, { fn, delay }); return id; },
    clearTimeout(id) { timers.delete(id); }, setInterval() { return 0; }, clearInterval() {},
    PubGuruNormalizeOcrText: text => text.replace('Brutto celkem', 'Brutto součet')
  };
  context.window = context;
  if (browser) context.Tesseract = { recognize: async (input, language, options) => {
    fallbackInputs.push({ input, language, options });
    return { data: { text: 'Browser OCR', confidence: 88 } };
  } };
  if (native) context.webkit = { messageHandlers: { pubGuruVision: { postMessage(payload) {
    if (postThrows) throw new Error('Bridge closed');
    requests.push(payload);
  } } } };
  vm.runInNewContext(read('pub_guru/native-vision-bridge.js'), context);
  return { context, requests, fallbackInputs, timers, canvas: new HTMLCanvasElement() };
}

test('iOS entry uses the verified production HTTPS alias and keeps persistent identity', () => {
  const policy = read('ios/PubGuruIOS/PubGuruWebPolicy.swift');
  const url = policy.match(/startURL = URL\(string: "([^"]+)"\)/)[1];
  assert.equal(url, 'https://pub-bizz-pokladna.vercel.app/pub_guru/start.html');
  assert.ok(fs.existsSync(path.join(root, new URL(url).pathname)));
  const view = read('ios/PubGuruIOS/PubGuruWebView.swift');
  assert.match(view, /startURL = PubGuruWebPolicy.startURL/);
  assert.doesNotMatch(view, /pub-guru-v1|raw\.githack\.com|removeData|nonPersistent/);
  assert.match(view, /websiteDataStore = \.default\(\)/);
  const project = read('ios/project.yml');
  assert.match(project, /PRODUCT_BUNDLE_IDENTIFIER: cz\.pubguru\.app/);
  for (const permission of ['NSPhotoLibraryUsageDescription', 'NSCameraUsageDescription']) assert.match(project, new RegExp(permission));
  assert.match(view, /message\.frameInfo\.isMainFrame/);
  assert.match(view, /source == self\.navigationID/);
  const migration = read('ios/PubGuruIOS/WebSessionMigration.swift');
  assert.match(migration, /loadHTMLString\(Self\.blankHTML/);
  assert.doesNotMatch(migration, /URLRequest|localStorage\.clear|localStorage\.removeItem|print\(/);
});

test('Apple Vision works without the Tesseract CDN and preserves text, lines and confidence', async () => {
  const h = harness({ browser: false });
  assert.equal(h.context.PubGuruNativeOCR.available(), true);
  const result = h.context.PubGuruNativeOCR.recognize(h.canvas);
  const request = h.requests[0];
  assert.equal(request.imageDataUrl, h.canvas.toDataURL('image/jpeg', 0.94));
  h.context.PubGuruNativeOCR.resolve({ requestId: request.requestId,
    text: 'Vodka 1 ks\nBrutto celkem', confidence: 0.92, lines: [{ text: 'Vodka 1 ks', x: 0.1 }] });
  const data = (await result).data;
  assert.equal(data.text, 'Vodka 1 ks\nBrutto součet');
  assert.equal(data.confidence, 92); assert.equal(data.native, true);
  assert.equal(data.lines[0].text, 'Vodka 1 ks');
  assert.equal(h.fallbackInputs.length, 0); assert.equal(h.timers.size, 0);
});

for (const [name, payload] of [
  ['native error', { error: 'Recognition failed' }],
  ['blank OCR', { text: ' \n\t' }],
  ['malformed response', { text: { invoice: 'invalid' } }]
]) test(name + ' falls back with the original canvas and OCR options', async () => {
  const h = harness(), options = { tessedit_pageseg_mode: '6' };
  const promise = h.context.Tesseract.recognize(h.canvas, 'ces+eng', options);
  h.context.PubGuruNativeOCR.resolve({ requestId: h.requests[0].requestId, ...payload });
  assert.equal((await promise).data.text, 'Browser OCR');
  assert.equal(h.fallbackInputs[0].input, h.canvas);
  assert.equal(h.fallbackInputs[0].language, 'ces+eng');
  assert.equal(h.fallbackInputs[0].options, options);
  assert.equal(h.timers.size, 0);
});

test('native timeout uses Tesseract once and ignores late responses', async () => {
  const h = harness();
  const promise = h.context.Tesseract.recognize(h.canvas);
  const requestId = h.requests[0].requestId;
  [...h.timers.values()].find(item => item.delay === 45000).fn();
  assert.equal((await promise).data.text, 'Browser OCR');
  h.context.PubGuruNativeOCR.resolve({ requestId, text: 'Too late' });
  assert.equal(h.fallbackInputs.length, 1);
});

test('synchronous bridge failure cleans up and uses the browser worker', async () => {
  const h = harness({ postThrows: true });
  assert.equal((await h.context.Tesseract.recognize(h.canvas)).data.text, 'Browser OCR');
  assert.equal(h.fallbackInputs.length, 1); assert.equal(h.timers.size, 0);
});

test('Safari and PWA have no native bridge, and only use browser OCR', async () => {
  const h = harness({ native: false });
  assert.equal(h.context.PubGuruNativeOCR.available(), false);
  assert.equal((await h.context.PubGuruNativeOCR.recognize(h.canvas)).data.text, 'Browser OCR');
  assert.equal(h.requests.length, 0); assert.equal(h.fallbackInputs.length, 1);
});

test('OCR errors remain explicit when both engines are unavailable', async () => {
  const h = harness({ browser: false });
  const promise = h.context.PubGuruNativeOCR.recognize(h.canvas);
  h.context.PubGuruNativeOCR.resolve({ requestId: h.requests[0].requestId, error: 'Native unavailable' });
  await assert.rejects(promise, /Místní OCR není dostupné/);
});

test('concurrent native replies are correlated and progress errors cannot hang OCR', async () => {
  const h = harness();
  const first = h.context.Tesseract.recognize(h.canvas, 'ces+eng', { logger() { throw new Error('UI progress failed'); } });
  const second = h.context.Tesseract.recognize(h.canvas);
  h.context.PubGuruNativeOCR.resolve({ requestId: 'unknown', text: 'Ignore' });
  h.context.PubGuruNativeOCR.resolve({ requestId: h.requests[1].requestId, text: 'Second' });
  h.context.PubGuruNativeOCR.resolve({ requestId: h.requests[0].requestId, text: 'First' });
  assert.equal((await first).data.text, 'First'); assert.equal((await second).data.text, 'Second');
  assert.equal(h.timers.size, 0); assert.equal(h.fallbackInputs.length, 0);
});
