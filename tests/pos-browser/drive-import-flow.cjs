'use strict';
// Real browser + original reader/parser + actual queue/RLS SQL, synthetic HEIC.
// Google/Storage and OCR provider responses are simulated; no live invoice is read.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const {chromium} = require('pwmodern');
const {setup, actor, org, venue} = require('../pos-web/invoice-drive-fixture.cjs');
const root = path.resolve(__dirname, '../..');
const text = 'Dodavatel: FIKTIVNI DODAVATEL\nČíslo dokladu: FICT-DRIVE-1\nCena/ks s DPH DPH 21%\nFiktivni zbozi 1 ks 121,00 121,00\nCelkem s DPH: 121,00 Kč';
const json = data => new Response(JSON.stringify(data), {headers: {'Content-Type': 'application/json'}});

(async () => {
  const f = await setup();
  const {createHandler, sha256} = await import('../../supabase/functions/invoice-drive-import/core.mjs');
  const original = new Uint8Array(fs.readFileSync(path.join(root, 'tests/fixtures/fictional-invoice.heic')));
  const fingerprint = await sha256(original);
  const objects = new Map(); let serialized = Promise.resolve(); let ocrCalls = 0;
  const sql = work => { const next = serialized.then(work); serialized = next.catch(() => {}); return next; };
  const names = [{id: 'fictionPhoto01', name: 'fiktivni-faktura.heic'}, {id: 'fictionPhoto02', name: 'stejná-faktura-jiný-název.heic'}];
  const handler = createHandler({supabaseUrl: 'https://fixture.supabase.co', serviceKey: 'fixture-service-key'}, {fetch: async (value, init) => {
    const url = new URL(value);
    if (url.pathname === '/rest/v1/rpc/invoice_drive_worker') {
      const args = JSON.parse(init.body);
      try { return json(await sql(async () => { await f.as('service_role'); return f.worker(args.p_action, args.p_source_id, args.p_token, args.p_payload, args.p_secret_hash); })); }
      catch (error) { return new Response(JSON.stringify({code: error.code}), {status: 400}); }
    }
    if (url.hostname === 'www.googleapis.com') {
      assert.equal(init.headers.Authorization, 'Bearer fixture-google-oauth');
      const id = url.pathname.split('/').pop();
      if (id === 'files') return json({files: names.map(x => ({...x, version: '1', mimeType: 'image/heic'}))});
      if (id === f.source.folder_id) return json({id, mimeType: 'application/vnd.google-apps.folder', trashed: false});
      assert.ok(names.some(x => x.id === id));
      if (url.searchParams.get('alt') === 'media') return new Response(original);
      return json({...names.find(x => x.id === id), version: '1', parents: [f.source.folder_id], size: String(original.length), sha256Checksum: fingerprint, trashed: false});
    }
    assert.ok(url.pathname.startsWith('/storage/v1/object/invoice-sources/'));
    const object = url.pathname.split('/invoice-sources/')[1];
    if (init.method === 'POST') { objects.set(object, new Uint8Array(init.body)); return json({ok: true}); }
    return new Response(objects.get(object));
  }});
  const server = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url, 'http://localhost');
      const send = (data, status = 200, type = 'application/json') => { res.writeHead(status, {'Content-Type': type}); res.end(typeof data === 'string' ? data : JSON.stringify(data)); };
      if (url.pathname === '/__test/rpc') {
        let body = ''; for await (const part of req) body += part;
        const {name, args} = JSON.parse(body);
        const result = await sql(async () => {
          await f.as('authenticated');
          if (name === 'invoice_drive_command') return f.command(args.p_action, args.p_source_id, args.p_payload, {org: args.p_organization_id, venue: args.p_venue_id});
          assert.equal(name, 'invoice_capture_command');
          return (await f.db.query('select public.invoice_capture_command($1,$2,$3,$4,$5,$6,$7) as result',
            [args.p_action, args.p_organization_id, args.p_venue_id, args.p_job_id || null, args.p_token || null,
              args.p_result ? JSON.stringify(args.p_result) : null, args.p_error || null])).rows[0].result;
        });
        send({data: result, error: null}); return;
      }
      if (url.pathname === '/__test/table') {
        let body = ''; for await (const part of req) body += part;
        const args = JSON.parse(body); assert.ok(['products', 'invoices'].includes(args.table));
        const rows = await sql(async () => {
          await f.db.exec('reset role');
          const values = []; const where = [];
          for (const [key, value] of args.filters) { assert.ok(['organization_id', 'source_fingerprint'].includes(key)); values.push(value); where.push(key + '=$' + values.length); }
          return (await f.db.query('select * from public.' + args.table + (where.length ? ' where ' + where.join(' and ') : ''), values)).rows;
        });
        send({data: args.single ? rows[0] || null : rows, error: null}); return;
      }
      if (url.pathname.startsWith('/__test/storage/')) {
        const object = decodeURIComponent(url.pathname.slice('/__test/storage/'.length));
        assert.ok(objects.has(object)); res.writeHead(200, {'Content-Type': 'image/heic'}); res.end(objects.get(object)); return;
      }
      if (url.pathname === '/pub_guru/backend.js') {
        send(`window.PubGuruBackend={loadContext:async()=>({user:{id:${JSON.stringify(actor)}},organization:{id:${JSON.stringify(org)}},venue:{id:${JSON.stringify(venue)},name:'FIKTIVNÍ BAR'},role:'owner'}),client:{
          rpc:async(name,args)=>{const r=await fetch('/__test/rpc',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({name,args})});return r.json();},
          from:table=>{const filters=[];let single=false;const q={select(){return q},eq(k,v){filters.push([k,v]);return q},is(){return q},order(){return q},maybeSingle(){single=true;return q},then(resolve,reject){return fetch('/__test/table',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({table,filters,single})}).then(r=>r.json()).then(resolve,reject)}};return q;},
          storage:{from:()=>({download:async object=>({data:await(await fetch('/__test/storage/'+encodeURIComponent(object))).blob(),error:null})})}}};
          window.PUB_GURU_CONFIG={supabaseUrl:'https://fixture.supabase.co'};
          const drive=document.createElement('script');drive.src='invoice-drive.js';document.head.appendChild(drive);`, 200, 'text/javascript'); return;
      }
      if (url.pathname === '/__test/ocr-count') { ocrCalls++; send({ok: true}); return; }
      const file = path.resolve(root, '.' + url.pathname);
      if (!file.startsWith(root + path.sep) || !fs.existsSync(file) || !fs.statSync(file).isFile()) { send({}, 404); return; }
      const type = /\.m?js$/.test(file) ? 'text/javascript' : file.endsWith('.html') ? 'text/html' : file.endsWith('.css') ? 'text/css' : 'application/octet-stream';
      res.writeHead(200, {'Content-Type': type}); res.end(fs.readFileSync(file));
    } catch (error) { res.writeHead(500, {'Content-Type': 'application/json'}); res.end(JSON.stringify({error: error.message})); }
  });
  let browser;
  try {
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const base = 'http://127.0.0.1:' + server.address().port;
    browser = await chromium.launch({headless: true});
    const context = await browser.newContext({viewport: {width: 390, height: 844}});
    const blocked = [], errors = [];
    await context.route('**/*', async route => {
      const request = route.request(), url = new URL(request.url());
      if (url.hostname === '127.0.0.1') return route.continue();
      if (url.href.includes('/tesseract.min.js')) return route.fulfill({contentType: 'text/javascript', body:
        `window.Tesseract={createWorker:async()=>({setParameters:async()=>{},terminate:async()=>{},recognize:async()=>{await fetch('/__test/ocr-count');return {data:{text:${JSON.stringify(text)}}};}})};`});
      if (url.href.includes('/supabase-js@') || url.href.includes('/pdf.min.js')) return route.fulfill({contentType: 'text/javascript', body: ''});
      blocked.push(url.hostname); return route.abort();
    });
    const page = await context.newPage(); page.on('pageerror', error => errors.push(error.message));
    await page.goto(base + '/pub_guru/invoice-capture.html?driveFolder=' + f.source.folder_id);
    await page.locator('#invoiceDrive').waitFor();
    await page.locator('#invoiceDrive summary').click();
    await page.getByRole('button', {name: 'Připravit propojení', exact: true}).click();
    await page.getByRole('button', {name: 'Vygenerovat nové propojení', exact: true}).waitFor();
    const script = await page.locator('#invoiceDrive textarea').nth(1).inputValue();
    const properties = JSON.parse(script.match(/setProperties\((\{[\s\S]*?\})\)/)[1]);
    assert.equal(properties.PUB_GURU_SOURCE, f.source.id);
    const importRequest = () => handler(new Request('https://fixture.supabase.co/functions/v1/invoice-drive-import', {
      method: 'POST', headers: {Authorization: 'Bearer ' + properties.PUB_GURU_TOKEN},
      body: JSON.stringify({action: 'sync', source_id: properties.PUB_GURU_SOURCE, google_token: 'fixture-google-oauth'})
    }));
    assert.equal((await importRequest()).status, 200);
    assert.equal((await importRequest()).status, 200);
    await page.evaluate(() => { window.dispatchEvent(new Event('focus')); document.dispatchEvent(new Event('visibilitychange')); });
    await page.waitForFunction(() => document.getElementById('queueCount').textContent.includes('1 ke kontrole'), {timeout: 45000});
    await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
    await page.waitForFunction(() => document.getElementById('invoiceDrive').textContent.includes('Přečteno · čeká na schválení'));
    const result = await sql(async () => {
      await f.db.exec('reset role');
      return (await f.db.query(`select (select count(*)::int from invoice_capture_jobs) as jobs,(select count(*)::int from invoice_drive_files) as files,
        (select count(*)::int from invoices) as invoices,(select count(*)::int from invoice_lines) as lines,(select count(*)::int from stock_movements) as stock,
        (select status from invoices limit 1) as status,(select source_fingerprint from invoices limit 1) as fingerprint`)).rows[0];
    });
    assert.deepEqual(result, {jobs: 1, files: 2, invoices: 1, lines: 1, stock: 0, status: 'review', fingerprint});
    assert.equal(objects.size, 1); assert.deepEqual([...objects.values()][0], original); assert.equal(ocrCalls, 1);
    for (const width of [390, 820, 1440]) {
      await page.setViewportSize({width, height: 900});
      assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1), 'no horizontal overflow at ' + width);
    }
    assert.deepEqual(errors, []); assert.deepEqual(blocked, []);
    console.log(JSON.stringify({browser: 'Chromium', realHeicDecode: true, originalBytesPreserved: true, duplicateNames: true,
      rows: result, ocrProvider: 'simulated-fictional-output', layouts: [390, 820, 1440], externalRequests: 0, pageErrors: errors.length}));
    await context.close();
  } finally { await browser?.close(); await new Promise(resolve => server.close(resolve)); await f.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
