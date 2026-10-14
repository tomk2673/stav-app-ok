'use strict';
const {test} = require('node:test');
const assert = require('node:assert/strict');
const {setup, actor, org, venue} = require('./invoice-drive-fixture.cjs');
const capability = '1'.repeat(64);
const jpeg = new Uint8Array([255, 216, 255, 224, 70, 73, 67, 84, 73, 79, 78]);
const pdf = new TextEncoder().encode('%PDF-1.7\nFICTIONAL FIXTURE\n%%EOF');
const heic = new Uint8Array([0, 0, 0, 24, ...new TextEncoder().encode('ftypheic0000mif1heic')]);
const json = (data, status = 200) => new Response(JSON.stringify(data), {status, headers: {'Content-Type': 'application/json'}});

async function setupApi(options = {}) {
  const f = await setup();
  const {createHandler, sha256} = await import('../../supabase/functions/invoice-drive-import/core.mjs');
  const secret = await sha256(new TextEncoder().encode(capability));
  await f.as('authenticated'); await f.command('connect', null, {folder_id: f.source.folder_id, secret_hash: secret});
  await f.as('service_role');
  const objects = new Map(); const calls = [];
  let entries = options.files || [{id: 'fictionPhoto01', name: 'fiktivni.jpg', mimeType: 'image/jpeg', version: '1', bytes: jpeg}];
  const metadataReads = new Map();
  let loseUpload = !!options.loseUpload, loseEnqueue = !!options.loseEnqueue;
  async function fetcher(url, init) {
    url = new URL(url); calls.push({url: url.href, headers: init.headers, method: init.method || 'GET'});
    assert.equal(init.redirect, 'error');
    if (url.hostname === 'fixture.supabase.co' && url.pathname === '/rest/v1/rpc/invoice_drive_worker') {
      const args = JSON.parse(init.body);
      assert.match(args.p_secret_hash, /^[a-f0-9]{64}$/); assert.ok(!init.body.includes(capability));
      try {
        await f.as('service_role');
        const data = await f.worker(args.p_action, args.p_source_id, args.p_token, args.p_payload, args.p_secret_hash);
        if (args.p_action === 'enqueue' && loseEnqueue) { loseEnqueue = false; throw new Error('FICTIONAL lost HTTP response'); }
        return json(data);
      } catch (error) {
        if (error.code) return json({code: error.code}, 400);
        throw error;
      }
    }
    if (url.hostname === 'www.googleapis.com') {
      assert.equal(init.headers.Authorization, 'Bearer fixture-google-access-token');
      if (options.googleError) return json({}, options.googleError);
      const id = url.pathname.split('/').pop();
      if (id === 'files') {
        assert.equal(url.searchParams.get('q'), "'fixtureFolderA1' in parents and trashed = false");
        if (options.badCursor && url.searchParams.get('pageToken')) return json({}, 400);
        const selected = options.pages ? options.pages[url.searchParams.get('pageToken') || 'recent'] : entries;
        return json({files: selected.map(({bytes, ...metadata}) => metadata), nextPageToken: options.nextPageToken || undefined});
      }
      if (id === f.source.folder_id) return json({id, mimeType: 'application/vnd.google-apps.folder', trashed: false});
      const item = entries.find(x => x.id === id); assert.ok(item, 'only pinned folder children may be requested');
      if (url.searchParams.get('alt') === 'media') return new Response(item.bytes,
        {headers: {'Content-Length': String(options.contentLength || item.bytes.length)}});
      const count = (metadataReads.get(id) || 0) + 1; metadataReads.set(id, count);
      return json({...item, bytes: undefined, size: String(item.bytes.length),
        parents: [options.foreignParent ? 'fictionWrongFolder' : f.source.folder_id],
        version: options.changedVersion && count % 2 === 0 ? '2' : item.version});
    }
    assert.equal(url.hostname, 'fixture.supabase.co'); assert.ok(url.pathname.startsWith('/storage/v1/object/invoice-sources/'));
    const key = url.pathname;
    if (init.method === 'POST') {
      if (objects.has(key)) return json({statusCode: '409'}, 409);
      objects.set(key, new Uint8Array(init.body));
      if (loseUpload) { loseUpload = false; throw new Error('FICTIONAL lost upload response'); }
      return json({Key: key});
    }
    assert.ok(objects.has(key)); return new Response(objects.get(key));
  }
  const handler = createHandler({supabaseUrl: 'https://fixture.supabase.co', serviceKey: 'fixture-service-key'}, {fetch: fetcher});
  const request = (extra = {}, token = capability) => handler(new Request('https://fixture.supabase.co/functions/v1/invoice-drive-import', {
    method: 'POST', headers: {Authorization: 'Bearer ' + token},
    body: JSON.stringify({action: 'sync', source_id: f.source.id, google_token: 'fixture-google-access-token', ...extra})
  }));
  const count = async table => { await f.db.exec('reset role'); return (await f.db.query('select count(*)::int as n from ' + table)).rows[0].n; };
  return {...f, request, handler, calls, objects, count, setFiles: value => { entries = value; }};
}

test('server imports original JPG/HEIC/PDF, pins the Drive folder and deduplicates renamed copies', async () => {
  const f = await setupApi({files: [
    {id: 'fictionPhoto01', name: 'fiktivni.jpg', mimeType: 'image/jpeg', version: '1', bytes: jpeg},
    {id: 'fictionPhoto02', name: 'fiktivni.heic', mimeType: 'image/heic', version: '1', bytes: heic},
    {id: 'fictionDoc0001', name: 'fiktivni.pdf', mimeType: 'application/pdf', version: '1', bytes: pdf}
  ]});
  try {
    assert.equal((await f.request({folder_id: 'ignoredForeignFolder', organization_id: 'ignored'})).status, 200);
    assert.equal(await f.count('invoice_capture_jobs'), 3); assert.equal(f.objects.size, 3);
    assert.deepEqual([...f.objects.values()], [jpeg, heic, pdf]);
    for (const name of f.objects.keys()) assert.ok(name.includes(`${org}/${venue}/${actor}/drive/`));
    assert.equal((await f.request()).status, 200); assert.equal(await f.count('invoice_capture_jobs'), 3);
    f.setFiles([{id: 'fictionPhoto03', name: 'stejná-fotka-jiný-název.jpg', mimeType: 'image/jpeg', version: '1', bytes: jpeg}]);
    assert.equal((await f.request()).status, 200); assert.equal(await f.count('invoice_capture_jobs'), 3); assert.equal(f.objects.size, 3);
    assert.equal(await f.count('invoice_drive_files'), 4);
    assert.equal(await f.count('invoices'), 0); assert.equal(await f.count('stock_movements'), 0);
    assert.ok(f.calls.filter(x => x.url.startsWith('https://www.googleapis.com')).every(x => !JSON.stringify(x).includes(capability)));
    assert.ok(f.calls.filter(x => x.url.startsWith('https://fixture.supabase.co')).every(x => !JSON.stringify(x.headers).includes('fixture-google-access-token')));
  } finally { await f.close(); }
});

test('a failed upload response recovers the existing bytes without replacing the original or enqueuing twice', async () => {
  const f = await setupApi({loseUpload: true});
  try {
    const first = await (await f.request()).json(); assert.equal(first.results[0].status, 'failed');
    assert.equal(f.objects.size, 1); assert.equal(await f.count('invoice_capture_jobs'), 0);
    await f.as('authenticated'); await f.command('retry', f.source.id);
    const retry = await (await f.request()).json(); assert.equal(retry.results[0].status, 'queued');
    assert.equal(await f.count('invoice_capture_jobs'), 1); assert.equal(f.objects.size, 1);
    assert.equal(f.calls.filter(x => x.method === 'GET' && x.url.includes('/storage/')).length, 1);
  } finally { await f.close(); }
});

test('lost enqueue response reconciles to queued instead of changing a committed result to failed', async () => {
  const f = await setupApi({loseEnqueue: true});
  try {
    const result = await (await f.request()).json(); assert.equal(result.results[0].status, 'queued');
    await f.request(); assert.equal(await f.count('invoice_capture_jobs'), 1);
    await f.db.exec('reset role'); assert.equal((await f.db.query('select status from invoice_drive_files')).rows[0].status, 'queued');
  } finally { await f.close(); }
});

test('an older manual invoice still receives an exact original backup without being changed or recreated', async () => {
  const f = await setupApi();
  try {
    const {sha256} = await import('../../supabase/functions/invoice-drive-import/core.mjs');
    const fingerprint = await sha256(jpeg);
    await f.db.exec('reset role');
    await f.db.query('insert into invoices(organization_id,venue_id,created_by,source_fingerprint,source_file_name,status) values($1,$2,$3,$4,$5,$6)',
      [org, venue, actor, fingerprint, 'original-manual-name.jpg', 'review']);
    assert.equal((await f.request()).status, 200);
    assert.equal(f.objects.size, 1); assert.deepEqual([...f.objects.values()][0], jpeg);
    assert.equal(await f.count('invoice_capture_jobs'), 0); assert.equal(await f.count('invoices'), 1);
    await f.as('authenticated'); const summary = await f.command('summary');
    assert.equal(summary.files[0].import_status, 'duplicate'); assert.ok(summary.files[0].source_path.endsWith(fingerprint + '.jpg'));
    await f.db.exec('reset role'); assert.equal((await f.db.query('select source_file_name from invoices')).rows[0].source_file_name, 'original-manual-name.jpg');
  } finally { await f.close(); }
});

test('Google document types and shortcuts with image-like names are ignored', async () => {
  const f = await setupApi({files: [{id: 'fictionShortcut', name: 'shortcut.jpg', mimeType: 'application/vnd.google-apps.shortcut', version: '1', bytes: jpeg}]});
  try {
    assert.equal((await f.request()).status, 200); assert.equal(await f.count('invoice_capture_jobs'), 0); assert.equal(f.objects.size, 0);
    assert.ok(!f.calls.some(x => x.url.includes('fictionShortcut')));
  } finally { await f.close(); }
});

test('requests without the exact import capability cannot read Google or choose a different source', async () => {
  const f = await setupApi();
  try {
    const noToken = await f.handler(new Request('https://fixture', {method: 'POST', body: '{}'})); assert.equal(noToken.status, 401);
    const wrongToken = await f.request({}, '2'.repeat(64));
    // Hash mismatch is enforced by the real SQL, not only by mocked authentication.
    assert.equal(wrongToken.status, 401);
    assert.equal(f.calls.filter(x => x.url.startsWith('https://www.googleapis.com')).length, 0);
    assert.equal((await f.request({source_id: '70000000-0000-4000-8000-000000000001'})).status, 401);
    assert.equal((await f.request({google_token: 'token\r\nInjected: true'})).status, 400);
    assert.equal((await f.request({action: 'approve'})).status, 400);
  } finally { await f.close(); }
});

for (const [label, options, expected] of [
  ['Google permission revoked', {googleError: 403}, 'Google nepovolil'],
  ['Google token expired', {googleError: 401}, 'Google přístup vypršel'],
  ['Google unavailable', {googleError: 503}, 'Google Drive není dostupný']
]) test(label + ' remains visible and never touches invoices or stock', async () => {
  const f = await setupApi(options);
  try {
    assert.notEqual((await f.request()).status, 200);
    await f.as('authenticated'); assert.match((await f.command('summary')).sources[0].error_message, new RegExp(expected));
    assert.equal(await f.count('invoice_capture_jobs'), 0); assert.equal(await f.count('invoices'), 0); assert.equal(await f.count('stock_movements'), 0);
  } finally { await f.close(); }
});

for (const [label, options, expected] of [
  ['file changed during download', {changedVersion: true}, 'během stahování'],
  ['file moved out of the pinned folder', {foreignParent: true}, 'během stahování'],
  ['oversized origin', {contentLength: 8388609}, 'přesahuje 8 MB'],
  ['spoofed file extension', {files: [{id: 'fictionPhoto01', name: 'false.jpg', mimeType: 'image/jpeg', version: '1', bytes: new TextEncoder().encode('<script>fiction</script>')}]}, 'není platný']
]) test(label + ' records a retryable import failure', async () => {
  const f = await setupApi(options);
  try {
    const result = await (await f.request()).json(); assert.equal(result.results[0].status, 'failed');
    await f.as('authenticated'); const row = (await f.command('summary')).files[0];
    assert.match(row.import_error, new RegExp(expected)); assert.equal(row.import_status, 'failed');
    assert.equal(await f.count('invoice_capture_jobs'), 0); assert.equal(f.objects.size, 0);
  } finally { await f.close(); }
});

test('an invalid pagination cursor is cleared without discarding successful imports', async () => {
  const f = await setupApi({badCursor: true});
  try {
    await f.db.exec('reset role'); await f.db.query("update private.invoice_drive_credentials set page_token='expired-page' where source_id=$1", [f.source.id]);
    assert.equal((await f.request()).status, 409);
    await f.db.exec('reset role'); assert.equal((await f.db.query('select page_token from private.invoice_drive_credentials')).rows[0].page_token, null);
    assert.equal((await f.request()).status, 200); assert.equal(await f.count('invoice_capture_jobs'), 1);
  } finally { await f.close(); }
});

test('new files are checked before backfill when a large folder has an unfinished scan', async () => {
  const newest = {id: 'fictionPhoto01', name: 'nová-faktura.jpg', mimeType: 'image/jpeg', version: '1', bytes: jpeg};
  const older = {id: 'fictionDoc0001', name: 'starší-faktura.pdf', mimeType: 'application/pdf', version: '1', bytes: pdf};
  const f = await setupApi({files: [newest, older], pages: {recent: [newest], 'older-page': [older]}});
  try {
    await f.db.exec('reset role'); await f.db.query("update private.invoice_drive_credentials set page_token='older-page' where source_id=$1", [f.source.id]);
    assert.equal((await f.request()).status, 200); assert.equal(await f.count('invoice_capture_jobs'), 2);
    const reads = f.calls.filter(x => new URL(x.url).pathname === '/drive/v3/files');
    assert.equal(new URL(reads[0].url).searchParams.get('pageToken'), null);
    assert.equal(new URL(reads[1].url).searchParams.get('pageToken'), 'older-page');
    assert.equal(new URL(reads[0].url).searchParams.get('orderBy'), 'modifiedTime desc,name');
  } finally { await f.close(); }
});
