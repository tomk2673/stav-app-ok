'use strict';

const today = () => new Date().toISOString().slice(0, 10);
const num = value => {
  if (typeof value === 'number') return Number.isFinite(value) ? value : 0;
  const parsed = Number(String(value ?? '').replace(/\s/g, '').replace(',', '.'));
  return Number.isFinite(parsed) ? parsed : 0;
};
const money = value => new Intl.NumberFormat('cs-CZ', { style: 'currency', currency: 'CZK', maximumFractionDigits: 2 }).format(num(value));
const esc = value => String(value ?? '').replace(/[&<>'"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' }[c]));

let ctx = null;
let fileFingerprint = null;
let fileName = null;
let parsedSnapshot = null;

function backend() {
  if (!window.PubGuruBackend) throw new Error('Backend PUB GURU není dostupný.');
  return window.PubGuruBackend;
}
function client() { return backend().client; }
function value(id) { return document.getElementById(id).value; }
function setValue(id, v) { document.getElementById(id).value = v ?? ''; }

function toast(message, ms = 3500) {
  const el = document.getElementById('toast');
  el.textContent = message;
  el.classList.remove('hidden');
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => el.classList.add('hidden'), ms);
}

async function ensureContext() {
  ctx = await backend().loadContext();
  if (!ctx?.user || !ctx?.organization || !ctx?.venue) {
    location.replace('start.html');
    return false;
  }
  document.getElementById('backendContext').textContent = `${ctx.organization.name} · ${ctx.venue.name} · ${ctx.user.email || ''}`;
  return true;
}

async function sha256(file) {
  const data = await file.arrayBuffer();
  const hash = await crypto.subtle.digest('SHA-256', data);
  return [...new Uint8Array(hash)].map(b => b.toString(16).padStart(2, '0')).join('');
}

function normalizeOcrText(text) {
  return String(text || '').replace(/\u00a0/g, ' ').replace(/[|]/g, 'I').replace(/\r/g, '').replace(/[ \t]+/g, ' ').trim();
}

function parseMoneyToken(value) {
  if (!value) return null;
  const clean = value.replace(/CZK|Kč|Kc/gi, '').replace(/\s/g, '').replace(/\.(?=\d{3}(?:\D|$))/g, '').replace(',', '.').replace(/[^0-9.-]/g, '');
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
  const match = normalizeOcrText(text).match(/\b([0-3]?\d)[.\/-]([01]?\d)[.\/-](20\d{2}|\d{2})\b/);
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
    businessDate: parseDate(text) || today(), cashAmount: cash, cardAmount: card,
    totalAmount: total ?? ((cash !== null || card !== null) ? num(cash) + num(card) : null),
    transactionCount: tx, refundsAmount: refunds
  };
}

function currentForm() {
  return {
    businessDate: value('businessDate') || today(), sourceType: value('sourceType') || 'terminal',
    cashAmount: num(value('cashAmount')), cardAmount: num(value('cardAmount')), totalAmount: num(value('totalAmount')),
    transactionCount: Math.max(0, Math.round(num(value('transactionCount')))), refundsAmount: num(value('refundsAmount')),
    rawOcrText: value('closingOcrText'), sourceFingerprint: fileFingerprint, sourceFileName: fileName
  };
}

function changedFields(from, to) {
  if (!from) return [];
  return ['businessDate','sourceType','cashAmount','cardAmount','totalAmount','transactionCount','refundsAmount']
    .filter(key => String(from[key] ?? '') !== String(to[key] ?? ''));
}

function applyParsed(parsed) {
  parsedSnapshot = {
    businessDate: parsed.businessDate, sourceType: value('sourceType') || 'terminal',
    cashAmount: num(parsed.cashAmount), cardAmount: num(parsed.cardAmount), totalAmount: num(parsed.totalAmount),
    transactionCount: Math.max(0, Math.round(num(parsed.transactionCount))), refundsAmount: num(parsed.refundsAmount)
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
  const diff = cash + card - total;
  document.getElementById('sumChannels').textContent = money(cash + card);
  const diffEl = document.getElementById('closingDifference');
  diffEl.textContent = `${diff >= 0 ? '+' : ''}${money(diff)}`;
  diffEl.className = Math.abs(diff) <= 1 ? 'positive' : 'negative';
  const check = document.getElementById('closingCheck');
  if (!total && !cash && !card) { check.textContent = 'čekám'; check.className = ''; }
  else if (Math.abs(diff) <= 1) { check.textContent = 'souhlasí'; check.className = 'positive'; }
  else { check.textContent = 'prověřit'; check.className = 'negative'; }
}

async function isDuplicate(fingerprint) {
  if (!fingerprint || !ctx) return null;
  const { data, error } = await client().from('closings')
    .select('id,business_date,total_amount,status')
    .eq('organization_id', ctx.organization.id).eq('venue_id', ctx.venue.id)
    .eq('source_fingerprint', fingerprint).maybeSingle();
  if (error) throw error;
  return data || null;
}

async function recognizeImage(file) {
  if (!window.Tesseract) throw new Error('OCR knihovna se nenačetla.');
  const wrap = document.getElementById('ocrProgressWrap');
  const bar = document.getElementById('ocrProgress');
  const status = document.getElementById('ocrStatus');
  const preview = document.getElementById('closingPreview');
  wrap.classList.remove('hidden'); bar.style.width = '5%'; status.textContent = 'Načítám fotografii…';

  fileFingerprint = await sha256(file); fileName = file.name || 'photo';
  const duplicate = await isDuplicate(fileFingerprint);
  const duplicateBadge = document.getElementById('duplicateBadge');
  if (duplicate) {
    duplicateBadge.textContent = 'duplicitní doklad'; duplicateBadge.className = 'badge danger';
    toast(`Tento doklad už existuje (${duplicate.business_date}).`, 5000);
  } else {
    duplicateBadge.textContent = 'nový doklad'; duplicateBadge.className = 'badge muted';
  }

  const image = new Image();
  const objectUrl = URL.createObjectURL(file); image.src = objectUrl; await image.decode();
  const scale = Math.min(1, 1800 / image.naturalWidth);
  preview.width = Math.round(image.naturalWidth * scale); preview.height = Math.round(image.naturalHeight * scale);
  preview.getContext('2d').drawImage(image, 0, 0, preview.width, preview.height); preview.classList.remove('hidden');
  URL.revokeObjectURL(objectUrl);

  const result = await Tesseract.recognize(preview, 'ces+eng', { logger: msg => {
    if (msg.status === 'recognizing text') {
      const p = Math.round((msg.progress || 0) * 100); bar.style.width = `${Math.max(8, p)}%`; status.textContent = `OCR ${p} %`;
    } else if (msg.status) status.textContent = msg.status;
  }});
  bar.style.width = '100%'; status.textContent = 'OCR dokončeno.';
  const text = normalizeOcrText(result.data.text); setValue('closingOcrText', text); applyParsed(parseClosingText(text));
}

async function writeAudit(eventType, entityId, beforeData = null, afterData = null, reason = null) {
  const { error } = await client().from('audit_events').insert({
    organization_id: ctx.organization.id, venue_id: ctx.venue.id, actor_user_id: ctx.user.id,
    event_type: eventType, entity_type: 'closing', entity_id: entityId,
    before_data: beforeData, after_data: afterData, reason
  });
  if (error) throw error;
}

async function saveClosing(finalize) {
  const form = currentForm();
  if (!form.businessDate) return toast('Chybí datum uzávěrky.');
  if (!form.totalAmount && !form.cashAmount && !form.cardAmount) return toast('Chybí částka uzávěrky.');
  if (form.sourceFingerprint && await isDuplicate(form.sourceFingerprint)) return toast('Tento doklad už je v databázi.', 5000);

  const corrections = changedFields(parsedSnapshot, form);
  const reason = value('correctionReason').trim();
  if (corrections.length && !reason) return toast(`Změnil jsi OCR hodnoty (${corrections.join(', ')}). Doplň důvod opravy.`, 5500);

  const row = {
    organization_id: ctx.organization.id, venue_id: ctx.venue.id, business_date: form.businessDate,
    source_type: form.sourceType, source_fingerprint: form.sourceFingerprint, source_file_name: form.sourceFileName,
    cash_amount: form.cashAmount, card_amount: form.cardAmount, total_amount: form.totalAmount,
    transaction_count: form.transactionCount, refunds_amount: form.refundsAmount, raw_ocr_text: form.rawOcrText,
    extracted_values: parsedSnapshot || {}, status: finalize ? 'finalized' : 'review', created_by: ctx.user.id,
    finalized_at: finalize ? new Date().toISOString() : null, finalized_by: finalize ? ctx.user.id : null
  };

  const { data: closing, error } = await client().from('closings').insert(row).select('id').single();
  if (error) throw error;

  for (const field of corrections) {
    const { error: correctionError } = await client().from('closing_corrections').insert({
      closing_id: closing.id, organization_id: ctx.organization.id, field_name: field,
      original_value: { value: parsedSnapshot?.[field] ?? null }, corrected_value: { value: form[field] },
      reason, created_by: ctx.user.id
    });
    if (correctionError) throw correctionError;
    await writeAudit('closing.corrected_from_ocr', closing.id, { [field]: parsedSnapshot?.[field] ?? null }, { [field]: form[field] }, reason);
  }

  await writeAudit(finalize ? 'closing.finalized' : 'closing.saved', closing.id, null, row, corrections.length ? reason : null);
  await Promise.all([renderClosings(), renderAudit()]);
  clearForm(false);
  toast(finalize ? 'Uzávěrka je v databázi uzavřená a zamčená.' : 'Koncept uzávěrky uložen do databáze.');
}

function clearForm(clearFile = true) {
  ['cashAmount','cardAmount','totalAmount','transactionCount','refundsAmount','correctionReason','closingOcrText'].forEach(id => setValue(id, ''));
  setValue('businessDate', today());
  if (clearFile) document.getElementById('closingFile').value = '';
  parsedSnapshot = null; fileFingerprint = null; fileName = null;
  document.getElementById('closingPreview').classList.add('hidden');
  document.getElementById('ocrProgressWrap').classList.add('hidden');
  document.getElementById('duplicateBadge').textContent = 'nový doklad'; document.getElementById('duplicateBadge').className = 'badge muted';
  updateCheck();
}

async function renderClosings() {
  const { data, error } = await client().from('closings')
    .select('id,business_date,source_type,source_file_name,transaction_count,total_amount,status,created_at')
    .eq('organization_id', ctx.organization.id).eq('venue_id', ctx.venue.id)
    .order('business_date', { ascending: false }).order('created_at', { ascending: false }).limit(30);
  if (error) throw error;
  document.getElementById('closingCount').textContent = String(data?.length || 0);
  document.getElementById('closingsList').innerHTML = data?.length ? data.map(c => `
    <div class="closing-row"><div><strong>${esc(c.business_date)}</strong><small>${esc(c.source_type)} · ${esc(c.source_file_name || 'bez souboru')} · ${c.transaction_count || 0} transakcí</small></div><div style="text-align:right"><strong>${money(c.total_amount)}</strong><small class="status-${esc(c.status)}">${c.status === 'finalized' ? 'zamčeno' : 'ke kontrole'}</small></div></div>`).join('') : '<div class="empty-state">Zatím žádná uzávěrka.</div>';
}

async function renderAudit() {
  const { data, error } = await client().from('audit_events')
    .select('event_type,reason,created_at,entity_id')
    .eq('organization_id', ctx.organization.id).eq('venue_id', ctx.venue.id).eq('entity_type', 'closing')
    .order('created_at', { ascending: false }).limit(40);
  if (error) throw error;
  document.getElementById('auditList').innerHTML = data?.length ? data.map(a => `
    <div class="audit-row"><strong>${esc(a.event_type)}</strong><br><time>${new Date(a.created_at).toLocaleString('cs-CZ')}</time>${a.reason ? `<br><span>Důvod: ${esc(a.reason)}</span>` : ''}</div>`).join('') : '<div class="empty-state">Audit je zatím prázdný.</div>';
}

async function init() {
  try {
    if (!await ensureContext()) return;
    setValue('businessDate', today());
    ['cashAmount','cardAmount','totalAmount','transactionCount','refundsAmount'].forEach(id => document.getElementById(id).addEventListener('input', updateCheck));
    document.getElementById('closingFile').addEventListener('change', async event => {
      const file = event.target.files?.[0]; if (!file) return;
      try { await recognizeImage(file); toast('Uzávěrka načtena. Zkontroluj hodnoty.'); }
      catch (error) { console.error(error); toast(`OCR se nepodařilo: ${error.message}`, 5500); }
    });
    document.getElementById('parseClosingBtn').addEventListener('click', () => applyParsed(parseClosingText(value('closingOcrText'))));
    document.getElementById('clearClosingBtn').addEventListener('click', () => clearForm(true));
    document.getElementById('saveClosingDraftBtn').addEventListener('click', async () => { try { await saveClosing(false); } catch (e) { console.error(e); toast(`Uložení selhalo: ${e.message}`, 6000); } });
    document.getElementById('finalizeClosingBtn').addEventListener('click', async () => { try { await saveClosing(true); } catch (e) { console.error(e); toast(`Uzavření selhalo: ${e.message}`, 6000); } });
    await Promise.all([renderClosings(), renderAudit()]); updateCheck();
  } catch (error) {
    console.error(error); toast(`Backend není připraven: ${error.message}`, 7000);
  }
}

document.addEventListener('DOMContentLoaded', init);
