'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const appDir = path.join(root, 'pub_guru');
const read = relative => fs.readFileSync(path.join(root, relative), 'utf8');

test('every local HTML asset exists in the Pages artifact', () => {
  const pages = fs.readdirSync(appDir).filter(name => name.endsWith('.html'));
  const missing = [];

  for (const page of pages) {
    const html = fs.readFileSync(path.join(appDir, page), 'utf8');
    const refs = [...html.matchAll(/<(?:script|link)\b[^>]*(?:src|href)=["']([^"']+)["']/gi)]
      .map(match => match[1])
      .filter(ref => !/^(?:https?:|data:|#)/i.test(ref))
      .map(ref => ref.split(/[?#]/, 1)[0]);
    for (const ref of refs) {
      if (!fs.existsSync(path.resolve(appDir, ref))) missing.push(`${page} -> ${ref}`);
    }
  }

  assert.deepEqual(missing, []);
});

test('browser dependencies are pinned to reproducible versions', () => {
  const html = fs.readdirSync(appDir)
    .filter(name => name.endsWith('.html'))
    .map(name => fs.readFileSync(path.join(appDir, name), 'utf8'))
    .join('\n');
  assert.doesNotMatch(html, /@supabase\/supabase-js@2(?:["/])/);
  assert.doesNotMatch(html, /tesseract\.js@5(?:["/])/);
  assert.match(html, /@supabase\/supabase-js@2\.114\.0/);
  assert.match(html, /tesseract\.js@5\.1\.1/);
});

test('service worker only precaches files shipped by GitHub Pages', () => {
  const worker = read('pub_guru/sw.js');
  const shell = [...worker.matchAll(/["']\.\/([^"']*)["']/g)].map(match => match[1]).filter(Boolean);
  const missing = shell.filter(file => !fs.existsSync(path.join(appDir, file)));
  assert.deepEqual(missing, []);
  assert.match(worker, /pub-guru-shell-/);
});

test('browser configuration uses the dedicated PUB GURU project and no secret key', () => {
  const config = read('pub_guru/app-config.js');
  assert.match(config, /gnfqlfxuagcgjztaueot\.supabase\.co/);
  assert.match(config, /sb_publishable_/);
  assert.doesNotMatch(config, /service_role|sb_secret_/i);
});

test('database audit and role protections remain in the migration set', () => {
  const sql = fs.readdirSync(path.join(root, 'database'))
    .filter(name => name.endsWith('.sql'))
    .map(name => fs.readFileSync(path.join(root, 'database', name), 'utf8'))
    .join('\n');

  for (const safeguard of [
    'prevent_posted_invoice_mutation',
    'prevent_finalized_closing_mutation',
    'prevent_closed_inventory_mutation',
    'prevent_inventory_line_insert_when_closed',
    'guard_privileged_audit_events',
    'finalize_invoice_from_audit',
    'stock_movements_invoice_line_once_idx',
    'normalize_stock_movement_quantity',
    'products_counted_metadata_check',
    'inventory_lines_measurement_shape_check'
  ]) assert.match(sql, new RegExp(`\\b${safeguard}\\b`));

  assert.match(sql, /revoke update, delete on public\.stock_movements from authenticated/i);
  assert.match(sql, /revoke all on table public\.invoice_capture_jobs from anon/i);
  assert.match(sql, /revoke all on table public\.supplier_product_mappings from anon/i);
  assert.match(sql, /create policy memberships_read_own[\s\S]*auth\.uid\(\)/i);
});

test('counted stock semantics survive the browser-to-database round trip', () => {
  const sync = read('pub_guru/data-sync.js');
  const invoice = read('pub_guru/invoice-backend.js');
  const operations = read('pub_guru/operations-backend.js');
  const sql = read('database/20260904025648_counted_inventory_backend.sql');

  for (const field of ['item_kind', 'item_subtype', 'count_unit']) {
    assert.match(sync, new RegExp(`\\b${field}\\b`));
    assert.match(operations, new RegExp(`\\b${field}\\b`));
    assert.match(invoice, new RegExp(`\\b${field}\\b`));
  }
  for (const field of ['quantity_units', 'requested_quantity_units', 'untracked_units']) {
    assert.match(sync, new RegExp(`\\b${field}\\b`));
    assert.match(sql, new RegExp(`\\b${field}\\b`));
  }
  for (const field of ['expected_units', 'measured_units', 'difference_units']) {
    assert.match(invoice, new RegExp(`\\b${field}\\b`));
    assert.match(sql, new RegExp(`\\b${field}\\b`));
  }

  assert.match(sql, /unit_mode in \('liquid','unit','counted'\)/);
  assert.match(sql, /new\.quantity_units := greatest\(requested_units, -current_units\)/);
  assert.match(sql, /new\.untracked_units := abs\(requested_units - new\.quantity_units\)/);
  assert.match(invoice, /signedQuantity\(row\.qty, row\.unitPrice\)/);
});

test('pull requests run tests but only non-PR workflows deploy', () => {
  const workflow = read('.github/workflows/pub-guru-pages.yml');
  assert.match(workflow, /pull_request:\s*\n\s+branches:\s*\[main\]/);
  assert.match(workflow, /node --test tests\/\*\.test\.js/);
  assert.match(workflow, /if:\s*github\.event_name != 'pull_request'/);
});
