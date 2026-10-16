'use strict';

(function () {
  const db = () => window.PubGuruBackend.client;
  let ctx, panel, status, sources, files, setup, timer, refreshing = false;
  const manager = () => ['owner', 'manager'].includes(ctx?.role);
  const el = (tag, text, className) => { const n = document.createElement(tag); if (text) n.textContent = text; if (className) n.className = className; return n; };

  function describe(file) {
    if (file.import_status === 'failed') return file.import_error || 'Import selhal.';
    if (file.import_status === 'downloading') return 'Stahuji a ukládám originál';
    if (file.ocr_status === 'failed') return file.ocr_error || 'OCR selhalo · zopakuj čtení ve frontě';
    if (file.invoice_status === 'posted' || file.ocr_status === 'done') return 'Schváleno';
    if (file.invoice_status === 'review' || file.ocr_status === 'review') return 'Přečteno · čeká na schválení';
    if (file.ocr_status === 'processing') return 'Probíhá OCR';
    return file.import_status === 'duplicate' ? 'Shodný originál už je uložený · druhý doklad nevznikl' : 'Uloženo · čeká na OCR';
  }

  function connectionState(source, now = Date.now()) {
    if (source.error_message) return source.error_message;
    if (!source.last_connected_at) return 'Čeká na první propojení Google účtu';
    const connected = new Date(source.last_connected_at);
    if (now - connected.getTime() > 20 * 60 * 1000) return 'Kontrola Drive se odmlčela. Ověř spuštění skriptu a oprávnění Google.';
    return 'Poslední spojení: ' + connected.toLocaleString('cs-CZ');
  }

  async function command(action, sourceId = null, payload = {}) {
    const result = await db().rpc('invoice_drive_command', {p_action: action, p_organization_id: ctx.organization.id,
      p_venue_id: ctx.venue.id, p_source_id: sourceId, p_payload: payload});
    if (result.error) throw result.error;
    return result.data;
  }

  function showError(error) {
    status.textContent = /PGRST202|42883/.test(String(error?.code || ''))
      ? 'Import Drive zatím není nasazený. Stávající focení a fronta fungují dál.'
      : 'Stav importu není dostupný. Obnov připojení; uložené doklady zůstávají ve frontě.';
  }

  async function refresh() {
    if (refreshing || !ctx) return;
    if (navigator.onLine === false) { status.textContent = 'Bez připojení · stav se obnoví po návratu online.'; return; }
    refreshing = true;
    try {
      const data = await command('summary');
      sources.replaceChildren(); files.replaceChildren();
      status.textContent = data.sources?.length ? 'Doklady z Drive se ukládají automaticky. Pro OCR nech otevřené Faktury.' : 'Drive zatím není propojený.';
      for (const source of data.sources || []) {
        const row = el('div', null, 'queue-job'); const detail = el('div');
        const link = el('a', 'Složka faktur v Google Drive');
        link.href = 'https://drive.google.com/drive/folders/' + source.folder_id;
        link.target = '_blank'; link.rel = 'noopener noreferrer';
        const text = connectionState(source);
        detail.append(link, el('small', text)); row.append(detail);
        if (manager()) {
          const buttons = el('div', null, 'button-row wrap');
          const retry = el('button', 'Zopakovat import', 'btn'); retry.type = 'button';
          retry.onclick = async () => { retry.disabled = true; try { await command('retry', source.id); status.textContent = 'Při další kontrole Drive se import zopakuje.'; } catch (error) { showError(error); } finally { retry.disabled = false; } };
          const disconnect = el('button', 'Odpojit', 'btn'); disconnect.type = 'button';
          disconnect.onclick = async () => { disconnect.disabled = true; try { await command('disconnect', source.id); await refresh(); } catch (error) { showError(error); } finally { disconnect.disabled = false; } };
          buttons.append(retry, disconnect); row.append(buttons);
        }
        sources.append(row);
      }
      for (const file of data.files || []) {
        const row = el('div', null, 'queue-job'); const detail = el('div');
        detail.append(el('strong', file.file_name), el('small', describe(file) + (file.drive_version ? ' · Drive verze ' + file.drive_version : '')));
        const link = el('a', 'Soubor v Drive', 'btn');
        link.href = 'https://drive.google.com/file/d/' + file.drive_file_id + '/view';
        link.target = '_blank'; link.rel = 'noopener noreferrer';
        const buttons = el('div', null, 'button-row wrap'); buttons.append(link);
        if (file.source_path) {
          const original = el('button', 'Stáhnout originál', 'btn'); original.type = 'button';
          original.onclick = async () => {
            original.disabled = true;
            try {
              const result = await db().storage.from('invoice-sources').download(file.source_path);
              if (result.error || !result.data) throw new Error('Source unavailable');
              const url = URL.createObjectURL(result.data); const save = el('a');
              save.href = url; save.download = file.file_name; document.body.append(save); save.click(); save.remove();
              setTimeout(() => URL.revokeObjectURL(url), 30000);
            } catch { status.textContent = 'Uložený originál není dostupný. Ověř připojení nebo otevři soubor v Drive.'; }
            finally { original.disabled = false; }
          };
          buttons.append(original);
        }
        row.append(detail, buttons); files.append(row);
      }
      if (!files.children.length) files.textContent = 'Zatím žádné importované doklady.';
    } catch (error) { showError(error); }
    finally { refreshing = false; }
  }

  function codeBox(label, text) {
    const wrap = el('div'); const name = el('label', label);
    const box = el('textarea'); box.readOnly = true; box.value = text; box.rows = 6;
    const copy = el('button', 'Kopírovat', 'btn'); copy.type = 'button';
    copy.onclick = async () => { try { await navigator.clipboard.writeText(text); copy.textContent = 'Zkopírováno'; }
      catch { box.focus(); box.select(); copy.textContent = 'Označeno ke kopírování'; } };
    name.append(box); wrap.append(name, copy); return wrap;
  }

  function folderId(value) {
    value = value.trim();
    if (/^[A-Za-z0-9_-]{10,200}$/.test(value)) return value;
    try { const url = new URL(value); if (url.protocol === 'https:' && url.hostname === 'drive.google.com')
      return url.pathname.match(/^\/drive\/folders\/([A-Za-z0-9_-]{10,200})\/?$/)?.[1] || ''; } catch {}
    return '';
  }

  function addSetup() {
    setup.replaceChildren();
    const label = el('label', 'Odkaz na složku faktur'); const input = el('input'); input.type = 'url';
    input.placeholder = 'https://drive.google.com/drive/folders/…';
    const supplied = folderId(new URL(location.href).searchParams.get('driveFolder') || '');
    if (supplied) input.value = 'https://drive.google.com/drive/folders/' + supplied;
    label.append(input);
    const connect = el('button', 'Připravit propojení', 'btn btn-primary'); connect.type = 'button';
    const result = el('div');
    connect.onclick = async () => {
      const folder = folderId(input.value);
      if (!folder) { result.textContent = 'Vlož odkaz na konkrétní složku Google Drive.'; return; }
      connect.disabled = true;
      try {
        const [script, manifest] = await Promise.all(['../integrations/google-drive/Code.gs', '../integrations/google-drive/appsscript.json']
          .map(async path => { const response = await fetch(path); if (!response.ok) throw new Error('Setup unavailable'); return response.text(); }));
        const token = [...crypto.getRandomValues(new Uint8Array(32))].map(b => b.toString(16).padStart(2, '0')).join('');
        const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(token));
        const hash = [...new Uint8Array(digest)].map(b => b.toString(16).padStart(2, '0')).join('');
        const source = await command('connect', null, {folder_id: folder, secret_hash: hash});
        const properties = {PUB_GURU_ENDPOINT: window.PUB_GURU_CONFIG.supabaseUrl + '/functions/v1/invoice-drive-import',
          PUB_GURU_SOURCE: source.id, PUB_GURU_TOKEN: token};
        const configured = script + '\nfunction configurePubGuru() {\n  PropertiesService.getScriptProperties().setProperties(' +
          JSON.stringify(properties, null, 2) + ');\n  installPubGuru();\n}\n';
        result.replaceChildren();
        const steps = el('ol');
        ['Vytvoř soukromý projekt na script.google.com ve svém účtu Google.',
          'V nastavení projektu zapni zobrazení appsscript.json a nahraď jeho obsah níže uvedeným manifestem.',
          'Do Code.gs vlož připravený kód. Spusť configurePubGuru a potvrď oprávnění Google.',
          'Po úspěšném spuštění bude kontrola složky běžet přibližně každých 5 minut.'].forEach(text => steps.append(el('li', text)));
        result.append(steps, codeBox('appsscript.json', manifest), codeBox('Code.gs · soukromé propojení', configured),
          el('p', 'Kód ponech ve svém soukromém projektu. Nové vygenerování nahradí předchozí propojení.'));
        connect.textContent = 'Vygenerovat nové propojení';
        await refresh();
      } catch (error) { result.textContent = 'Propojení se nepodařilo připravit. Zkus jej znovu po obnovení připojení.'; }
      finally { connect.disabled = false; }
    };
    setup.append(el('p', 'Cíl importu: ' + ctx.venue.name + '. Přečtené doklady vždy čekají na ruční schválení.'), label, connect,
      el('p', 'Google vyžaduje jednorázový souhlas se čtením Drive. Skript ani importér soubory v Drive neupravují. Importér stahuje jen tuto složku; krátkodobý Google přístupový token neukládá.'), result);
  }

  async function init() {
    if (!document.getElementById('invoiceQueue')) return;
    ctx = await window.PubGuruBackend.loadContext();
    if (!ctx?.organization || !ctx?.venue) return;
    panel = el('section', null, 'panel'); panel.style.marginBottom = '16px'; panel.id = 'invoiceDrive';
    const heading = el('div', null, 'panel-head'); heading.append(el('h2', 'Automatický import z Drive'));
    status = el('p', 'Načítám stav importu…'); status.setAttribute('role', 'status'); status.setAttribute('aria-live', 'polite');
    sources = el('div'); files = el('div', null, 'queue-jobs'); setup = el('div');
    panel.append(heading, status, sources);
    if (manager()) {
      const details = el('details'); details.append(el('summary', 'Propojit složku faktur'), setup); panel.append(details); addSetup();
    }
    const guide = el('a', 'Jak předat faktury z iPhonu nebo iCloud alba');
    guide.href = '../integrations/google-drive/iphone.html'; panel.append(el('p'), guide, files);
    document.getElementById('invoiceQueue').after(panel);
    await refresh();
    clearInterval(timer); timer = setInterval(() => { if (!document.hidden) refresh(); }, 15000);
    window.addEventListener('online', refresh);
    document.addEventListener('visibilitychange', () => { if (!document.hidden) refresh(); });
  }
  window.PubGuruInvoiceDrive = {describe, folderId, connectionState};
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', () => init().catch(() => {}));
  else init().catch(() => {});
})();
