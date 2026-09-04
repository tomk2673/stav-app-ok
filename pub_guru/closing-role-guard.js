'use strict';

(function () {
  let ctx = null;
  const $ = id => document.getElementById(id);
  const n = v => { const x = Number(String(v ?? '').replace(/\s/g,'').replace(',','.')); return Number.isFinite(x) ? x : 0; };
  const esc = v => String(v ?? '').replace(/[&<>'"]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;',"'":'&#39;','"':'&quot;'}[c]));
  const money = v => new Intl.NumberFormat('cs-CZ',{style:'currency',currency:'CZK',maximumFractionDigits:2}).format(n(v));
  const db = () => window.PubGuruBackend.client;
  const lead = () => ['owner','manager'].includes(ctx?.role);

  function getLexical(name, fallback = null) {
    try {
      if (name === 'fileFingerprint') return fileFingerprint;
      if (name === 'fileName') return fileName;
      return fallback;
    } catch { return fallback; }
  }

  function submittedForm() {
    return {
      businessDate: $('businessDate').value,
      sourceType: $('sourceType').value || 'terminal',
      cashAmount: n($('cashAmount').value),
      cardAmount: n($('cardAmount').value),
      totalAmount: n($('totalAmount').value),
      transactionCount: Math.max(0, Math.round(n($('transactionCount').value))),
      refundsAmount: n($('refundsAmount').value),
      rawOcrText: $('closingOcrText').value || ''
    };
  }

  async function staffSave(event) {
    event.preventDefault(); event.stopImmediatePropagation();
    const form = submittedForm();
    if (!form.businessDate) return toast('Chybí datum uzávěrky.');
    if (!form.totalAmount && !form.cashAmount && !form.cardAmount) return toast('Chybí částka uzávěrky.');

    const parsed = typeof parseClosingText === 'function' ? parseClosingText(form.rawOcrText) : {};
    const keys = ['businessDate','cashAmount','cardAmount','totalAmount','transactionCount','refundsAmount'];
    const changed = keys.filter(k => parsed?.[k] != null && String(parsed[k]) !== String(form[k]));
    const reason = $('correctionReason').value.trim();
    if (changed.length && !reason) return toast(`Upravil jsi OCR hodnoty (${changed.join(', ')}). Napiš krátce proč.`, 5500);

    const fingerprint = getLexical('fileFingerprint');
    const sourceName = getLexical('fileName');
    if (fingerprint) {
      const duplicate = await db().from('closings').select('id').eq('organization_id', ctx.organization.id)
        .eq('venue_id', ctx.venue.id).eq('source_fingerprint', fingerprint).maybeSingle();
      if (duplicate.error) throw duplicate.error;
      if (duplicate.data) return toast('Tato uzávěrka už je v PUB GURU.', 5000);
    }

    const { data: closing, error } = await db().from('closings').insert({
      organization_id: ctx.organization.id,
      venue_id: ctx.venue.id,
      business_date: form.businessDate,
      source_type: form.sourceType,
      source_fingerprint: fingerprint,
      source_file_name: sourceName,
      cash_amount: form.cashAmount,
      card_amount: form.cardAmount,
      total_amount: form.totalAmount,
      transaction_count: form.transactionCount,
      refunds_amount: form.refundsAmount,
      raw_ocr_text: form.rawOcrText,
      extracted_values: { ocr: parsed, submitted: form, changed_fields: changed, staff_reason: reason || null },
      status: 'review',
      created_by: ctx.user.id
    }).select('id').single();
    if (error) throw error;

    const audit = await db().from('audit_events').insert({
      organization_id: ctx.organization.id,
      venue_id: ctx.venue.id,
      actor_user_id: ctx.user.id,
      event_type: 'closing.saved',
      entity_type: 'closing',
      entity_id: closing.id,
      after_data: { business_date: form.businessDate, total_amount: form.totalAmount, changed_fields: changed },
      reason: reason || null
    });
    if (audit.error) throw audit.error;

    if (typeof renderClosings === 'function') await renderClosings();
    if (typeof renderAudit === 'function') await renderAudit();
    if (typeof clearForm === 'function') clearForm(false);
    toast('Uzávěrka odeslána vedoucímu ke schválení.', 5500);
  }

  async function renderLeadQueue() {
    if (!lead()) return;
    let panel = $('leadClosingReview');
    if (!panel) {
      panel = document.createElement('section');
      panel.id = 'leadClosingReview';
      panel.className = 'panel';
      panel.style.marginTop = '16px';
      panel.innerHTML = '<div class="panel-head"><h2>Čekají na zamknutí</h2><span id="leadClosingCount" class="badge muted">0</span></div><div id="leadClosingQueue" class="closing-list"></div>';
      document.querySelector('.closing-shell')?.appendChild(panel);
    }
    const { data, error } = await db().from('closings')
      .select('id,business_date,source_type,total_amount,transaction_count,created_at')
      .eq('organization_id', ctx.organization.id).eq('venue_id', ctx.venue.id).eq('status','review')
      .order('created_at',{ascending:false}).limit(50);
    if (error) throw error;
    $('leadClosingCount').textContent = String(data?.length || 0);
    $('leadClosingQueue').innerHTML = data?.length ? data.map(c => `
      <div class="closing-row"><div><strong>${esc(c.business_date)}</strong><small>${esc(c.source_type)} · ${c.transaction_count || 0} transakcí</small></div>
      <div style="text-align:right"><strong>${money(c.total_amount)}</strong><br><button class="btn btn-small finalize-review" data-id="${c.id}">Zkontrolováno · zamknout</button></div></div>`).join('') : '<div class="empty-state">Nic nečeká na schválení.</div>';
    document.querySelectorAll('.finalize-review').forEach(btn => btn.addEventListener('click', () => finalizeExisting(btn.dataset.id)));
  }

  async function finalizeExisting(id) {
    const now = new Date().toISOString();
    const update = await db().from('closings').update({ status:'finalized', finalized_at:now, finalized_by:ctx.user.id })
      .eq('id',id).eq('status','review');
    if (update.error) throw update.error;
    const audit = await db().from('audit_events').insert({
      organization_id:ctx.organization.id, venue_id:ctx.venue.id, actor_user_id:ctx.user.id,
      event_type:'closing.finalized', entity_type:'closing', entity_id:id, after_data:{status:'finalized'}
    });
    if (audit.error) throw audit.error;
    if (typeof renderClosings === 'function') await renderClosings();
    if (typeof renderAudit === 'function') await renderAudit();
    await renderLeadQueue();
    toast('Uzávěrka zkontrolována a zamčena.', 5000);
  }

  async function init() {
    if (!window.PubGuruBackend) return;
    ctx = await window.PubGuruBackend.loadContext();
    if (!ctx?.user || !ctx?.organization || !ctx?.venue) return;

    if (ctx.role === 'staff') {
      $('finalizeClosingBtn')?.classList.add('hidden');
      if ($('saveClosingDraftBtn')) $('saveClosingDraftBtn').textContent = 'Odeslat vedoucímu ke schválení';
      $('saveClosingDraftBtn')?.addEventListener('click', e => staffSave(e).catch(err => { console.error(err); toast(`Uložení selhalo: ${err.message}`,6500); }), true);
      $('finalizeClosingBtn')?.addEventListener('click', e => { e.preventDefault(); e.stopImmediatePropagation(); toast('Uzávěrku zamyká vedoucí nebo majitel.'); }, true);
    } else if (lead()) {
      await renderLeadQueue();
    } else {
      $('saveClosingDraftBtn')?.classList.add('hidden');
      $('finalizeClosingBtn')?.classList.add('hidden');
      $('closingFile')?.setAttribute('disabled','disabled');
    }
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', () => init().catch(console.error));
  else init().catch(console.error);
})();
