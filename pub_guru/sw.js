const CACHE = 'pub-guru-shell-v7-pos';
const APP_SHELL = [
  './', './start.html', './index.html', './invoice-review.html', './closings.html', './styles.css', './app.js',
  './closings.js', './invoice-review.js', './backend.js', './roles.js', './navigation.js', './data-sync.js',
  './operations-backend.js', './invoice-backend.js', './invoice-ui-guard.js', './closing-role-guard.js',
  './app-config.js', './manifest.webmanifest', './icon-192.png', './icon-512.png'
];
self.addEventListener('install', event => event.waitUntil(caches.open(CACHE).then(c => c.addAll(APP_SHELL)).then(()=>self.skipWaiting())));
self.addEventListener('activate', event => event.waitUntil((async()=>{
  await Promise.all((await caches.keys()).filter(k=>k.startsWith('pub-guru-shell-')&&k!==CACHE).map(k=>caches.delete(k)));
  await self.clients.claim();
})()));
self.addEventListener('fetch', event => {
  if (event.request.method !== 'GET' || new URL(event.request.url).origin !== self.location.origin) return;
  event.respondWith((async()=>{
    const cache=await caches.open(CACHE),hit=await cache.match(event.request);
    if(hit)return hit;
    try {const res=await fetch(event.request);if(res.ok)await cache.put(event.request,res.clone());return res;}
    catch(error){if(event.request.mode==='navigate')return await cache.match('./start.html');throw error;}
  })());
});
