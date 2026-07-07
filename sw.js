// NWDA Driver Portal service worker — network-first, always-fresh app shell.
const CACHE = 'nwda-v4';
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
    badge: 'data:image/png;base64,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',
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
