const CACHE = 'pub-bizz-pos-shell-1.0.2';
const SHELL = ['./', './index.html', './style.css', './catalog.js', './core.js', './storage.js', './app.js', './icon.svg', './manifest.webmanifest'];
self.addEventListener('install', event => event.waitUntil(caches.open(CACHE).then(cache => cache.addAll(SHELL))));
self.addEventListener('activate', event => event.waitUntil((async () => {
  for (const key of await caches.keys()) if (key.startsWith('pub-bizz-pos-shell-') && key !== CACHE) await caches.delete(key);
  await self.clients.claim();
})()));
self.addEventListener('fetch', event => {
  if (event.request.method !== 'GET' || new URL(event.request.url).origin !== self.location.origin) return;
  event.respondWith((async () => {
    const cache = await caches.open(CACHE);
    const hit = await cache.match(event.request, {ignoreSearch:true});
    if (hit) return hit;
    try { return await fetch(event.request); }
    catch (e) { if (event.request.mode === 'navigate') return await cache.match('./index.html'); throw e; }
  })());
});
