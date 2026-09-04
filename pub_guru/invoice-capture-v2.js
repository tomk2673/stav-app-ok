'use strict';

(function () {
  let ctx = null;
  let products = [];
  let rows = [];
  let fingerprint = null;
  let sourceFileName = null;
  let documentTotal = null;
  let cropMeta = null;

  const $ = id => document.getElementById(id);
  const db = () => window.PubGuruBackend.client;
  const n = v => {
    const x = Number(String(v ?? '').replace(/\s/g, '').replace(',', '.'));
    return Number.isFinite(x) ? x : 0;
  };
  const esc = v => String(v ?? '').replace(/[&<>'"]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;',"'":'&#39;','"':'&quot;'}[c]));
  const today = () => new Date().toISOString().slice(0, 10);
  const uid = () => `line_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}`;

  function toast(message, ms = 4500) {
    const el = $('toast');
    el.textContent = message;
    el.classList.remove('hidden');
    clearTimeout(toast.t);
    toast.t = setTimeout(() => el.classList.add('hidden'), ms);
  }

  async function sha256(file) {
    const hash = await crypto.subtle.digest('SHA-256', await file.arrayBuffer());
    return [...new Uint8Array(hash)].map(b => b.toString(16).padStart(2, '0')).join('');
  }

  function normalizeWords(text) {
    return String(text || '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[^a-z0-9 ]/g, ' ').split(/\s+/).filter(w => w.length > 1);
  }

  function similarity(a, b) {
    const A = new Set(normalizeWords(a));
    const B = new Set(normalizeWords(b));
    if (!A.size || !B.size) return 0;
    return [...A].filter(w => B.has(w)).length / Math.max(A.size, B.size);
  }

  function bestProductMatch(text) {
    let best = null;
    let score = 0;
    for (const p of products) {
      const s = Math.max(similarity(text, p.name), ...(p.aliases || []).map(a => similarity(text, a)));
      if (s > score) { score = s; best = p; }
    }
    return score >= 0.38 ? best : null;
  }

  function productOptions(selected = '') {
    return '<option value="">Bez párování</option>' + products.map(p => `<option value="${p.id}" ${p.id === selected ? 'selected' : ''}>${esc(p.name)}${p.ean ? ` · ${esc(p.ean)}` : ''}${p.volume_ml ? ` · ${n(p.volume_ml)} ml` : ''}</option>`).join('');
  }

  function render() {
    $('lineCount').textContent = String(rows.length);
    $('lines').innerHTML = rows.length ? rows.map((r, i) => `<div class="line" data-i="${i}"><label class="raw">Text z faktury<input class="rawName" value="${esc(r.rawName)}" /></label><label class="product">Produkt<select class="productId">${productOptions(r.productId)}</select></label><label>Ks<input class="qty" type="number" step="0.01" value="${Number.isFinite(r.qty) ? r.qty : ''}" /></label><label>Cena/ks<input class="price" type="number" min="0" step="0.01" value="${Number.isFinite(r.price) ? r.price : ''}" /></label><button class="icon-btn remove" title="Odstranit">×</button></div>`).join('') : '<div class="mutedbox">OCR zatím nenašlo položky. Můžeš je přidat ručně.</div>';

    document.querySelectorAll('.line').forEach(el => {
      const i = Number(el.dataset.i);
      el.querySelector('.rawName').oninput = e => rows[i].rawName = e.target.value;
      el.querySelector('.productId').onchange = e => rows[i].productId = e.target.value;
      el.querySelector('.qty').oninput = e => rows[i].qty = n(e.target.value);
      el.querySelector('.price').oninput = e => rows[i].price = n(e.target.value);
      el.querySelector('.remove').onclick = () => { rows.splice(i, 1); render(); };
    });
  }

  function parseDate(text) {
    const m = String(text || '').match(/(?:datum vystavení|datum vystaveni|datum uzp|vystaveno|datum)\s*[:\-]?\s*(\d{1,2}[.\/-]\d{1,2}[.\/-]\d{2,4})/i);
    if (!m) return null;
    const p = m[1].split(/[.\/-]/).map(Number);
    const y = p[2] < 100 ? 2000 + p[2] : p[2];
    return `${y}-${String(p[1]).padStart(2, '0')}-${String(p[0]).padStart(2, '0')}`;
  }

  function parseMoneyToken(v) {
    return n(String(v || '').replace(/[^0-9,.-]/g, ''));
  }

  function parseSupplier(text) {
    const lines = String(text || '').split(/\r?\n/).map(x => x.replace(/\s+/g, ' ').trim()).filter(Boolean);
    for (let i = 0; i < lines.length; i++) {
      if (/^dodavatel\s*:?$/i.test(lines[i]) || /dodavatel\s*:/i.test(lines[i])) {
        const inline = lines[i].replace(/^.*?dodavatel\s*:\s*/i, '').trim();
        if (inline) return inline;
        for (let j = i + 1; j < Math.min(lines.length, i + 4); j++) {
          if (!/^(ičo|ico|dič|dic|dodaci|datum|stolář|stolar|688\b)/i.test(lines[j])) return lines[j];
        }
      }
    }
    return '';
  }

  function parsePrintedTotal(text) {
    const matches = [...String(text || '').matchAll(/(?:celkem\s*(?:\[?czk\]?)?\s*:?)[^\d-]*(-?\d[\d\s.]*[,.]\d{2})/ig)];
    if (!matches.length) return null;
    return parseMoneyToken(matches[matches.length - 1][1]);
  }

  function parseRojalRows(text) {
    const lines = String(text || '').split(/\r?\n/).map(x => x.replace(/[|]/g, ' ').replace(/\s+/g, ' ').trim()).filter(Boolean);
    const out = [];
    let current = null;
    let stopped = false;

    const flush = () => {
      if (!current || !current.name || current.qty == null || current.price == null) { current = null; return; }
      const raw = current.name.replace(/\s+/g, ' ').trim();
      const p = bestProductMatch(raw);
      out.push({ id: uid(), rawName: raw, productId: p?.id || '', qty: current.qty, price: current.price, sourceCode: current.code || '', lineTotal: current.lineTotal ?? null });
      current = null;
    };

    for (const line of lines) {
      if (/^da[nň]\s*%\s+netto|^netto\s+dph|^celkem\s*\[?czk\]?/i.test(line)) { flush(); stopped = true; }
      if (stopped) continue;

      const item = line.match(/^([A-Z0-9]{2,4}-[A-Z0-9]{1,6})\s+(.+)$/i);
      if (item) {
        flush();
        current = { code: item[1], name: item[2], qty: null, price: null, lineTotal: null };
        continue;
      }

      if (!current) continue;

      const data = line.match(/^(\d{1,2})\s*%\s+(-?\d+(?:[,.]\d+)?)\s*(KS|KUS|BAL|L|LAH|LÁH|BTL)?\s+(-?\d[\d\s.]*[,.]\d{2})(?:\s+(-?\d[\d\s.]*[,.]\d{2}))?$/i);
      if (data) {
        current.qty = parseMoneyToken(data[2]);
        current.price = Math.abs(parseMoneyToken(data[4]));
        current.lineTotal = data[5] ? parseMoneyToken(data[5]) : current.qty * current.price;
        flush();
        continue;
      }

      const looseData = line.match(/^(\d{1,2})\s*%\s+(.+)$/i);
      if (looseData) {
        const nums = [...looseData[2].matchAll(/-?\d+(?:[\s.]\d{3})*(?:[,.]\d{1,2})?/g)].map(m => parseMoneyToken(m[0]));
        if (nums.length >= 2) {
          current.qty = nums[0];
          current.price = Math.abs(nums[1]);
          current.lineTotal = nums.length >= 3 ? nums[nums.length - 1] : current.qty * current.price;
          flush();
          continue;
        }
      }

      if (!/^\d+\s*%$/.test(line) && !/^(brutto|množství|mnozstvi|da[nň]|id zboží|id zbozi)/i.test(line)) {
        current.name += ` ${line}`;
      }
    }
    flush();

    const seen = new Set();
    return out.filter(r => {
      const key = `${r.sourceCode}|${normalizeWords(r.rawName).join(' ')}|${r.qty}|${r.price}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  }

  function parseGenericRows(text) {
    const ignored = /(celkem|dph|základ|zaklad|splatnost|odběratel|dodavatel|ičo|ico|dic|bankovní|variabilní|faktura|stvrzenka|číslo dokladu|cislo dokladu)/i;
    const found = [];
    for (const line of String(text || '').split(/\r?\n/).map(x => x.replace(/\s+/g, ' ').trim()).filter(Boolean)) {
      if (line.length < 5 || ignored.test(line) || !/[A-Za-zÁ-ž]/.test(line)) continue;
      const nums = [...line.matchAll(/-?\d+(?:[ .]\d{3})*(?:[,.]\d{1,2})?/g)];
      if (!nums.length) continue;
      const qtyUnit = line.match(/(-?\d+(?:[,.]\d+)?)\s*(ks|kus|bal|kart|láh|lah|btl)\b/i);
      const qty = qtyUnit ? n(qtyUnit[1]) : 1;
      const price = Math.abs(n(nums[nums.length - 1][0]));
      const idx = nums[0].index ?? line.length;
      const raw = line.slice(0, idx).replace(/[|;:]+$/g, '').trim();
      if (raw.length < 3) continue;
      const p = bestProductMatch(raw);
      found.push({ id: uid(), rawName: raw, productId: p?.id || '', qty, price });
    }
    return found.slice(0, 80);
  }

  function parseText() {
    const text = $('ocrText').value || '';
    if (!text.trim()) return toast('Nejdřív načti fakturu.');

    const supplier = parseSupplier(text);
    if (supplier) $('supplier').value = supplier;

    const invoiceNo = text.match(/(?:číslo dokladu|cislo dokladu|faktura|daňový doklad|danovy doklad|doklad)\s*(?:č\.?|c\.?|číslo|cislo|no\.?|#)?\s*[:\-]?\s*([A-Z0-9\-/]{4,})/i);
    if (invoiceNo) $('number').value = invoiceNo[1];

    const d = parseDate(text);
    if (d) $('date').value = d;

    documentTotal = parsePrintedTotal(text);
    const rojal = /ROJAL|PRODEJ NA STVRZENKU|ID ZBOŽ[IÍ]/i.test(text);
    const parsed = rojal ? parseRojalRows(text) : [];
    rows = (parsed.length >= 2 ? parsed : parseGenericRows(text)).slice(0, 80);
    render();

    if (rows.length) {
      toast(`${rojal ? 'ROJAL: ' : ''}nalezeno ${rows.length} položek${documentTotal != null ? ` · celkem ${documentTotal.toLocaleString('cs-CZ')} Kč` : ''}. Zkontroluj je.`);
    } else {
      toast('Položky se nepodařilo bezpečně rozdělit. Doklad zůstává k ruční kontrole.');
    }
  }

  function findLargestRun(flags) {
    let bestStart = -1, bestEnd = -1, start = -1;
    for (let i = 0; i <= flags.length; i++) {
      if (i < flags.length && flags[i]) {
        if (start < 0) start = i;
      } else if (start >= 0) {
        if (bestStart < 0 || i - start > bestEnd - bestStart) { bestStart = start; bestEnd = i - 1; }
        start = -1;
      }
    }
    return bestStart < 0 ? null : [bestStart, bestEnd];
  }

  function detectReceiptBounds(image) {
    const maxW = 520;
    const scale = Math.min(1, maxW / image.naturalWidth);
    const w = Math.max(1, Math.round(image.naturalWidth * scale));
    const h = Math.max(1, Math.round(image.naturalHeight * scale));
    const c = document.createElement('canvas');
    c.width = w; c.height = h;
    const g = c.getContext('2d', { willReadFrequently: true });
    g.drawImage(image, 0, 0, w, h);
    const data = g.getImageData(0, 0, w, h).data;
    const col = new Uint32Array(w);

    for (let y = 0; y < h; y += 2) {
      for (let x = 0; x < w; x += 2) {
        const i = (y * w + x) * 4;
        const r = data[i], gg = data[i + 1], b = data[i + 2];
        const mx = Math.max(r, gg, b), mn = Math.min(r, gg, b), avg = (r + gg + b) / 3;
        if (avg > 105 && mx - mn < 48) col[x]++;
      }
    }

    const xFlags = Array.from(col, v => v > h * 0.055);
    const xr = findLargestRun(xFlags);
    if (!xr || xr[1] - xr[0] < w * 0.12) return { x: 0, y: 0, width: image.naturalWidth, height: image.naturalHeight, detected: false };

    const x1 = Math.max(0, xr[0] - Math.round(w * 0.02));
    const x2 = Math.min(w - 1, xr[1] + Math.round(w * 0.02));
    const row2 = new Uint32Array(h);
    for (let y = 0; y < h; y += 2) {
      let count = 0;
      for (let x = x1; x <= x2; x += 2) {
        const i = (y * w + x) * 4;
        const r = data[i], gg = data[i + 1], b = data[i + 2];
        const mx = Math.max(r, gg, b), mn = Math.min(r, gg, b), avg = (r + gg + b) / 3;
        if (avg > 105 && mx - mn < 48) count++;
      }
      row2[y] = count;
    }
    const yFlags = Array.from(row2, v => v > (x2 - x1) * 0.10);
    const yr = findLargestRun(yFlags);
    if (!yr || yr[1] - yr[0] < h * 0.22) return { x: 0, y: 0, width: image.naturalWidth, height: image.naturalHeight, detected: false };

    const marginX = Math.round((xr[1] - xr[0]) * 0.06);
    const marginY = Math.round((yr[1] - yr[0]) * 0.025);
    const sx = Math.max(0, xr[0] - marginX);
    const sy = Math.max(0, yr[0] - marginY);
    const ex = Math.min(w - 1, xr[1] + marginX);
    const ey = Math.min(h - 1, yr[1] + marginY);
    return {
      x: Math.round(sx / scale), y: Math.round(sy / scale),
      width: Math.round((ex - sx + 1) / scale), height: Math.round((ey - sy + 1) / scale), detected: true
    };
  }

  function autoContrast(canvas) {
    const g = canvas.getContext('2d', { willReadFrequently: true });
    const img = g.getImageData(0, 0, canvas.width, canvas.height);
    const hist = new Uint32Array(256);
    for (let i = 0; i < img.data.length; i += 16) {
      const gray = Math.round(img.data[i] * 0.299 + img.data[i + 1] * 0.587 + img.data[i + 2] * 0.114);
      hist[gray]++;
    }
    const total = hist.reduce((a, b) => a + b, 0);
    const lowTarget = total * 0.03, highTarget = total * 0.985;
    let sum = 0, lo = 0, hi = 255;
    for (let i = 0; i < 256; i++) { sum += hist[i]; if (sum >= lowTarget) { lo = i; break; } }
    sum = 0;
    for (let i = 0; i < 256; i++) { sum += hist[i]; if (sum >= highTarget) { hi = i; break; } }
    if (hi - lo < 60) { lo = Math.max(0, lo - 30); hi = Math.min(255, hi + 30); }
    const range = Math.max(1, hi - lo);
    for (let i = 0; i < img.data.length; i += 4) {
      const gray = img.data[i] * 0.299 + img.data[i + 1] * 0.587 + img.data[i + 2] * 0.114;
      let v = (gray - lo) * 255 / range;
      v = Math.max(0, Math.min(255, v));
      v = v < 235 ? Math.pow(v / 255, 0.92) * 255 : 255;
      img.data[i] = img.data[i + 1] = img.data[i + 2] = v;
    }
    g.putImageData(img, 0, 0);
  }

  function prepareReceiptImage(image, canvas) {
    const bounds = detectReceiptBounds(image);
    const targetWidth = Math.min(2200, Math.max(1500, bounds.width * 2));
    const scale = targetWidth / bounds.width;
    canvas.width = Math.round(bounds.width * scale);
    canvas.height = Math.round(bounds.height * scale);
    const g = canvas.getContext('2d', { willReadFrequently: true });
    g.fillStyle = '#fff';
    g.fillRect(0, 0, canvas.width, canvas.height);
    g.drawImage(image, bounds.x, bounds.y, bounds.width, bounds.height, 0, 0, canvas.width, canvas.height);
    autoContrast(canvas);
    cropMeta = bounds;
    return bounds;
  }

  async function recognizeCanvas(canvas, label = '', base = 0, span = 1) {
    if (!window.Tesseract) throw new Error('OCR knihovna se nenačetla.');
    const result = await Tesseract.recognize(canvas, 'ces+eng', {
      tessedit_pageseg_mode: '6',
      preserve_interword_spaces: '1',
      logger: m => {
        if (m.status) $('ocrStatus').textContent = `${label}${m.status}`;
        if (typeof m.progress === 'number') $('ocrProgress').style.width = `${Math.round((base + m.progress * span) * 100)}%`;
      }
    });
    return result.data.text;
  }

  async function recognizeLongReceipt(canvas) {
    const maxChunk = 2100;
    if (canvas.height <= maxChunk * 1.35) return recognizeCanvas(canvas, 'Čtu doklad: ', 0.08, 0.88);
    const chunkHeight = 1900;
    const overlap = 80;
    const chunks = [];
    for (let y = 0; y < canvas.height; y += chunkHeight - overlap) {
      const h = Math.min(chunkHeight, canvas.height - y);
      if (h < 180) break;
      chunks.push({ y, h });
    }
    let text = '';
    for (let i = 0; i < chunks.length; i++) {
      const ch = chunks[i];
      const c = document.createElement('canvas');
      c.width = canvas.width; c.height = ch.h;
      c.getContext('2d').drawImage(canvas, 0, ch.y, canvas.width, ch.h, 0, 0, canvas.width, ch.h);
      const base = 0.08 + (i / chunks.length) * 0.88;
      const span = 0.88 / chunks.length;
      text += `\n--- BLOK ${i + 1}/${chunks.length} ---\n${await recognizeCanvas(c, `Blok ${i + 1}/${chunks.length}: `, base, span)}`;
    }
    return text;
  }

  async function handleFile(file) {
    fingerprint = await sha256(file);
    sourceFileName = file.name || 'invoice';
    const dup = await db().from('invoices').select('id,invoice_number,status').eq('organization_id', ctx.organization.id).eq('source_fingerprint', fingerprint).maybeSingle();
    if (dup.error) throw dup.error;
    if (dup.data) {
      $('duplicateBadge').textContent = 'duplicitní';
      $('duplicateBadge').className = 'badge danger';
      toast(`Tato faktura už existuje${dup.data.invoice_number ? ` (${dup.data.invoice_number})` : ''}.`, 5500);
      return;
    }

    $('duplicateBadge').textContent = 'nový doklad';
    $('duplicateBadge').className = 'badge muted';
    $('ocrProgressWrap').classList.remove('hidden');
    $('ocrProgress').style.width = '5%';
    $('ocrStatus').textContent = 'Hledám okraje dokladu…';

    let text = '';
    const canvas = $('invoicePreview');
    if (file.type === 'application/pdf') {
      if (!window.pdfjsLib) throw new Error('PDF knihovna se nenačetla.');
      pdfjsLib.GlobalWorkerOptions.workerSrc = 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js';
      const pdf = await pdfjsLib.getDocument({ data: await file.arrayBuffer() }).promise;
      const max = Math.min(pdf.numPages, 4);
      for (let i = 1; i <= max; i++) {
        const page = await pdf.getPage(i);
        const vp = page.getViewport({ scale: 2.5 });
        canvas.width = vp.width; canvas.height = vp.height;
        canvas.classList.remove('hidden');
        await page.render({ canvasContext: canvas.getContext('2d'), viewport: vp }).promise;
        autoContrast(canvas);
        text += `\n--- STRANA ${i} ---\n${await recognizeCanvas(canvas, `Strana ${i}: `, (i - 1) / max, 1 / max)}`;
      }
      cropMeta = { detected: false, pdf: true };
    } else {
      const image = new Image();
      const url = URL.createObjectURL(file);
      image.src = url;
      await image.decode();
      const bounds = prepareReceiptImage(image, canvas);
      canvas.classList.remove('hidden');
      URL.revokeObjectURL(url);
      $('ocrStatus').textContent = bounds.detected ? 'Doklad oříznutý. Čtu text…' : 'Doklad se nepodařilo oříznout, čtu celou fotku…';
      text = await recognizeLongReceipt(canvas);
    }

    $('ocrText').value = text.trim();
    $('ocrStatus').textContent = cropMeta?.detected ? 'OCR dokončeno · doklad automaticky oříznut.' : 'OCR dokončeno.';
    $('ocrProgress').style.width = '100%';
    parseText();
  }

  async function submit() {
    if (!rows.length && !$('ocrText').value.trim()) return toast('Doklad nemá žádná data.');
    const dup = fingerprint ? await db().from('invoices').select('id').eq('organization_id', ctx.organization.id).eq('source_fingerprint', fingerprint).maybeSingle() : { data: null, error: null };
    if (dup.error) throw dup.error;
    if (dup.data) return toast('Tato faktura už je v databázi.', 5000);

    const calculatedTotal = rows.reduce((s, r) => s + n(r.qty) * n(r.price), 0);
    const total = documentTotal != null ? documentTotal : calculatedTotal;
    const ins = await db().from('invoices').insert({
      organization_id: ctx.organization.id,
      venue_id: ctx.venue.id,
      supplier_name: $('supplier').value.trim(),
      invoice_number: $('number').value.trim(),
      issue_date: $('date').value || today(),
      total_amount: total || null,
      source_fingerprint: fingerprint,
      source_file_name: sourceFileName,
      raw_extraction: { raw_text: $('ocrText').value, source: 'invoice_capture_v2', captured_role: ctx.role, crop: cropMeta, printed_total: documentTotal, calculated_rows_total: calculatedTotal },
      extraction_provider: 'tesseract-browser-preprocessed-v2',
      status: 'review',
      created_by: ctx.user.id
    }).select('id').single();
    if (ins.error) throw ins.error;

    for (const r of rows) {
      const line = await db().from('invoice_lines').insert({
        invoice_id: ins.data.id,
        organization_id: ctx.organization.id,
        raw_name: r.rawName,
        product_id: r.productId || null,
        quantity: Number.isFinite(r.qty) ? r.qty : null,
        unit: 'ks',
        unit_price: Number.isFinite(r.price) ? r.price : null,
        line_total: r.lineTotal != null ? r.lineTotal : (n(r.qty) && n(r.price) ? n(r.qty) * n(r.price) : null),
        match_method: r.productId ? 'capture_suggested_mapping' : null,
        match_confidence: r.productId ? 0.8 : null,
        status: 'review',
        original_values: { raw_name: r.rawName, source_code: r.sourceCode || null, ocr_qty: r.qty, ocr_unit_price: r.price, ocr_line_total: r.lineTotal ?? null }
      });
      if (line.error) throw line.error;
    }

    const audit = await db().from('audit_events').insert({
      organization_id: ctx.organization.id,
      venue_id: ctx.venue.id,
      actor_user_id: ctx.user.id,
      event_type: 'invoice.captured_for_review',
      entity_type: 'invoice',
      entity_id: ins.data.id,
      after_data: { supplier: $('supplier').value.trim(), invoice_number: $('number').value.trim(), captured_lines: rows.length, total, extraction_provider: 'tesseract-browser-preprocessed-v2' }
    });
    if (audit.error) throw audit.error;

    toast(ctx.role === 'staff' ? 'Faktura odeslána vedoucímu ke schválení.' : 'Faktura připravena ke schválení.', 6000);
    if (['owner', 'manager'].includes(ctx.role)) setTimeout(() => location.href = 'invoice-review-v1.html', 700);
    else clear();
  }

  function clear() {
    rows = [];
    fingerprint = null;
    sourceFileName = null;
    documentTotal = null;
    cropMeta = null;
    $('invoiceFile').value = '';
    $('ocrText').value = '';
    $('supplier').value = '';
    $('number').value = '';
    $('date').value = today();
    $('invoicePreview').classList.add('hidden');
    $('ocrProgressWrap').classList.add('hidden');
    $('duplicateBadge').textContent = 'nový doklad';
    $('duplicateBadge').className = 'badge muted';
    render();
  }

  async function init() {
    ctx = await window.PubGuruBackend.loadContext();
    if (!ctx?.user || !ctx?.organization || !ctx?.venue) { location.replace('start.html'); return; }
    $('roleBadge').textContent = ctx.role === 'owner' ? 'Majitel' : ctx.role === 'manager' ? 'Vedoucí' : 'Zaměstnanec';
    const p = await db().from('products').select('id,name,ean,volume_ml,aliases').eq('organization_id', ctx.organization.id).is('archived_at', null).order('name');
    if (p.error) throw p.error;
    products = p.data || [];
    $('date').value = today();
    $('invoiceFile').onchange = e => {
      const f = e.target.files?.[0];
      if (f) handleFile(f).catch(err => { console.error(err); toast(`OCR selhalo: ${err.message}`, 6500); });
    };
    $('parseBtn').onclick = parseText;
    $('clearBtn').onclick = clear;
    $('addLineBtn').onclick = () => { rows.push({ id: uid(), rawName: '', productId: '', qty: 1, price: 0 }); render(); };
    $('submitBtn').onclick = () => submit().catch(err => { console.error(err); toast(`Uložení selhalo: ${err.message}`, 7000); });
    render();
  }

  document.addEventListener('DOMContentLoaded', () => init().catch(err => { console.error(err); toast(`Nelze spustit faktury: ${err.message}`, 7000); }));
})();