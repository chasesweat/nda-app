// NWDA app service worker
// Network-first for the app shell so a new deploy ALWAYS loads (fixes the "still shows the
// old version after I upload" problem), with an offline cache fallback. Assets are cached
// stale-while-revalidate. Push notifications are handled separately by firebase-messaging-sw.js.

// IMPORTANT: bump this version string on EVERY deploy. Changing sw.js's bytes is what makes
// the browser reinstall the worker, wipe the old cache, and pull the newest app. (Paired with
// app build 202607161558.)
// VERSIONING RULE: the visible build number (hamburger menu, last 3 digits of index.html's
// <meta name="version"> tag) is always this cache number PLUS 409. Bump both by exactly 1
// together on every single deploy — never skip, never jump. Current: cache v149 = build 558.
const CACHE = 'nwda-cache-v149';

// Take over immediately on install.
self.addEventListener('install', function (e) {
  self.skipWaiting();
});

// Clean out old caches and control open pages right away.
self.addEventListener('activate', function (e) {
  e.waitUntil(
    caches.keys()
      .then(function (keys) {
        return Promise.all(
          keys.filter(function (k) { return k !== CACHE; })
              .map(function (k) { return caches.delete(k); })
        );
      })
      .then(function () { return self.clients.claim(); })
  );
});

// Let the page tell a waiting worker to activate now (works with the app's auto-update code).
self.addEventListener('message', function (e) {
  if (e.data && e.data.type === 'SKIP_WAITING') { self.skipWaiting(); }
});

self.addEventListener('fetch', function (e) {
  const req = e.request;
  if (req.method !== 'GET') return;

  let url;
  try { url = new URL(req.url); } catch (_e) { return; }
  if (url.origin !== self.location.origin) return; // don't touch Firebase/Google/CDN requests

  const isHTML = req.mode === 'navigate' ||
    (req.headers.get('accept') || '').indexOf('text/html') !== -1;

  if (isHTML) {
    // NETWORK-FIRST for the app itself → newest deploy wins; cache is only an offline fallback.
    e.respondWith(
      fetch(req)
        .then(function (res) {
          const copy = res.clone();
          caches.open(CACHE).then(function (c) { c.put(req, copy); });
          return res;
        })
        .catch(function () {
          return caches.match(req).then(function (m) {
            return m || caches.match('./index.html');
          });
        })
    );
    return;
  }

  // STALE-WHILE-REVALIDATE for other assets (icons, images, fonts).
  e.respondWith(
    caches.match(req).then(function (cached) {
      const net = fetch(req)
        .then(function (res) {
          if (res && res.status === 200) {
            const copy = res.clone();
            caches.open(CACHE).then(function (c) { c.put(req, copy); });
          }
          return res;
        })
        .catch(function () { return cached; });
      return cached || net;
    })
  );
});

// When a notification is tapped, tell the open app to deep-link, then focus/open it.
self.addEventListener('notificationclick', function (e) {
  e.notification.close();
  const data = (e.notification && e.notification.data) || {};
  e.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then(function (list) {
      for (let i = 0; i < list.length; i++) {
        const c = list[i];
        try { c.postMessage({ type: 'notification-click', data: data }); } catch (_e) {}
        if ('focus' in c) return c.focus();
      }
      if (self.clients.openWindow) return self.clients.openWindow('./');
    })
  );
});
