// Service worker for Kickball Walk-On Music.
//
// Why this exists: "Add to Home Screen" only bookmarks a URL -- it does not
// freeze a copy of the page. If the phone has no network at the park when
// the app is relaunched, the browser has nothing to re-fetch unless a
// service worker has explicitly cached it. This is what makes the
// self-contained single-file design (01-Architecture.md, firm principle 2)
// actually hold at runtime, not just at build time.
//
// CACHE_NAME is derived from a hash of the full rendered index.html (see
// build.py -- hashing only the manifest+clips payload was a real bug: a
// code-only fix would never bust an already-cached phone), so every real
// change gets a new cache name -- old caches are deleted on activate, and
// the next online launch re-fetches the new index.html automatically
// (matches the documented update flow: "re-open the app on Wi-Fi once to
// pick up the new version").

const CACHE_NAME = 'kickball-__CACHE_ID__';
const PRECACHE_URLS = ['./', './index.html'];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(PRECACHE_URLS))
  );
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  if (event.request.method !== 'GET') return;
  event.respondWith(
    caches.match(event.request).then((cached) => {
      if (cached) return cached;
      return fetch(event.request)
        .then((response) => {
          const copy = response.clone();
          caches.open(CACHE_NAME).then((cache) => cache.put(event.request, copy));
          return response;
        })
        .catch(() => caches.match('./index.html'));
    })
  );
});
