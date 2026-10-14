const CACHE = 'pub-bizz-pos-shell-2.0.12';
const SHELL = ['./index.html', './style.css', './compat.js', './catalog.js', './core.js', './customer.js', './storage.js', './app.js', './config.js', './cloud.js', './stock.js', './vendor/supabase-2.117.2.js', './icon.svg', './manifest.webmanifest'];
// Safari rejects a followed/cached redirect returned for a manual navigation.
// Keep the final HTML and its security headers, without the redirect URL list.
const navigationResponse = response => response?.redirected ? new Response(response.body, {status:response.status, statusText:response.statusText, headers:response.headers}) : response;
self.addEventListener('install', event => event.waitUntil(caches.open(CACHE).then(cache => cache.addAll(SHELL)).then(() => self.skipWaiting())));
self.addEventListener('activate', event => event.waitUntil((async () => {
  for (const key of await caches.keys()) if (key.startsWith('pub-bizz-pos-shell-') && key !== CACHE) await caches.delete(key);
  await self.clients.claim();
})()));
self.addEventListener('fetch', event => {
  if (event.request.method !== 'GET' || new URL(event.request.url).origin !== self.location.origin) return;
  event.respondWith((async () => {
    const cache = await caches.open(CACHE);
    const hit = await cache.match(event.request, {ignoreSearch:true});
    const navigation = event.request.mode === 'navigate';
    if (hit) return navigation ? navigationResponse(hit) : hit;
    try { const response = await fetch(event.request, navigation ? {redirect:'follow'} : undefined); return navigation ? navigationResponse(response) : response; }
    catch (e) { if (navigation) { const fallback = await cache.match('./index.html'); if (fallback) return navigationResponse(fallback); } throw e; }
  })());
});

