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
  const uid = () => `line_${Date.now().toString(36)}_${Math.random().toString(36).slice(2,7)}`;
  const esc = value => String(value ?? '').replace(/[&<>'"]/g, c => ({
    '&':'&amp;','<':'&lt;','>':'&gt;',"'":'&#39;','"':'&quot;'
  }[c]));
  const today = () => new Date().toISOString().slice(0, 10);

  function toast(message, ms = 5000) {
    const el = $('toast');
    if (!el) return;
    el.textContent = message;
    el.classList.remove('hidden');
    clearTimeout(toast.t);
    toast.t = setTimeout(() => el.classList.add('hidden'), ms);
  }

  function parseNumber(value) {
    let s = String(value ?? '').trim().replace(/\s/g, '');
    s = s.replace(/[^0-9,.\-]/g, '');
    if (!s) return NaN;
    const comma = s.lastIndexOf(',');
    const dot = s.lastIndexOf('.');
    if (comma >= 0 && dot >= 0) {
      const decimal = comma > dot ? ',' : '.';
      const thousands = decimal === ',' ? '.' : ',';
      s = s.split(thousands).join('').replace(decimal, '.');
    } else if (comma >= 0) {
      const tail = s.length - comma - 1;
      s = tail === 2 ? s.replace(',', '.') : s.replace(/,/g, '');
    } else if (dot >= 0) {
      const tail = s.length - dot - 1;
      if (tail !== 2) s = s.replace(/\./g, '');
    }
    const x = Number(s);
    return Number.isFinite(x) ? x : NaN;
  }

  const num = (value, fallback = 0) => {
    const x = parseNumber(value);
    return Number.isFinite(x) ? x : fallback;
  };

  function moneyTokens(text) {
    const matches = String(text || '').match(/-?\d{1,3}(?:[ .]\d{3})*(?:[,.]\d{2})|-?\d+[,.]\d{2}/g) || [];
    return matches.map(parseNumber).filter(Number.isFinite);
  }

  function normalizeWords(text) {
    return String(text || '').toLowerCase().normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '')
      .replace(/[^a-z0-9 ]/g, ' ')
      .split(/\s+/)
      .filter(w => w.length > 1);
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
      const aliases = Array.isArray(p.aliases) ? p.aliases : [];
      const s = Math.max(similarity(text, p.name), ...aliases.map(a => similarity(text, a)));
      if (s > score) { score = s; best = p; }
    }
    return score >= 0.42 ? best : null;
  }

  function productOptions(selected = '') {
    return '<option value="">Bez párování</option>' + products.map(p =>
      `<option value="${p.id}" ${p.id === selected ? 'selected' : ''}>${esc(p.name)}${p.ean ? ` · ${esc(p.ean)}` : ''}</option>`
    ).join('');
  }

  function render() {
    $('lineCount').textContent = String(rows.length);
    $('lines').innerHTML = rows.length ? rows.map((r, i) => {
      const meta = [
        r.sourceCode ? `kód ${esc(r.sourceCode)}` : '',
        Number.isFinite(r.vatRate) ? `DPH ${r.vatRate}%` : '',
        Number.isFinite(r.lineGross) ? `brutto ${r.lineGross.toLocaleString('cs-CZ', {maximumFractionDigits:2})} Kč` : '',
        r.warning ? `⚠ ${esc(r.warning)}` : ''
      ].filter(Boolean).join(' · ');
      return `<div class="line${r.warning ? ' line-warning' : ''}" data-i="${i}">
        <label class="raw">Text z faktury
          <input class="rawName" value="${esc(r.rawName)}" />
          ${meta ? `<small class="line-meta">${meta}</small>` : ''}
        </label>
        <label class="product">Produkt<select class="productId">${productOptions(r.productId)}</select></label>
        <label>Ks<input class="qty" type="number" step="0.01" value="${Number.isFinite(r.qty) ? r.qty : ''}" /></label>
        <label>Cena/ks bez DPH<input class="price" type="number" min="0" step="0.01" value="${Number.isFinite(r.price) ? r.price.toFixed(2) : ''}" /></label>
        <button class="icon-btn remove" title="Odstranit">×</button>
      </div>`;
    }).join('') : '<div class="mutedbox">Zatím žádné jisté položky.</div>';

    document.querySelectorAll('.line').forEach(el => {
      const i = Number(el.dataset.i);
      el.querySelector('.rawName').oninput = e => rows[i].rawName = e.target.value;
      el.querySelector('.productId').onchange = e => rows[i].productId = e.target.value;
      el.querySelector('.qty').oninput = e => rows[i].qty = num(e.target.value, 0);
      el.querySelector('.price').oninput = e => rows[i].price = num(e.target.value, 0);
      el.querySelector('.remove').onclick = () => { rows.splice(i, 1); render(); };
    });
  }

  function cleanLines(text) {
    return String(text || '')
      .split(/\r?\n/)
      .map(x => x.replace(/[|]/g, ' ').replace(/\s+/g, ' ').trim())
      .filter(Boolean)
      .filter(x => !/^---\s*(BLOK|STRANA)/i.test(x));
  }

  function parseDate(text) {
    const patterns = [
      /datum\s+vystav[eě]n[ií]\s*[:\-]?\s*(\d{1,2}[.\-/ ]\d{1,2}[.\-/ ]\d{2,4})/i,
      /datum\s+uzp\s*[:\-]?\s*(\d{1,2}[.\-/ ]\d{1,2}[.\-/ ]\d{2,4})/i
    ];
    for (const re of patterns) {
      const m = String(text || '').match(re);
      if (!m) continue;
      const p = m[1].trim().split(/[.\-/ ]+/).map(Number);
      if (p.length !== 3) continue;
      const y = p[2] < 100 ? 2000 + p[2] : p[2];
      if (p[0] > 0 && p[0] <= 31 && p[1] > 0 && p[1] <= 12) {
        return `${y}-${String(p[1]).padStart(2,'0')}-${String(p[0]).padStart(2,'0')}`;
      }
    }
    return null;
  }

  function parseSupplier(text) {
    const lines = cleanLines(text);
    const direct = lines.find(x => /\bROJAL\s+spol/i.test(x));
    if (direct) {
      const m = direct.match(/(ROJAL\s+spol\.?\s+s\.?\s*r\.?\s*o\.?)/i);
      return m ? m[1].replace(/\s+/g, ' ').trim() : 'ROJAL spol. s r.o.';
    }
    const i = lines.findIndex(x => /dodavatel/i.test(x));
    if (i >= 0) {
      for (let j = i; j < Math.min(lines.length, i + 4); j++) {
        const cleaned = lines[j].replace(/^.*dodavatel\s*:?\s*/i, '').trim();
        if (cleaned && !/^(prodej|ičo|ico|dič|dic|datum|dodaci)/i.test(cleaned)) return cleaned;
      }
    }
    return '';
  }

  function parseInvoiceNumber(text) {
    const m = String(text || '').match(/(?:č[ií]slo|cislo)\s+dokladu\s*[:\-]?\s*([0-9O]{6,12})/i);
    if (!m) return '';
    return m[1].replace(/O/gi, '0');
  }

  function parsePrintedTotal(text) {
    const all = [...String(text || '').matchAll(/celkem\s*(?:\[\s*czk\s*\])?\s*:?\s*(-?\d[\d\s.]*[,.]\d{2})/ig)];
    if (!all.length) return null;
    const x = parseNumber(all[all.length - 1][1]);
    return Number.isFinite(x) ? x : null;
  }

  function codeFromLine(line) {
    const matches = [...String(line || '').matchAll(/\b([A-Z0-9]{2,3}-[A-Z0-9]{2,4})\b/ig)];
    for (const m of matches) {
      const code = m[1].toUpperCase();
      const suffix = line.slice((m.index || 0) + m[0].length).trim();
      if (/[A-ZÁ-Ž]{2}/i.test(suffix)) return { code, index: m.index || 0, name: suffix };
    }
    return null;
  }

  function dataFromLine(line) {
    const vat = String(line || '').match(/\b(0|12|21)\s*%/);
    if (!vat) return null;
    const qtyMatch = String(line || '').match(/(-?\d+(?:[,.]\d+)?|\|)\s*(KS|KUS)\b/i);
    if (!qtyMatch) return null;
    const qty = qtyMatch[1] === '|' ? 1 : parseNumber(qtyMatch[1]);
    if (!Number.isFinite(qty)) return null;
    const afterUnit = String(line).slice((qtyMatch.index || 0) + qtyMatch[0].length);
    const prices = moneyTokens(afterUnit);
    if (!prices.length) return null;
    const unitGross = Math.abs(prices[0]);
    const lineGross = prices.length >= 2 ? prices[prices.length - 1] : qty * unitGross;
    const vatRate = Number(vat[1]);
    const unitNet = vatRate > 0 ? unitGross / (1 + vatRate / 100) : unitGross;
    const lineNet = vatRate > 0 ? lineGross / (1 + vatRate / 100) : lineGross;
    const expectedGross = qty * unitGross;
    const mismatch = Math.abs(expectedGross - lineGross);
    const tolerance = Math.max(0.03, Math.abs(lineGross) * 0.003);
    return {
      qty,
      vatRate,
      unitGross,
      unitNet,
      lineGross,
      lineNet,
      warning: mismatch > tolerance ? `nesedí ${expectedGross.toFixed(2)} vs ${lineGross.toFixed(2)}` : ''
    };
  }

  function parseRojalRows(text) {
    const lines = cleanLines(text);
    const out = [];
    let current = null;
    let insideItems = false;

    const pushCurrent = () => {
      if (!current || !current.data || !current.name) { current = null; return; }
      const rawName = current.name.replace(/\s+/g, ' ').trim();
      if (rawName.length < 3) { current = null; return; }
      const p = bestProductMatch(rawName);
      out.push({
        id: uid(),
        rawName,
        productId: p?.id || '',
        sourceCode: current.code,
        qty: current.data.qty,
        vatRate: current.data.vatRate,
        price: current.data.unitNet,
        unitGross: current.data.unitGross,
        lineNet: current.data.lineNet,
        lineGross: current.data.lineGross,
        warning: current.data.warning
      });
      current = null;
    };

    for (const line of lines) {
      if (/id\s+zbo[zž][ií]|n[aá]zev\s+zbo[zž][ií]/i.test(line)) {
        insideItems = true;
        continue;
      }
      if (/da[nň]\s*%\s+netto|\bnetto\s+dph\s+brutto\b|celkem\s*(?:\[\s*czk\s*\])?/i.test(line)) {
        pushCurrent();
        break;
      }

      const item = codeFromLine(line);
      if (item) {
        if (!insideItems) insideItems = true;
        pushCurrent();
        current = { code: item.code, name: item.name, data: null };
        const inlineData = dataFromLine(item.name);
        if (inlineData) {
          current.name = item.name.replace(/\b(0|12|21)\s*%.*$/i, '').trim();
          current.data = inlineData;
          pushCurrent();
        }
        continue;
      }

      if (!insideItems || !current) continue;

      const data = dataFromLine(line);
      if (data) {
        current.data = data;
        pushCurrent();
        continue;
      }

      if (!/%/.test(line) && !/\b(KS|KUS)\b/i.test(line) &&
          !/^(brutto|mno[zž]stv[ií]|da[nň]|id\s+zbo[zž][ií]|n[aá]zev\s+zbo[zž][ií])/i.test(line)) {
        const letters = (line.match(/[A-ZÁ-Ž]/gi) || []).length;
        if (letters >= 2 && line.length <= 90) current.name += ` ${line}`;
      }
    }
    pushCurrent();

    const seen = new Set();
    return out.filter(r => {
      const key = `${r.sourceCode}|${normalizeWords(r.rawName).join(' ')}|${r.qty}|${r.lineGross?.toFixed(2)}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  }

  function parseGenericRows(text) {
    const found = [];
    for (const line of cleanLines(text)) {
      if (/(celkem|dph|dodavatel|odb[eě]ratel|faktura|stvrzenka|č[ií]slo dokladu|ico|ičo|dic|dič)/i.test(line)) continue;
      const qty = line.match(/(-?\d+(?:[,.]\d+)?)\s*(ks|kus|bal|kart|btl)\b/i);
      if (!qty) continue;
      const prices = moneyTokens(line.slice((qty.index || 0) + qty[0].length));
      if (!prices.length) continue;
      const name = line.slice(0, qty.index || 0).replace(/[;:|]+$/g,'').trim();
      if (name.length < 3 || !/[A-Za-zÁ-ž]/.test(name)) continue;
      const p = bestProductMatch(name);
      found.push({
        id: uid(), rawName: name, productId: p?.id || '',
        qty: parseNumber(qty[1]), price: Math.abs(prices[0]),
        vatRate: null, unitGross: null, lineNet: null,
        lineGross: prices.length > 1 ? prices[prices.length - 1] : null,
        warning: 'zkontrolovat sazbu DPH'
      });
    }
    return found.slice(0, 80);
  }

  function parseText() {
    const text = $('ocrText').value || '';
    if (!text.trim()) return toast('Nejdřív načti fakturu.');

    const supplier = parseSupplier(text);
    if (supplier) $('supplier').value = supplier;
    const invoiceNo = parseInvoiceNumber(text);
    if (invoiceNo) $('number').value = invoiceNo;
    const date = parseDate(text);
    if (date) $('date').value = date;
    documentTotal = parsePrintedTotal(text);

    const isRojal = /\bROJAL\b|prodej\s+na\s+stvrzenku|id\s+zbo[zž][ií]/i.test(text);
    rows = isRojal ? parseRojalRows(text) : parseGenericRows(text);
    render();

    const warnings = rows.filter(r => r.warning).length;
    if (isRojal) {
      if (rows.length >= 10) {
        toast(`ROJAL: ${rows.length} jistých položek${warnings ? ` · ${warnings} ke kontrole` : ''}${documentTotal != null ? ` · doklad ${documentTotal.toLocaleString('cs-CZ')} Kč` : ''}.`, 6500);
      } else {
        toast(`ROJAL: OCR zachytil jen ${rows.length} jistých položek. Nevytvářím falešné řádky. Zkus ostřejší fotku nebo Apple Vision.`, 7500);
      }
    } else {
      toast(rows.length ? `Nalezeno ${rows.length} položek. Zkontroluj je.` : 'Nenalezl jsem žádnou dostatečně jistou položku.', 6000);
    }
  }

  async function sha256(file) {
    const hash = await crypto.subtle.digest('SHA-256', await file.arrayBuffer());
    return [...new Uint8Array(hash)].map(b => b.toString(16).padStart(2,'0')).join('');
  }

  function largestRun(flags) {
    let best = null, start = -1;
    for (let i = 0; i <= flags.length; i++) {
      if (i < flags.length && flags[i]) {
        if (start < 0) start = i;
      } else if (start >= 0) {
        if (!best || i - start > best[1] - best[0]) best = [start, i - 1];
        start = -1;
      }
    }
    return best;
  }

  function detectReceiptBounds(image) {
    const maxW = 480;
    const scale = Math.min(1, maxW / image.naturalWidth);
    const w = Math.max(1, Math.round(image.naturalWidth * scale));
    const h = Math.max(1, Math.round(image.naturalHeight * scale));
    const c = document.createElement('canvas');
    c.width = w; c.height = h;
    const g = c.getContext('2d', {willReadFrequently:true});
    g.drawImage(image, 0, 0, w, h);
    const d = g.getImageData(0,0,w,h).data;
    const cols = new Float32Array(w);

    for (let y = 0; y < h; y += 2) {
      for (let x = 0; x < w; x += 2) {
        const i = (y*w+x)*4;
        const r=d[i], gg=d[i+1], b=d[i+2];
        const max=Math.max(r,gg,b), min=Math.min(r,gg,b), avg=(r+gg+b)/3;
        if (avg > 115 && max-min < 28) cols[x] += 1;
      }
    }
    const threshold = h * 0.16;
    const xr = largestRun(Array.from(cols, v => v > threshold));
    if (!xr || xr[1]-xr[0] < w*0.12) {
      return {x:0,y:0,width:image.naturalWidth,height:image.naturalHeight,detected:false};
    }

    const x1=Math.max(0,xr[0]-4), x2=Math.min(w-1,xr[1]+4);
    const rowsScore = new Float32Array(h);
    for (let y=0;y<h;y+=2){
      let cnt=0;
      for(let x=x1;x<=x2;x+=2){
        const i=(y*w+x)*4;
        const r=d[i],gg=d[i+1],b=d[i+2];
        const max=Math.max(r,gg,b),min=Math.min(r,gg,b),avg=(r+gg+b)/3;
        if(avg>110 && max-min<32) cnt++;
      }
      rowsScore[y]=cnt;
    }
    const yr = largestRun(Array.from(rowsScore, v => v > (x2-x1)*0.22));
    if (!yr) {
      return {
        x:Math.round(x1/scale),y:0,width:Math.round((x2-x1+1)/scale),
        height:image.naturalHeight,detected:true
      };
    }
    const mx=Math.max(3,Math.round((xr[1]-xr[0])*0.04));
    const my=Math.max(3,Math.round((yr[1]-yr[0])*0.015));
    const sx=Math.max(0,xr[0]-mx), ex=Math.min(w-1,xr[1]+mx);
    const sy=Math.max(0,yr[0]-my), ey=Math.min(h-1,yr[1]+my);
    return {
      x:Math.round(sx/scale), y:Math.round(sy/scale),
      width:Math.round((ex-sx+1)/scale), height:Math.round((ey-sy+1)/scale), detected:true
    };
  }

  function enhance(canvas) {
    const g=canvas.getContext('2d',{willReadFrequently:true});
    const img=g.getImageData(0,0,canvas.width,canvas.height);
    for(let i=0;i<img.data.length;i+=4){
      const gray=img.data[i]*0.299+img.data[i+1]*0.587+img.data[i+2]*0.114;
      let v=(gray-45)*1.28;
      v=Math.max(0,Math.min(255,v));
      img.data[i]=img.data[i+1]=img.data[i+2]=v;
    }
    g.putImageData(img,0,0);
  }

  function prepareImage(image, canvas) {
    const b=detectReceiptBounds(image);
    const targetWidth=Math.min(2400,Math.max(1600,b.width*2.2));
    const s=targetWidth/b.width;
    canvas.width=Math.round(b.width*s);
    canvas.height=Math.round(b.height*s);
    const g=canvas.getContext('2d',{willReadFrequently:true});
    g.fillStyle='#fff'; g.fillRect(0,0,canvas.width,canvas.height);
    g.drawImage(image,b.x,b.y,b.width,b.height,0,0,canvas.width,canvas.height);
    enhance(canvas);
    cropMeta=b;
    return b;
  }

  async function recognize(canvas, label='', base=0, span=1) {
    if (!window.Tesseract) throw new Error('OCR knihovna se nenačetla.');
    const result=await Tesseract.recognize(canvas,'ces+eng',{
      tessedit_pageseg_mode:'6',
      preserve_interword_spaces:'1',
      logger:m=>{
        if(m.status)$('ocrStatus').textContent=`${label}${m.status}`;
        if(typeof m.progress==='number')$('ocrProgress').style.width=`${Math.round((base+m.progress*span)*100)}%`;
      }
    });
    return result.data.text || '';
  }

  async function recognizeLong(canvas) {
    const chunk=1800, overlap=120;
    if(canvas.height<=2300) return recognize(canvas,'Čtu doklad: ',0.08,0.9);
    const parts=[];
    for(let y=0;y<canvas.height;y+=chunk-overlap){
      const h=Math.min(chunk,canvas.height-y);
      if(h<220)break;
      parts.push({y,h});
    }
    let text='';
    for(let i=0;i<parts.length;i++){
      const p=parts[i], c=document.createElement('canvas');
      c.width=canvas.width;c.height=p.h;
      c.getContext('2d').drawImage(canvas,0,p.y,canvas.width,p.h,0,0,canvas.width,p.h);
      text+=`\n--- BLOK ${i+1}/${parts.length} ---\n${await recognize(c,`Blok ${i+1}/${parts.length}: `,0.08+(i/parts.length)*0.9,0.9/parts.length)}`;
    }
    return text;
  }

  async function handleFile(file) {
    fingerprint=await sha256(file);
    sourceFileName=file.name || 'invoice';
    const dup=await db().from('invoices').select('id,invoice_number,status')
      .eq('organization_id',ctx.organization.id).eq('source_fingerprint',fingerprint).maybeSingle();
    if(dup.error)throw dup.error;
    if(dup.data){
      $('duplicateBadge').textContent='duplicitní';
      $('duplicateBadge').className='badge danger';
      return toast(`Tento doklad už existuje${dup.data.invoice_number?` (${dup.data.invoice_number})`:''}.`,6000);
    }

    $('duplicateBadge').textContent='nový doklad';
    $('duplicateBadge').className='badge muted';
    $('ocrProgressWrap').classList.remove('hidden');
    $('ocrProgress').style.width='4%';
    $('ocrStatus').textContent='Připravuji doklad…';

    const canvas=$('invoicePreview');
    let text='';
    if(file.type==='application/pdf'){
      if(!window.pdfjsLib)throw new Error('PDF knihovna se nenačetla.');
      pdfjsLib.GlobalWorkerOptions.workerSrc='https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js';
      const pdf=await pdfjsLib.getDocument({data:await file.arrayBuffer()}).promise;
      const max=Math.min(pdf.numPages,4);
      for(let i=1;i<=max;i++){
        const page=await pdf.getPage(i);
        const vp=page.getViewport({scale:2.5});
        canvas.width=vp.width;canvas.height=vp.height;canvas.classList.remove('hidden');
        await page.render({canvasContext:canvas.getContext('2d'),viewport:vp}).promise;
        enhance(canvas);
        text+=`\n--- STRANA ${i} ---\n${await recognize(canvas,`Strana ${i}: `,(i-1)/max,1/max)}`;
      }
      cropMeta={detected:false,pdf:true};
    }else{
      const image=new Image();
      const url=URL.createObjectURL(file);
      image.src=url;await image.decode();
      const b=prepareImage(image,canvas);
      canvas.classList.remove('hidden');
      URL.revokeObjectURL(url);
      $('ocrStatus').textContent=b.detected?'Doklad oříznutý. Čtu text…':'Čtu celou fotku…';
      text=await recognizeLong(canvas);
    }
    $('ocrText').value=text.trim();
    $('ocrStatus').textContent=window.PubGuruNativeOCR?.available?.()?'Apple Vision OCR dokončeno.':'OCR dokončeno.';
    $('ocrProgress').style.width='100%';
    parseText();
  }

  async function submit() {
    if(!rows.length)return toast('Není co uložit. Nejprve musí být nalezena aspoň jedna jistá položka.');
    const dup=fingerprint?await db().from('invoices').select('id').eq('organization_id',ctx.organization.id)
      .eq('source_fingerprint',fingerprint).maybeSingle():{data:null,error:null};
    if(dup.error)throw dup.error;
    if(dup.data)return toast('Tento doklad už je v databázi.',5500);

    const calculatedNet=rows.reduce((s,r)=>s+(Number.isFinite(r.lineNet)?r.lineNet:(r.qty*r.price)),0);
    const ins=await db().from('invoices').insert({
      organization_id:ctx.organization.id,
      venue_id:ctx.venue.id,
      supplier_name:$('supplier').value.trim(),
      invoice_number:$('number').value.trim(),
      issue_date:$('date').value||today(),
      total_amount:documentTotal ?? null,
      source_fingerprint:fingerprint,
      source_file_name:sourceFileName,
      raw_extraction:{
        raw_text:$('ocrText').value,
        source:'invoice_capture_v3',
        captured_role:ctx.role,
        crop:cropMeta,
        printed_total_gross:documentTotal,
        calculated_net:calculatedNet,
        warnings:rows.filter(r=>r.warning).length
      },
      extraction_provider:window.PubGuruNativeOCR?.available?.()?'apple-vision-native':'tesseract-browser-v3',
      status:'review',
      created_by:ctx.user.id
    }).select('id').single();
    if(ins.error)throw ins.error;

    for(const r of rows){
      const line=await db().from('invoice_lines').insert({
        invoice_id:ins.data.id,
        organization_id:ctx.organization.id,
        raw_name:r.rawName,
        product_id:r.productId||null,
        quantity:Number.isFinite(r.qty)?r.qty:null,
        unit:'ks',
        unit_price:Number.isFinite(r.price)?r.price:null,
        line_total:Number.isFinite(r.lineNet)?r.lineNet:null,
        vat_rate:Number.isFinite(r.vatRate)?r.vatRate:null,
        unit_price_net:Number.isFinite(r.price)?r.price:null,
        line_total_net:Number.isFinite(r.lineNet)?r.lineNet:null,
        line_total_gross:Number.isFinite(r.lineGross)?r.lineGross:null,
        match_method:r.productId?'capture_suggested_mapping':null,
        match_confidence:r.productId?0.8:null,
        status:'review',
        original_values:{
          raw_name:r.rawName,
          source_code:r.sourceCode||null,
          ocr_qty:r.qty,
          ocr_vat_rate:r.vatRate,
          ocr_unit_gross:r.unitGross,
          ocr_line_gross:r.lineGross,
          parser_warning:r.warning||null
        }
      });
      if(line.error)throw line.error;
    }

    const audit=await db().from('audit_events').insert({
      organization_id:ctx.organization.id,
      venue_id:ctx.venue.id,
      actor_user_id:ctx.user.id,
      event_type:'invoice.captured_for_review',
      entity_type:'invoice',
      entity_id:ins.data.id,
      after_data:{
        supplier:$('supplier').value.trim(),
        invoice_number:$('number').value.trim(),
        captured_lines:rows.length,
        total_gross:documentTotal,
        warnings:rows.filter(r=>r.warning).length,
        extraction_provider:window.PubGuruNativeOCR?.available?.()?'apple-vision-native':'tesseract-browser-v3'
      }
    });
    if(audit.error)throw audit.error;

    toast(ctx.role==='staff'?'Faktura odeslána vedoucímu ke schválení.':'Faktura připravena ke schválení.',6000);
    if(['owner','manager'].includes(ctx.role))setTimeout(()=>location.href='invoice-review-v1.html',700);
  }

  function clear() {
    rows=[];fingerprint=null;sourceFileName=null;documentTotal=null;cropMeta=null;
    for(const id of ['invoiceFile','cameraFile']) if($(id)) $(id).value='';
    $('ocrText').value='';$('supplier').value='';$('number').value='';$('date').value=today();
    $('invoicePreview').classList.add('hidden');
    $('ocrProgressWrap').classList.add('hidden');
    $('duplicateBadge').textContent='nový doklad';$('duplicateBadge').className='badge muted';
    render();
  }

  async function init() {
    ctx=await window.PubGuruBackend.loadContext();
    if(!ctx?.user||!ctx?.organization||!ctx?.venue){location.replace('start.html');return;}
    $('roleBadge').textContent=ctx.role==='owner'?'Majitel':ctx.role==='manager'?'Vedoucí':'Zaměstnanec';
    const p=await db().from('products').select('id,name,ean,volume_ml,aliases')
      .eq('organization_id',ctx.organization.id).is('archived_at',null).order('name');
    if(p.error)throw p.error;
    products=p.data||[];
    $('date').value=today();

    const attach=id=>{
      const el=$(id);
      if(!el)return;
      el.onchange=e=>{
        const f=e.target.files?.[0];
        if(f)handleFile(f).catch(err=>{console.error(err);toast(`OCR selhalo: ${err.message}`,7500);});
      };
    };
    attach('invoiceFile');
    attach('cameraFile');
    $('parseBtn').onclick=parseText;
    $('clearBtn').onclick=clear;
    $('addLineBtn').onclick=()=>{rows.push({id:uid(),rawName:'',productId:'',qty:1,price:0,vatRate:null,lineGross:null,lineNet:null,warning:'ručně přidaná položka'});render();};
    $('submitBtn').onclick=()=>submit().catch(err=>{console.error(err);toast(`Uložení selhalo: ${err.message}`,7500);});
    render();
  }

  document.addEventListener('DOMContentLoaded',()=>init().catch(err=>{
    console.error(err);
    toast(`Nelze spustit faktury: ${err.message}`,7500);
  }));
})();
