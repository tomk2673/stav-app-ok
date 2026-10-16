export const MAX_BYTES = 8 * 1024 * 1024;
const GOOGLE = 'https://www.googleapis.com/drive/v3/files';
const ID = /^[A-Za-z0-9_-]{10,200}$/;
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
const messages = {
  drive_auth: 'Google přístup vypršel. Spusť znovu installPubGuru ve svém Google účtu.',
  drive_permission: 'Google nepovolil čtení složky nebo dokladu. Ověř účet a oprávnění.',
  drive_unavailable: 'Google Drive není dostupný. Import se zopakuje.',
  file_changed: 'Doklad se během stahování změnil nebo byl přesunut. Import se zopakuje.',
  document_too_large: 'Originál přesahuje 8 MB. Ulož menší fotografii nebo rozděl PDF.',
  invalid_format: 'Soubor není platný JPG, HEIC/HEIF nebo PDF.',
  integrity_conflict: 'Uložený originál nesouhlasí s otiskem. Vyžaduje kontrolu správce.',
  storage_unavailable: 'Uložení originálu není dostupné. Import se zopakuje.',
  import_unavailable: 'Import není dostupný. Doklad zůstává v Drive a pokus se zopakuje.',
  cursor_reset: 'Seznam souborů se změnil. Příští kontrola začne od začátku.'
};
class ImportError extends Error {
  constructor(code, status = 502) { super(messages[code] || messages.import_unavailable); this.code = code; this.status = status; }
}
export async function sha256(bytes) {
  const hash = await crypto.subtle.digest('SHA-256', bytes);
  return Array.from(new Uint8Array(hash), b => b.toString(16).padStart(2, '0')).join('');
}
export function detectMime(bytes) {
  if (bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255) return 'image/jpeg';
  const ascii = new TextDecoder().decode(bytes.slice(0, 64));
  if (ascii.startsWith('%PDF-')) return 'application/pdf';
  if (ascii.slice(4, 8) === 'ftyp' && /heic|heix|hevc|hevx|heim|heis/.test(ascii.slice(8))) return 'image/heic';
  return null;
}
async function bounded(response, max) {
  if (Number(response.headers.get('content-length')) > max) {
    await response.body?.cancel(); throw new ImportError('document_too_large', 413);
  }
  const reader = response.body?.getReader();
  if (!reader) return new Uint8Array();
  const chunks = []; let size = 0;
  try {
    for (;;) {
      const {done, value} = await reader.read();
      if (done) break;
      size += value.length;
      if (size > max) throw new ImportError('document_too_large', 413);
      chunks.push(value);
    }
  } catch (error) { await reader.cancel().catch(() => {}); throw error; }
  finally { reader.releaseLock(); }
  const bytes = new Uint8Array(size); let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
  return bytes;
}
const candidate = file => !String(file.mimeType || '').startsWith('application/vnd.google-apps.') &&
  (/\.(jpe?g|heic|heif|pdf)$/i.test(file.name || '') ||
  ['image/jpeg', 'image/heic', 'image/heif', 'application/pdf'].includes(file.mimeType));
const response = (status, body) => new Response(JSON.stringify(body), {
  status, headers: {'Content-Type': 'application/json', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff'}
});

export function createHandler(env, dependencies = {}) {
  const fetcher = dependencies.fetch || fetch;
  const clock = dependencies.now || Date.now;
  const base = env.supabaseUrl.replace(/\/$/, '');
  const serviceHeaders = {apikey: env.serviceKey, Authorization: 'Bearer ' + env.serviceKey};

  async function network(url, init, timeout = 20000) {
    const signal = AbortSignal.timeout(timeout);
    return fetcher(url, {...init, signal, redirect: 'error'});
  }

  return async function handle(request) {
    if (request.method !== 'POST') return response(405, {error: 'method_not_allowed'});
    const capability = request.headers.get('authorization')?.match(/^Bearer ([a-f0-9]{64})$/)?.[1];
    if (!capability) return response(401, {error: 'import_authorization_required'});
    let input;
    try {
      input = JSON.parse(new TextDecoder().decode(await bounded(request, 20000)));
      if (!input || !['sync', 'probe'].includes(input.action) || !UUID.test(input.source_id) ||
        typeof input.google_token !== 'string' || input.google_token.length < 10 || input.google_token.length > 16000 ||
        /[\r\n]/.test(input.google_token)) return response(400, {error: 'invalid_request'});
    } catch { return response(400, {error: 'invalid_request'}); }

    const secretHash = await sha256(new TextEncoder().encode(capability));
    let lease = null, connected = false;
    async function rpc(action, payload = {}) {
      let answer;
      try {
        answer = await network(base + '/rest/v1/rpc/invoice_drive_worker', {
          method: 'POST', headers: {...serviceHeaders, 'Content-Type': 'application/json'},
          body: JSON.stringify({p_action: action, p_source_id: input.source_id, p_secret_hash: secretHash,
            p_token: lease?.lease_token || null, p_payload: payload})
        });
      } catch { throw new ImportError('import_unavailable'); }
      if (!answer.ok) {
        const data = await answer.json().catch(() => ({}));
        if (data.code === '42501') throw new ImportError('import_authorization_failed', 401);
        throw new ImportError('import_unavailable');
      }
      const data = await answer.json();
      if (data?.authorization_revoked) throw new ImportError('import_authorization_failed', 403);
      return data;
    }
    async function drive(id = '', parameters = {}, media = false) {
      if (id && !ID.test(id)) throw new ImportError('invalid_format', 400);
      const url = new URL(GOOGLE + (id ? '/' + encodeURIComponent(id) : ''));
      for (const [key, value] of Object.entries(parameters)) if (value != null) url.searchParams.set(key, value);
      let answer;
      try { answer = await network(url.href, {headers: {Authorization: 'Bearer ' + input.google_token}}); }
      catch { throw new ImportError('drive_unavailable'); }
      if (!answer.ok) {
        if (answer.status === 401) throw new ImportError('drive_auth', 401);
        if ([403, 404].includes(answer.status)) throw new ImportError('drive_permission', 403);
        if (answer.status === 400 && parameters.pageToken) throw new ImportError('cursor_reset', 409);
        throw new ImportError('drive_unavailable');
      }
      return media ? bounded(answer, MAX_BYTES) : answer.json();
    }
    async function metadata(id) {
      return drive(id, {supportsAllDrives: 'true', fields: 'id,name,mimeType,size,version,parents,trashed,sha256Checksum'});
    }
    async function storeOriginal(path, bytes, mime) {
      const url = base + '/storage/v1/object/invoice-sources/' + path;
      let stored;
      try {
        stored = await network(url, {method: 'POST', headers: {...serviceHeaders, 'Content-Type': mime, 'x-upsert': 'false'}, body: bytes});
        if (stored.ok) return;
        const conflict = await stored.json().catch(() => ({}));
        if (stored.status !== 409 && String(conflict.statusCode) !== '409' && conflict.error !== 'Duplicate') {
          throw new ImportError('storage_unavailable');
        }
        // A crash may leave an uploaded object. Never delete or overwrite it on replay.
        const saved = await network(base + '/storage/v1/object/authenticated/invoice-sources/' + path, {headers: serviceHeaders});
        if (!saved.ok) throw new ImportError('storage_unavailable');
        if (await sha256(await bounded(saved, MAX_BYTES)) !== await sha256(bytes)) throw new ImportError('integrity_conflict');
      } catch (error) { throw error instanceof ImportError ? error : new ImportError('storage_unavailable'); }
    }
    try {
      lease = await rpc('start');
      if (lease.busy) { lease = null; return response(200, {busy: true, has_more: false}); }
      const folder = await drive(lease.folder_id, {fields: 'id,mimeType,trashed', supportsAllDrives: 'true'});
      if (folder.id !== lease.folder_id || folder.trashed || folder.mimeType !== 'application/vnd.google-apps.folder') {
        throw new ImportError('drive_permission', 403);
      }
      connected = true;
      if (input.action === 'probe') {
        await rpc('end', {connected: true}); lease = null;
        return response(200, {connected: true});
      }
      const listPage = pageToken => drive('', {q: "'" + lease.folder_id + "' in parents and trashed = false",
        spaces: 'drive', pageSize: '5', pageToken, orderBy: 'modifiedTime desc,name',
        supportsAllDrives: 'true', includeItemsFromAllDrives: 'true',
        fields: 'nextPageToken,incompleteSearch,files(id,name,mimeType,version)'});
      // Always inspect recent files, even while a large folder's older pages are scanned.
      const recent = await listPage(null);
      const page = lease.page_token ? await listPage(lease.page_token) : recent;
      if (page.incompleteSearch || recent.incompleteSearch) throw new ImportError('drive_unavailable');
      const seen = new Set();
      const candidates = [...(recent.files || []), ...(page.files || [])].filter(file => {
        const key = file.id + ':' + file.version;
        if (seen.has(key)) return false;
        seen.add(key); return true;
      });
      const results = []; const started = clock(); let finishedPage = true;
      for (const file of candidates) {
        // Keep the cursor on this page if the function approaches its execution budget.
        if (clock() - started > 65000) { finishedPage = false; break; }
        if (!candidate(file)) continue;
        const item = await rpc('reserve', {id: file.id, version: file.version, name: String(file.name).slice(0, 500), mime_type: file.mimeType});
        if (item.skip) continue;
        try {
          const before = await metadata(file.id);
          if (before.id !== file.id || before.trashed || !before.parents?.includes(lease.folder_id) || before.version !== file.version) {
            throw new ImportError('file_changed');
          }
          if (Number(before.size) > MAX_BYTES) throw new ImportError('document_too_large', 413);
          const bytes = await drive(file.id, {alt: 'media', supportsAllDrives: 'true'}, true);
          const mime = detectMime(bytes);
          if (!mime) throw new ImportError('invalid_format', 400);
          const fingerprint = await sha256(bytes);
          if (before.sha256Checksum && before.sha256Checksum.toLowerCase() !== fingerprint) throw new ImportError('file_changed');
          const after = await metadata(file.id);
          if (after.version !== before.version || after.trashed || !after.parents?.includes(lease.folder_id)) throw new ImportError('file_changed');
          const duplicate = await rpc('duplicate', {fingerprint});
          if (!duplicate.cross_venue) {
            const ext = {'image/jpeg': 'jpg', 'image/heic': 'heic', 'application/pdf': 'pdf'}[mime];
            const path = `${lease.organization_id}/${lease.venue_id}/${lease.created_by}/drive/${fingerprint}.${ext}`;
            await storeOriginal(path, bytes, mime);
          }
          results.push(await rpc('enqueue', {file_id: item.id, fingerprint, mime_type: mime, uploaded: !duplicate.cross_venue}));
        } catch (error) {
          // If enqueue committed but its response was lost, fail is an idempotent no-op.
          const code = error instanceof ImportError ? error.code : 'import_unavailable';
          results.push(await rpc('fail', {file_id: item.id, error: messages[code] || messages.import_unavailable}));
          if (['drive_auth', 'drive_permission', 'import_authorization_failed'].includes(code)) throw error;
        }
      }
      const next = finishedPage ? (page.nextPageToken || null) : (lease.page_token || null);
      await rpc('end', {connected, page_token: next, complete: finishedPage && !next});
      lease = null;
      return response(200, {results, has_more: !finishedPage || !!next});
    } catch (error) {
      const code = error instanceof ImportError ? error.code : 'import_unavailable';
      if (lease?.lease_token) {
        const payload = {connected, error: messages[code] || messages.import_unavailable};
        if (code === 'cursor_reset') payload.page_token = null;
        await rpc('end', payload).catch(() => {});
      }
      // No provider responses, tokens, filenames or request bodies are logged or echoed.
      return response(error instanceof ImportError ? error.status : 502, {error: code});
    }
  };
}
