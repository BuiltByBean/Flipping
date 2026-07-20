/* Flips service worker — offline-first, stale-while-revalidate. */
const CACHE = 'flips-v1.17.0';
const CORE = [
  './',
  './index.html',
  './app.js',
  './manifest.webmanifest',
  './favicon.svg',
  './icons/icon-192.png',
  './icons/icon-512.png',
  './icons/icon-512-maskable.png',
  './icons/apple-touch-icon.png',
];

self.addEventListener('install', (e) => {
  // cache:'reload' is load-bearing. A plain addAll() may be served from the
  // browser's own HTTP cache, which would precache the OLD app.js into the NEW
  // cache — a version bump that silently ships stale code. Force the network.
  e.waitUntil(
    caches.open(CACHE)
      .then((c) => Promise.all(CORE.map((u) =>
        fetch(u, { cache: 'reload' }).then((res) => {
          if (res && res.ok) return c.put(u, res);
        })
      )))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('message', (e) => {
  if (e.data === 'SKIP_WAITING') self.skipWaiting();
});

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== location.origin) return;
  if (url.pathname.includes('/api/')) return; // sync API is always network

  e.respondWith((async () => {
    const cache = await caches.open(CACHE);
    const key = req.mode === 'navigate' ? './index.html' : req;
    const cached = await cache.match(key, { ignoreSearch: true });
    const network = fetch(req)
      .then((res) => {
        if (res && res.ok) cache.put(key, res.clone());
        return res;
      })
      .catch(() => null);
    if (cached) {
      network; // refresh in the background for next launch
      return cached;
    }
    const net = await network;
    if (net) return net;
    if (req.mode === 'navigate') {
      const fallback = await cache.match('./index.html');
      if (fallback) return fallback;
    }
    return Response.error();
  })());
});
