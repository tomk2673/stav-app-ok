'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const root = path.resolve(__dirname, '../..');
const edge = fs.readFileSync(path.join(root,'supabase/functions/iphone-invoice-ingest/index.ts'),'utf8');
const capture = fs.readFileSync(path.join(root,'pub_guru/invoice-capture-v3.js'),'utf8');
const migration = fs.readFileSync(path.join(root,'database/20261103_iphone_invoice_ocr.sql'),'utf8');
test('iPhone intake requires user JWT and checks org and venue',()=>{
  assert.match(edge,/db\.auth\.getUser\(/);
  assert.match(edge,/from\("memberships"\)/);
  assert.match(edge,/from\("venues"\)/);
  assert.doesNotMatch(edge,/SERVICE_ROLE_KEY/);
});
test('iPhone intake checks image signature, size and duplicate fingerprint',()=>{
  assert.match(edge,/MAX_IMAGE_BYTES/);
  assert.match(edge,/unsupported_image/);
  assert.match(edge,/SHA-256/);
  assert.match(edge,/source_fingerprint/);
});
test('Apple OCR is used by existing invoice parser and retains review',()=>{
  assert.match(capture,/job\?\.apple_ocr_text/);
  assert.match(capture,/provider:'apple-shortcuts-ocr'/);
  assert.match(capture,/parseText\(\)/);
  assert.match(capture,/status:'review'/);
  assert.match(migration,/apple_ocr_text text/);
});
