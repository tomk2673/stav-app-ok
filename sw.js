// Retire the first POS service worker that was installed at the site root.
// Business data in IndexedDB and localStorage must remain available for export.
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', event => event.waitUntil((async () => {
  await caches.delete('pub-bizz-pos-shell-1.0.0');
  await self.clients.claim();
  await self.registration.unregister();
})()));
