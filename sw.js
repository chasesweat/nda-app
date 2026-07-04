// NWDA Driver Portal service worker — network-first, always-fresh app shell.
const CACHE = 'nwda-v3';
const CORE = ['./'];
self.addEventListener('install', (e) => {
  self.skipWaiting();
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(CORE).catch(() => {})));
});
self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});
self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;                 // never touch Firebase writes etc.

  // The app shell / page navigations: bypass the browser HTTP cache so a fresh
  // deploy is picked up on the very next launch. Fall back to cache only offline.
  const isPage = req.mode === 'navigate' ||
                 (req.headers.get('accept') || '').includes('text/html');
  if (isPage) {
    e.respondWith(
      fetch(req, { cache: 'no-store' })
        .then((res) => {
          if (res && res.status === 200 && req.url.startsWith(self.location.origin)) {
            const copy = res.clone();
            caches.open(CACHE).then((c) => c.put(req, copy).catch(() => {}));
          }
          return res;
        })
        .catch(() => caches.match(req).then((r) => r || caches.match('./')))
    );
    return;
  }

  // Everything else (icons, etc.): network-first with cache fallback (unchanged).
  e.respondWith(
    fetch(req)
      .then((res) => {
        if (res && res.status === 200 && req.url.startsWith(self.location.origin)) {
          const copy = res.clone();
          caches.open(CACHE).then((c) => c.put(req, copy).catch(() => {}));
        }
        return res;
      })
      .catch(() => caches.match(req).then((r) => r || caches.match('./')))
  );
});
// ── Tapping a notification: deep-link into the app ──
self.addEventListener('notificationclick', (e) => {
  e.notification.close();
  const data = e.notification.data || {};
  const url = data.url || './';
  e.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((list) => {
      // Reuse an already-open app window if there is one
      for (const client of list) {
        if ('focus' in client) {
          client.focus();
          // Hand the routing info to the page — it deep-links in place (no reload).
          try { client.postMessage({ type: 'notification-click', url: url, data: data, tag: e.notification.tag }); } catch (_) {}
          return;
        }
      }
      // Otherwise launch a fresh window at the deep-link URL (./?nride=<id> etc.)
      if (self.clients.openWindow) return self.clients.openWindow(url);
    })
  );
});
// ── Background push (only used if FCM/Web Push is wired up later) ──
// Harmless today: with no push subscription this never fires. When real push is
// enabled, the sender should target ONE driver's device token so only that driver
// is notified — not everyone.
self.addEventListener('push', (e) => {
  let data = {};
  try { data = e.data ? e.data.json() : {}; }
  catch (_) { data = { title: 'Northwest Drivers', body: e.data ? e.data.text() : '' }; }
  const title = data.title || 'Northwest Drivers';
  const opts = {
    body: data.body || '',
    icon: 'icon-192.png',
    badge: 'icon-192.png',
    tag: data.tag || ('nwda-' + Date.now()),
    data: {
      url: data.url || (data.rideId ? ('./?nride=' + encodeURIComponent(data.rideId)) : './'),
      rideId: data.rideId || null,
      channel: data.channel || null,
      type: data.type || ''
    }
  };
  e.waitUntil(self.registration.showNotification(title, opts));
});
