(function (root) {
  'use strict';
  let db, channel;
  const DB_NAME = 'pub-bizz-pos-v1';
  const clone = x => structuredClone(x);
  function transaction(mode) {
    try { return db.transaction('state', mode, { durability: 'strict' }); }
    catch { return db.transaction('state', mode); }
  }
  function update(fn) {
    return new Promise((resolve, reject) => {
      const tx = transaction('readwrite'); const os = tx.objectStore('state'); let next, result, failure;
      const request = os.get('current');
      request.onsuccess = () => {
        try { next = request.result ? clone(request.result) : POSCore.initial(); result = fn(next); os.put(next, 'current'); }
        catch (e) { failure = e; tx.abort(); }
      };
      tx.oncomplete = () => { channel?.postMessage('updated'); resolve({ state: next, result }); };
      tx.onerror = tx.onabort = () => reject(failure || tx.error || new Error('Data se nepodařilo uložit. Zkontroluj volné místo.'));
    });
  }
  async function open(onChange) {
    if (!root.indexedDB) throw new Error('Prohlížeč nemá dostupné úložiště. Použij běžné okno Chrome nebo Edge.');
    db = await new Promise((resolve, reject) => {
      const r = indexedDB.open(DB_NAME, 1);
      r.onupgradeneeded = () => r.result.createObjectStore('state');
      r.onsuccess = () => resolve(r.result); r.onerror = () => reject(r.error);
      r.onblocked = () => reject(new Error('Zavři ostatní okna pokladny a obnov stránku.'));
    });
    if (root.BroadcastChannel) { channel = new BroadcastChannel(DB_NAME); channel.onmessage = onChange; }
    const initialized = await update(s => { if (s.catalogVersion !== POSCatalog.version) POSCore.execute(s, 'loadCatalog'); }); return initialized.state;
  }
  const read = () => new Promise((resolve, reject) => {
    const tx = transaction('readonly'); const r = tx.objectStore('state').get('current');
    r.onsuccess = () => resolve(r.result); r.onerror = () => reject(r.error);
  });
  async function restore(incoming) {
    POSCore.validate(incoming);
    return update(s => {
      if (s.receipts.length || s.orders.some(x => x.lines.length) || POSCore.activeShift(s)) throw new Error('Obnova je možná jen v prázdné pokladně bez otevřené směny. Existující tržby nelze přepsat.');
      for (const k of Object.keys(s)) delete s[k]; Object.assign(s, clone(incoming));
      s.audit.push({ id: crypto.randomUUID(), at: new Date().toISOString(), type: 'restore', operator: s.settings.operator, detail: {} }); s.revision++;
    });
  }
  root.POSStore = { open, read, restore, command: (type, payload) => update(s => POSCore.execute(s, type, payload)) };
})(globalThis);
