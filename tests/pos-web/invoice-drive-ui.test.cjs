'use strict';
const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const {JSDOM} = require('jsdom');
const ui = fs.readFileSync(path.join(__dirname, '../../pub_guru/invoice-drive.js'), 'utf8');

async function dom(role = 'owner', summary = {}) {
  const window = new JSDOM('<html><body><section id="invoiceQueue"></section></body></html>', {
    url: 'https://fixture.test/pub_guru/invoice-capture.html?driveFolder=fixtureFolderA1', runScripts: 'outside-only'
  }).window;
  await new Promise(resolve => window.addEventListener('load', resolve));
  const calls = [];
  window.PubGuruBackend = {loadContext: async () => ({role, organization: {id: 'org'}, venue: {id: 'venue', name: 'FIKTIVNÍ BAR'}}),
    client: {rpc: async (name, args) => { calls.push({name, args}); return {data: {sources: [], files: [], ...summary}}; }}};
  window.eval(ui);
  await new Promise(resolve => setTimeout(resolve, 0));
  return {window, calls, close: () => window.close()};
}

test('import and OCR states distinguish duplicates, review, failures and actual posting', async () => {
  const f = await dom();
  try {
    const api = f.window.PubGuruInvoiceDrive;
    assert.equal(api.describe({import_status: 'downloading'}), 'Stahuji a ukládám originál');
    assert.equal(api.describe({import_status: 'queued', ocr_status: 'queued'}), 'Uloženo · čeká na OCR');
    assert.equal(api.describe({import_status: 'queued', ocr_status: 'processing'}), 'Probíhá OCR');
    assert.match(api.describe({import_status: 'duplicate', ocr_status: 'review', invoice_status: 'review'}), /čeká na schválení/);
    assert.equal(api.describe({import_status: 'duplicate', invoice_status: 'posted'}), 'Schváleno');
    assert.equal(api.describe({import_status: 'failed', import_error: 'FIKTIVNÍ CHYBA'}), 'FIKTIVNÍ CHYBA');
    assert.equal(api.describe({import_status: 'queued', ocr_status: 'failed', ocr_error: 'OCR FICTION'}), 'OCR FICTION');
    assert.match(api.connectionState({last_connected_at: '2026-01-01T00:00:00Z'}, Date.parse('2026-01-01T00:30:00Z')), /odmlčela/);
    assert.match(api.connectionState({}), /první propojení/);
  } finally { f.close(); }
});

test('staff get scoped status and safe original links without connection controls or executable filenames', async () => {
  const f = await dom('staff', {sources: [{id: 'source', folder_id: 'fixtureFolderA1'}],
    files: [{file_name: '<img src=x onerror="alert(1)">', drive_file_id: 'fictionPhoto01', import_status: 'queued', ocr_status: 'queued'}]});
  try {
    assert.equal(f.window.document.querySelectorAll('#invoiceDrive details').length, 0);
    assert.equal(f.window.document.querySelectorAll('#invoiceDrive button').length, 0);
    assert.equal(f.window.document.querySelectorAll('#invoiceDrive img').length, 0);
    assert.match(f.window.document.querySelector('#invoiceDrive strong').textContent, /<img/);
    const link = [...f.window.document.querySelectorAll('a')].find(x => x.textContent === 'Soubor v Drive');
    assert.equal(link.href, 'https://drive.google.com/file/d/fictionPhoto01/view');
    assert.ok(link.rel.includes('noopener'));
    assert.deepEqual(JSON.parse(JSON.stringify(f.calls[0].args)), {p_action: 'summary', p_organization_id: 'org', p_venue_id: 'venue', p_source_id: null, p_payload: {}});
  } finally { f.close(); }
});

test('manager setup shows its destination, accepts exact Drive folders and rejects foreign URLs', async () => {
  const f = await dom();
  try {
    assert.ok(f.window.document.querySelector('#invoiceDrive details'));
    assert.match(f.window.document.querySelector('#invoiceDrive').textContent, /Cíl importu: FIKTIVNÍ BAR/);
    assert.equal(f.window.document.querySelector('input').value, 'https://drive.google.com/drive/folders/fixtureFolderA1');
    const parse = f.window.PubGuruInvoiceDrive.folderId;
    assert.equal(parse('https://drive.google.com/drive/folders/fixtureFolderA1?usp=sharing'), 'fixtureFolderA1');
    assert.equal(parse('https://attacker.invalid/drive/folders/fixtureFolderA1'), '');
    assert.equal(parse('https://drive.google.com.attacker.invalid/drive/folders/fixtureFolderA1'), '');
    assert.equal(parse('javascript:alert(1)'), '');
    assert.equal(parse('https://share.icloud.com/photos/fiction'), '');
  } finally { f.close(); }
});

test('private Apps Script installation verifies access before scheduling, preserves unrelated triggers and uses short-lived tokens', () => {
  const script = fs.readFileSync(path.join(__dirname, '../../integrations/google-drive/Code.gs'), 'utf8');
  const properties = {PUB_GURU_ENDPOINT: 'https://fixture.supabase.co/functions/v1/invoice-drive-import',
    PUB_GURU_SOURCE: '10000000-0000-4000-8000-000000000001', PUB_GURU_TOKEN: 'a'.repeat(64)};
  const operations = []; const triggers = [{getHandlerFunction: () => 'otherWorkflow'}, {getHandlerFunction: () => 'syncPubGuru'}];
  const context = {ScriptApp: {
    AuthMode: {FULL: 'full'}, requireScopes: (_mode, scopes) => operations.push({scopes}),
    getProjectTriggers: () => triggers, deleteTrigger: trigger => operations.push({deleted: trigger.getHandlerFunction()}),
    newTrigger: name => ({timeBased: () => ({everyMinutes: minutes => ({create: () => operations.push({schedule: name, minutes})})})}),
    getOAuthToken: () => 'FICTIONAL-SHORT-LIVED-OAUTH'
  }, PropertiesService: {getScriptProperties: () => ({getProperty: name => properties[name]})},
  LockService: {getScriptLock: () => ({tryLock: () => true, releaseLock: () => operations.push({release: true})})},
  UrlFetchApp: {fetch: (url, args) => { operations.push({url, args}); return {getResponseCode: () => 200, getContentText: () => '{"has_more":false}'}; }}, Date};
  vm.createContext(context); vm.runInContext(script, context); context.installPubGuru();
  const requests = operations.filter(x => x.url);
  assert.equal(JSON.parse(requests[0].args.payload).action, 'probe');
  assert.equal(JSON.parse(requests[1].args.payload).action, 'sync');
  assert.equal(requests[0].args.followRedirects, false);
  assert.equal(JSON.parse(requests[0].args.payload).google_token, 'FICTIONAL-SHORT-LIVED-OAUTH');
  assert.equal(requests[0].args.headers.Authorization, 'Bearer ' + properties.PUB_GURU_TOKEN);
  assert.deepEqual(operations.find(x => x.schedule), {schedule: 'syncPubGuru', minutes: 5});
  assert.ok(!operations.some(x => x.deleted === 'otherWorkflow'));
  assert.ok(operations.findIndex(x => x.url) < operations.findIndex(x => x.schedule));
});
