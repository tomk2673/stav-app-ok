'use strict';
const {test} = require('node:test');
const assert = require('node:assert/strict');
const {setup, actor, stranger, org, venue, otherOrg, otherVenue, secondVenue, hash} = require('./invoice-drive-fixture.cjs');
const fingerprint = 'b'.repeat(64);
const file = {id: 'fictionPhoto01', version: '1', name: 'fiktivni-faktura.jpg', mime_type: 'image/jpeg'};
const extraction = {raw_text: 'FIKTIVNÍ DOKLAD\nCelkem 121 Kč', supplier: 'FIKCE', invoice_number: 'FICT-1', issue_date: null,
  total_gross: 121, provider: 'fixture-ocr', lines: [{rawName: 'Fiktivní zboží', qty: 1, price: 100, vatRate: 21, lineNet: 100, lineGross: 121}]};

test('the source scope guard covers manual capture races as well as worker routing', async () => {
  const f = await setup();
  try {
    await f.db.exec('reset role');
    await f.db.query('insert into invoices(organization_id,venue_id,created_by,source_fingerprint) values($1,$2,$3,$4)', [org, venue, actor, fingerprint]);
    await assert.rejects(f.db.query('insert into invoice_capture_jobs(organization_id,venue_id,created_by,source_path,source_fingerprint) values($1,$2,$3,$4,$5)',
      [org, secondVenue, actor, 'fiction.jpg', fingerprint]), /belongs to another venue/);
    await f.db.query('insert into invoice_capture_jobs(organization_id,venue_id,created_by,source_path,source_fingerprint) values($1,$2,$3,$4,$5)',
      [org, venue, actor, 'fiction.jpg', 'c'.repeat(64)]);
    await assert.rejects(f.db.query('insert into invoices(organization_id,venue_id,created_by,source_fingerprint) values($1,$2,$3,$4)',
      [org, secondVenue, actor, 'c'.repeat(64)]), /belongs to another venue/);
    await assert.rejects(f.db.query('insert into invoice_capture_jobs(organization_id,venue_id,created_by,source_path) values($1,$2,$3,$4)',
      [org, otherVenue, actor, 'fiction.jpg']), /venue mismatch/);
    assert.equal((await f.db.query('select count(*)::int as n from stock_movements')).rows[0].n, 0);
  } finally { await f.close(); }
});

test('Drive aliases and lost/repeated enqueue responses retain one original job and never post stock', async () => {
  const f = await setup();
  try {
    const lease = await f.worker('start', f.source.id);
    const item = await f.worker('reserve', f.source.id, lease.lease_token, file);
    await assert.rejects(f.worker('enqueue', f.source.id, lease.lease_token, {file_id: item.id, fingerprint, mime_type: 'image/jpeg'}), /Original upload required/);
    const first = await f.worker('enqueue', f.source.id, lease.lease_token, {file_id: item.id, fingerprint, mime_type: 'image/jpeg', uploaded: true});
    assert.equal(first.status, 'queued');
    assert.deepEqual(await f.worker('enqueue', f.source.id, lease.lease_token, {file_id: item.id}), first);
    assert.deepEqual(await f.worker('fail', f.source.id, lease.lease_token, {file_id: item.id, error: 'lost response'}), first);
    const alias = await f.worker('reserve', f.source.id, lease.lease_token, {...file, id: 'fictionPhoto02', name: 'jiný název.jpg'});
    assert.equal((await f.worker('enqueue', f.source.id, lease.lease_token, {file_id: alias.id, fingerprint, mime_type: 'image/jpeg', uploaded: true})).status, 'duplicate');
    const rows = (await f.db.query('select * from public.invoice_capture_jobs')).rows;
    assert.equal(rows.length, 1); assert.equal(rows[0].status, 'queued'); assert.equal(rows[0].source_fingerprint, fingerprint);
    assert.equal(rows[0].source_path, `${org}/${venue}/${actor}/drive/${fingerprint}.jpg`);
    await f.as('authenticated');
    const summary = await f.command('summary');
    assert.equal(summary.files.length, 2); assert.equal(new Set(summary.files.map(x => x.drive_file_id)).size, 2);
    assert.equal(summary.files[0].source_path, rows[0].source_path);
    await f.db.exec('reset role');
    assert.deepEqual((await f.db.query('select (select count(*)::int from invoices) as invoices,(select count(*)::int from stock_movements) as stock')).rows[0], {invoices: 0, stock: 0});
  } finally { await f.close(); }
});

test('a shared organization never routes a duplicate into another venue; other organizations get independent jobs', async () => {
  const f = await setup();
  try {
    const lease = await f.worker('start', f.source.id);
    const first = await f.worker('reserve', f.source.id, lease.lease_token, file);
    await f.worker('enqueue', f.source.id, lease.lease_token, {file_id: first.id, fingerprint, mime_type: 'image/jpeg', uploaded: true});
    for (const [targetOrg, targetVenue, targetHash, folder] of [[org, secondVenue, 'c'.repeat(64), 'fixtureFolderA2'], [otherOrg, otherVenue, 'd'.repeat(64), 'fixtureFolderB1']]) {
      await f.as('authenticated');
      const source = await f.command('connect', null, {folder_id: folder, secret_hash: targetHash}, {org: targetOrg, venue: targetVenue});
      await f.as('service_role');
      const lease2 = await f.worker('start', source.id, null, {}, targetHash);
      const item = await f.worker('reserve', source.id, lease2.lease_token, file, targetHash);
      const queued = await f.worker('enqueue', source.id, lease2.lease_token, {file_id: item.id, fingerprint, mime_type: 'image/jpeg', uploaded: true}, targetHash);
      assert.equal(queued.status, targetOrg === org ? 'failed' : 'queued');
      if (targetOrg === org) assert.equal((await f.db.query('select job_id from invoice_drive_files where id=$1', [item.id])).rows[0].job_id, null);
    }
    assert.equal((await f.db.query('select count(*)::int as n from invoice_capture_jobs')).rows[0].n, 2);
  } finally { await f.close(); }
});

test('configuration, routing, worker RPC and capability hashes are inaccessible to staff or strangers', async () => {
  const f = await setup();
  try {
    await f.as('authenticated');
    await assert.rejects(f.command('connect', null, {folder_id: 'fixtureFolderA1', secret_hash: hash}, {venue: secondVenue}), /another destination/);
    await assert.rejects(f.command('summary', null, {}, {venue: otherVenue}), /access denied/);
    await assert.rejects(f.worker('start', f.source.id), /permission denied/);
    await assert.rejects(f.db.query('select * from private.invoice_drive_credentials'), /permission denied/);
    await assert.rejects(f.db.query('update public.invoice_drive_sources set venue_id=$1', [secondVenue]), /permission denied/);
    await f.db.exec('reset role'); await f.db.query("update memberships set role='staff' where organization_id=$1", [org]);
    await f.as('authenticated'); assert.equal((await f.command('summary')).sources.length, 1);
    await assert.rejects(f.command('connect', null, {folder_id: 'fictionOther01', secret_hash: hash}), /Only a manager/);
    await f.as('service_role'); assert.equal((await f.worker('start', f.source.id)).authorization_revoked, true);
    await f.as('authenticated'); assert.match((await f.command('summary')).sources[0].error_message, /nemá oprávnění/);
    await f.as('authenticated', stranger); await assert.rejects(f.command('summary'), /access denied/);
    assert.equal((await f.db.query('select * from invoice_drive_sources')).rows.length, 0);
    await f.as('anon', ''); await assert.rejects(f.command('summary'), /permission denied/);
  } finally { await f.close(); }
});

test('source leases serialize polls, recover after crashes and fence rotated/disconnected capabilities', async () => {
  const f = await setup();
  try {
    const lease = await f.worker('start', f.source.id);
    assert.equal((await f.worker('start', f.source.id)).busy, true);
    await f.db.exec('reset role'); await f.db.exec("update private.invoice_drive_credentials set lease_until=now()-interval '1 second'"); await f.as('service_role');
    const recovered = await f.worker('start', f.source.id); assert.notEqual(recovered.lease_token, lease.lease_token);
    await assert.rejects(f.worker('reserve', f.source.id, lease.lease_token, file), /lease lost/);
    await f.as('authenticated'); await f.command('connect', null, {folder_id: 'fixtureFolderA1', secret_hash: 'e'.repeat(64)});
    await f.as('service_role'); await assert.rejects(f.worker('start', f.source.id), /authorization failed/);
    await f.as('authenticated'); await f.command('disconnect', f.source.id);
    await f.as('service_role'); await assert.rejects(f.worker('start', f.source.id, null, {}, 'e'.repeat(64)), /authorization failed/);
  } finally { await f.close(); }
});

test('interrupted files retry, exhaust visibly, and manager retry preserves completed records and fences the worker', async () => {
  const f = await setup();
  try {
    const lease = await f.worker('start', f.source.id);
    const item = await f.worker('reserve', f.source.id, lease.lease_token, file);
    await f.db.exec('reset role'); await f.db.query("update invoice_drive_files set attempts=5,started_at=now()-interval '6 minutes' where id=$1", [item.id]); await f.as('service_role');
    assert.equal((await f.worker('reserve', f.source.id, lease.lease_token, file)).skip, true);
    assert.equal((await f.db.query('select status from invoice_drive_files where id=$1', [item.id])).rows[0].status, 'failed');
    await f.as('authenticated'); await f.command('retry', f.source.id);
    await f.as('service_role'); await assert.rejects(f.worker('reserve', f.source.id, lease.lease_token, file), /lease lost/);
    const next = await f.worker('start', f.source.id);
    assert.equal((await f.worker('reserve', f.source.id, next.lease_token, file)).id, item.id);
    await f.worker('enqueue', f.source.id, next.lease_token, {file_id: item.id, fingerprint, mime_type: 'image/jpeg', uploaded: true});
    await f.as('authenticated'); await f.command('retry', f.source.id); await f.as('service_role');
    assert.equal((await f.db.query('select status from invoice_drive_files where id=$1', [item.id])).rows[0].status, 'queued');
  } finally { await f.close(); }
});

test('existing OCR completion creates only a review invoice; HEIC originals stay in private storage', async () => {
  const f = await setup();
  try {
    const lease = await f.worker('start', f.source.id);
    const item = await f.worker('reserve', f.source.id, lease.lease_token, {...file, name: 'fiktivní.heic', mime_type: 'image/heic'});
    await f.worker('enqueue', f.source.id, lease.lease_token, {file_id: item.id, fingerprint, mime_type: 'image/heic', uploaded: true});
    await f.as('authenticated');
    const job = (await f.db.query('select public.invoice_capture_command($1,$2,$3) as result', ['claim', org, venue])).rows[0].result;
    const result = (await f.db.query('select public.invoice_capture_command($1,$2,$3,$4,$5,$6) as result', ['complete', org, venue, job.id, job.claim_token, JSON.stringify(extraction)])).rows[0].result;
    assert.equal(result.status, 'review');
    const summary = await f.command('summary'); assert.equal(summary.files[0].ocr_status, 'review'); assert.equal(summary.files[0].invoice_status, 'review');
    await f.db.exec('reset role');
    assert.equal((await f.db.query('select invoice_id from invoice_drive_files where id=$1', [item.id])).rows[0].invoice_id, result.invoice_id);
    await f.db.query('delete from invoice_capture_jobs where id=$1', [job.id]);
    await f.as('authenticated'); assert.equal((await f.command('summary')).files[0].invoice_status, 'review');
    await f.db.exec('reset role');
    const bucket = (await f.db.query('select * from storage.buckets')).rows[0];
    assert.equal(bucket.public, false); assert.equal(Number(bucket.file_size_limit), 8388608); assert.ok(bucket.allowed_mime_types.includes('image/heic'));
    assert.equal((await f.db.query('select count(*)::int as n from stock_movements')).rows[0].n, 0);
    assert.equal((await f.db.query('select count(*)::int as n from purchase_price_history')).rows[0].n, 0);
  } finally { await f.close(); }
});
