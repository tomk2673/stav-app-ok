const CACHE = 'pub-guru-shell-v5';
const APP_SHELL = [
  './', './start.html', './index.html', './invoice-review.html', './closings.html', './styles.css', './app.js',
  './closings.js', './invoice-review.js', './backend.js', './roles.js', './navigation.js', './data-sync.js',
  './operations-backend.js', './invoice-backend.js', './invoice-ui-guard.js', './closing-role-guard.js',
  './app-config.js', './manifest.webmanifest', './icon-192.png', './icon-512.png'
];
self.addEventListener('install', event => event.waitUntil(caches.open(CACHE).then(c => c.addAll(APP_SHELL))));
self.addEventListener('activate', event => event.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k))))));
self.addEventListener('fetch', event => {
  if (event.request.method !== 'GET') return;
  event.respondWith(caches.match(event.request).then(hit => hit || fetch(event.request).then(res => {
    if (new URL(event.request.url).origin === location.origin) {
      const copy = res.clone(); caches.open(CACHE).then(c => c.put(event.request, copy));
    }
    return res;
  }).catch(() => caches.match('./start.html'))));
});
