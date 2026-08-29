'use strict';

const CLOSINGS_KEY = 'pub_guru_closings_v1';
const AUDIT_KEY = 'pub_guru_audit_v1';
const today = () => new Date().toISOString().slice(0, 10);
const uid = prefix => `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
const num = value => {
  if (typeof value === 'number') return Number.isFinite(value) ? value : 0;
  const parsed = Number(String(value ?? '').replace(/\s/g, '').replace(',', '.'));
  return Number.isFinite(parsed) ? parsed : 0;
};
const money = value => new Intl.NumberFormat('cs-CZ', { style: 'currency', currency: 'CZK', maximumFractionDigits: 2 }).format(num(value));
const esc = value => String(value ?? '').replace(/[&<>'"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' }[c]));

let fileFingerprint = null;
let fileName = null;
let parsedSnapshot = null;

function loadJson(key, fallback) {
  try { return JSON.parse(localStorage.getItem(key)) ?? fallback; } catch { return fallback; }
}
function saveJson(key, value) { localStorage.setItem(key, JSON.stringify(value)); }
function closings() { return loadJson(CLOSINGS_KEY, []); }
function audits() { return loadJson(AUDIT_KEY, []); }

function toast(message, ms = 3500) {
  const el = document.getElementById('toast');
  el.textContent = message;
  el.classList.remove('hidden');
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => el.classList.add('hidden'), ms);
}

function writeAudit(eventType, entityId, beforeData = null, afterData = null, reason = null) {
  const list = audits();
  list.unshift({ id: uid('audit'), eventType, entityType: 'closing', entityId, beforeData, afterData, reason, createdAt: new Date().toISOString() });
  saveJson(AUDIT_KEY, list.slice(0, 500));
  renderAudit();
}

async function sha256(file) {
  const data = await file.arrayBuffer();
  const hash = await crypto.subtle.digest('SHA-256', data);
  return [...new Uint8Array(hash)].map(b => b.toString(16).padStart(2, '0')).join('');
}

function normalizeOcrText(text) {
  return String(text || '')
    .replace(/\u00a0/g, ' ')
    .replace(/[|]/g, 'I')
    .replace(/\r/g, '')
    .replace(/[ \t]+/g, ' ')
    .trim();
}

function parseMoneyToken(value) {
  if (!value) return null;
  const clean = value
    .replace(/CZK|Kč|Kc/gi, '')
    .replace(/\s/g, '')
    .replace(/\.(?=\d{3}(?:\D|$))/g, '')
    .replace(',', '.')
    .replace(/[^0-9.-]/g, '');
  const parsed = Number(clean);
  return Number.isFinite(parsed) ? parsed : null;
}

function findAmount(text, labels) {
  const lines = normalizeOcrText(text).split('\n').map(l => l.trim()).filter(Boolean);
  for (const line of lines) {
    const lower = line.toLowerCase();
    if (!labels.some(label => lower.includes(label))) continue;
    const matches = line.match(/-?\d{1,3}(?:[ .]\d{3})*(?:[,.]\d{2})|-?\d+(?:[,.]\d{2})?/g);
    if (!matches?.length) continue;
    const candidate = parseMoneyToken(matches[matches.length - 1]);
    if (candidate !== null) return candidate;
  }
  return null;
}

function findInteger(text, labels) {
  const lines = normalizeOcrText(text).split('\n').map(l => l.trim()).filter(Boolean);
  for (const line of lines) {
    const lower = line.toLowerCase();
    if (!labels.some(label => lower.includes(label))) continue;
    const numbers = line.match(/\d+/g);
    if (numbers?.length) return Number(numbers[numbers.length - 1]);
  }
  return null;
}

function parseDate(text) {
  const normalized = normalizeOcrText(text);
  const match = normalized.match(/\b([0-3]?\d)[.\/-]([01]?\d)[.\/-](20\d{2}|\d{2})\b/);
  if (!match) return null;
  const year = match[3].length === 2 ? `20${match[3]}` : match[3];
  return `${year}-${String(match[2]).padStart(2, '0')}-${String(match[1]).padStart(2, '0')}`;
}

function parseClosingText(text) {
  const cash = findAmount(text, ['hotovost', 'cash', 'cash total']);
  const card = findAmount(text, ['karta', 'karty', 'card', 'visa', 'mastercard']);
  const total = findAmount(text, ['celkem', 'total', 'grand total', 'obrat', 'tržba', 'trzba']);
  const refunds = findAmount(text, ['storno', 'storna', 'refund', 'vráceno', 'vraceno']);
  const tx = findInteger(text, ['transakc', 'transaction', 'počet', 'pocet']);
  return {
    businessDate: parseDate(text) || today(),
    cashAmount: cash,
    cardAmount: card,
    totalAmount: total ?? ((cash !== null || card !== null) ? num(cash) + num(card) : null),
    transactionCount: tx,
    refundsAmount: refunds
  };
}

function value(id) { return document.getElementById(id).value; }
function setValue(id, v) { document.getElementById(id).value = v ?? ''; }

function currentForm() {
  return {
    businessDate: value('businessDate') || today(),
    sourceType: value('sourceType') || 'terminal',
    cashAmount: num(value('cashAmount')),
    cardAmount: num(value('cardAmount')),
    totalAmount: num(value('totalAmount')),
    transactionCount: Math.max(0, Math.round(num(value('transactionCount')))),
    refundsAmount: num(value('refundsAmount')),
    rawOcrText: value('closingOcrText'),
    sourceFingerprint: fileFingerprint,
    sourceFileName: fileName
  };
}

function changedFields(from, to) {
  if (!from) return [];
  const keys = ['businessDate','sourceType','cashAmount','cardAmount','totalAmount','transactionCount','refundsAmount'];
  return keys.filter(key => String(from[key] ?? '') !== String(to[key] ?? ''));
}

function applyParsed(parsed) {
  parsedSnapshot = {
    businessDate: parsed.businessDate,
    sourceType: value('sourceType') || 'terminal',
    cashAmount: num(parsed.cashAmount),
    cardAmount: num(parsed.cardAmount),
    totalAmount: num(parsed.totalAmount),
    transactionCount: Math.max(0, Math.round(num(parsed.transactionCount))),
    refundsAmount: num(parsed.refundsAmount)
  };
  setValue('businessDate', parsed.businessDate || today());
  if (parsed.cashAmount !== null) setValue('cashAmount', parsed.cashAmount);
  if (parsed.cardAmount !== null) setValue('cardAmount', parsed.cardAmount);
  if (parsed.totalAmount !== null) setValue('totalAmount', parsed.totalAmount);
  if (parsed.transactionCount !== null) setValue('transactionCount', parsed.transactionCount);
  if (parsed.refundsAmount !== null) setValue('refundsAmount', parsed.refundsAmount);
  updateCheck();
}

function updateCheck() {
  const cash = num(value('cashAmount'));
  const card = num(value('cardAmount'));
  const total = num(value('totalAmount'));
  const channels = cash + card;
  const diff = channels - total;
  document.getElementById('sumChannels').textContent = money(channels);
  const diffEl = document.getElementById('closingDifference');
  diffEl.textContent = `${diff >= 0 ? '+' : ''}${money(diff)}`;
  diffEl.className = Math.abs(diff) <= 1 ? 'positive' : 'negative';
  const check = document.getElementById('closingCheck');
  if (!total && !channels) { check.textContent = 'čekám'; check.className = ''; }
  else if (Math.abs(diff) <= 1) { check.textContent = 'souhlasí'; check.className = 'positive'; }
  else { check.textContent = 'prověřit'; check.className = 'negative'; }
}

async function recognizeImage(file) {
  if (!window.Tesseract) throw new Error('OCR knihovna se nenačetla.');
  const wrap = document.getElementById('ocrProgressWrap');
  const bar = document.getElementById('ocrProgress');
  const status = document.getElementById('ocrStatus');
  const preview = document.getElementById('closingPreview');
  wrap.classList.remove('hidden');
  bar.style.width = '5%';
  status.textContent = 'Načítám fotografii…';

  fileFingerprint = await sha256(file);
  fileName = file.name || 'photo';
  const duplicate = closings().find(c => c.sourceFingerprint && c.sourceFingerprint === fileFingerprint);
  const duplicateBadge = document.getElementById('duplicateBadge');
  if (duplicate) {
    duplicateBadge.textContent = 'duplicitní doklad';
    duplicateBadge.className = 'badge danger';
    toast('Tento soubor už byl uložen. Nebudu vytvářet duplicitu.', 5000);
  } else {
    duplicateBadge.textContent = 'nový doklad';
    duplicateBadge.className = 'badge muted';
  }

  const image = new Image();
  const objectUrl = URL.createObjectURL(file);
  image.src = objectUrl;
  await image.decode();
  const maxWidth = 1800;
  const scale = Math.min(1, maxWidth / image.naturalWidth);
  preview.width = Math.round(image.naturalWidth * scale);
  preview.height = Math.round(image.naturalHeight * scale);
  preview.getContext('2d').drawImage(image, 0, 0, preview.width, preview.height);
  preview.classList.remove('hidden');
  URL.revokeObjectURL(objectUrl);

  const result = await Tesseract.recognize(preview, 'ces+eng', {
    logger: msg => {
      if (msg.status === 'recognizing text') {
        const p = Math.round((msg.progress || 0) * 100);
        bar.style.width = `${Math.max(8, p)}%`;
        status.textContent = `OCR ${p} %`;
      } else if (msg.status) status.textContent = msg.status;
    }
  });
  bar.style.width = '100%';
  status.textContent = 'OCR dokončeno.';
  const text = normalizeOcrText(result.data.text);
  setValue('closingOcrText', text);
  applyParsed(parseClosingText(text));
}

function saveClosing(finalize) {
  const form = currentForm();
  if (!form.businessDate) return toast('Chybí datum uzávěrky.');
  if (!form.totalAmount && !form.cashAmount && !form.cardAmount) return toast('Chybí částka uzávěrky.');
  const existingDuplicate = closings().find(c => form.sourceFingerprint && c.sourceFingerprint === form.sourceFingerprint);
  if (existingDuplicate) return toast(`Doklad už existuje: ${existingDuplicate.businessDate}.`, 5000);

  const corrections = changedFields(parsedSnapshot, form);
  const reason = value('correctionReason').trim();
  if (corrections.length && !reason) return toast(`Změnil jsi OCR hodnoty (${corrections.join(', ')}). Doplň důvod opravy.`, 5500);

  const record = {
    id: uid('closing'),
    ...form,
    extractedValues: parsedSnapshot ? { ...parsedSnapshot } : null,
    status: finalize ? 'finalized' : 'review',
    createdAt: new Date().toISOString(),
    finalizedAt: finalize ? new Date().toISOString() : null,
    corrections: corrections.map(field => ({ field, originalValue: parsedSnapshot?.[field] ?? null, correctedValue: form[field], reason, createdAt: new Date().toISOString() }))
  };

  const list = closings();
  list.unshift(record);
  saveJson(CLOSINGS_KEY, list);
  writeAudit(finalize ? 'closing.finalized' : 'closing.saved', record.id, null, record, corrections.length ? reason : null);
  record.corrections.forEach(c => writeAudit('closing.corrected_from_ocr', record.id, { [c.field]: c.originalValue }, { [c.field]: c.correctedValue }, c.reason));
  renderClosings();
  clearForm(false);
  toast(finalize ? 'Uzávěrka je uzavřená a zamčená.' : 'Koncept uzávěrky uložen.');
}

function clearForm(clearFile = true) {
  ['cashAmount','cardAmount','totalAmount','transactionCount','refundsAmount','correctionReason','closingOcrText'].forEach(id => setValue(id, ''));
  setValue('businessDate', today());
  if (clearFile) document.getElementById('closingFile').value = '';
  parsedSnapshot = null;
  fileFingerprint = null;
  fileName = null;
  document.getElementById('closingPreview').classList.add('hidden');
  document.getElementById('ocrProgressWrap').classList.add('hidden');
  document.getElementById('duplicateBadge').textContent = 'nový doklad';
  document.getElementById('duplicateBadge').className = 'badge muted';
  updateCheck();
}

function renderClosings() {
  const list = closings();
  document.getElementById('closingCount').textContent = String(list.length);
  document.getElementById('closingsList').innerHTML = list.length ? list.slice(0, 30).map(c => `
    <div class="closing-row">
      <div><strong>${esc(c.businessDate)}</strong><small>${esc(c.sourceType)} · ${esc(c.sourceFileName || 'bez souboru')} · ${c.transactionCount || 0} transakcí</small></div>
      <div style="text-align:right"><strong>${money(c.totalAmount)}</strong><small class="status-${esc(c.status)}">${c.status === 'finalized' ? 'zamčeno' : 'ke kontrole'}</small></div>
    </div>`).join('') : '<div class="empty-state">Zatím žádná uzávěrka.</div>';
}

function renderAudit() {
  const list = audits().filter(a => a.entityType === 'closing').slice(0, 40);
  document.getElementById('auditList').innerHTML = list.length ? list.map(a => `
    <div class="audit-row"><strong>${esc(a.eventType)}</strong><br><time>${new Date(a.createdAt).toLocaleString('cs-CZ')}</time>${a.reason ? `<br><span>Důvod: ${esc(a.reason)}</span>` : ''}</div>`).join('') : '<div class="empty-state">Audit je zatím prázdný.</div>';
}

function init() {
  setValue('businessDate', today());
  ['cashAmount','cardAmount','totalAmount','transactionCount','refundsAmount'].forEach(id => document.getElementById(id).addEventListener('input', updateCheck));
  document.getElementById('closingFile').addEventListener('change', async event => {
    const file = event.target.files?.[0];
    if (!file) return;
    try { await recognizeImage(file); toast('Uzávěrka načtena. Zkontroluj hodnoty.'); }
    catch (error) { console.error(error); toast(`OCR se nepodařilo: ${error.message}`, 5500); }
  });
  document.getElementById('parseClosingBtn').addEventListener('click', () => applyParsed(parseClosingText(value('closingOcrText'))));
  document.getElementById('clearClosingBtn').addEventListener('click', () => clearForm(true));
  document.getElementById('saveClosingDraftBtn').addEventListener('click', () => saveClosing(false));
  document.getElementById('finalizeClosingBtn').addEventListener('click', () => saveClosing(true));
  renderClosings();
  renderAudit();
  updateCheck();
}

document.addEventListener('DOMContentLoaded', init);
