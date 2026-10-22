const CACHE = 'pub-guru-shell-v12-invoice-money-queue-navigation';
const APP_SHELL = [
  './start.html', './index.html', './invoice-review.html', './closings.html', './styles.css', './app.js',
  './invoice-numbers.js', './invoice-review-v1.html', './invoice-review-v2.js', './invoice-capture.html', './invoice-capture-v3.js', './ai-accountant.js', './closings.js', './invoice-review.js', './backend.js', './roles.js', './navigation.js', './data-sync.js',
  './operations-backend.js', './invoice-backend.js', './invoice-ui-guard.js', './closing-role-guard.js',
  './app-config.js', './manifest.webmanifest', './icon-192.png', './icon-512.png'
];
const navigationResponse = response => response?.redirected ? new Response(response.body, {status:response.status, statusText:response.statusText, headers:response.headers}) : response;
self.addEventListener('install', event => event.waitUntil(caches.open(CACHE).then(c => c.addAll(APP_SHELL)).then(()=>self.skipWaiting())));
self.addEventListener('activate', event => event.waitUntil((async()=>{
  await Promise.all((await caches.keys()).filter(k=>k.startsWith('pub-guru-shell-')&&k!==CACHE).map(k=>caches.delete(k)));
  await self.clients.claim();
})()));
self.addEventListener('fetch', event => {
  if (event.request.method !== 'GET' || new URL(event.request.url).origin !== self.location.origin) return;
  event.respondWith((async()=>{
    const cache=await caches.open(CACHE),hit=await cache.match(event.request);
    const navigation=event.request.mode==='navigate';
    const fresh=/\.(?:html|js)$/.test(new URL(event.request.url).pathname)||navigation;
    if(hit&&!fresh)return hit;
    try {let res=await fetch(event.request,navigation?{redirect:'follow'}:undefined);if(navigation)res=navigationResponse(res);if(res.ok)await cache.put(event.request,res.clone());return res;}
    catch(error){if(hit)return navigation?navigationResponse(hit):hit;if(navigation){const fallback=await cache.match('./start.html');if(fallback)return navigationResponse(fallback);}throw error;}
  })());
});
