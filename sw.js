// NWDA app service worker
// Network-first for the app shell so a new deploy ALWAYS loads (fixes the "still shows the
// old version after I upload" problem), with an offline cache fallback. Assets are cached
// stale-while-revalidate. Push notifications are handled separately by firebase-messaging-sw.js.

// IMPORTANT: bump this version string on EVERY deploy. Changing sw.js's bytes is what makes
// the browser reinstall the worker, wipe the old cache, and pull the newest app. (Paired with
// app build 202607171577.)
// VERSIONING RULE: the visible build number (hamburger menu, last 3 digits of index.html's
// <meta name="version"> tag) is always this cache number PLUS 409. Bump both by exactly 1
// together on every single deploy — never skip, never jump. Current: cache v168 = build 577.
const CACHE = 'nwda-cache-v168';

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

// Pull the build stamp out of a raw index.html string. Same tag the app's own _appBuildTag()
// reads, so "did this change" here means exactly what it means in the hamburger menu.
function versionOf(html) {
  try {
    const m = /<meta\s+name=["']version["']\s+content=["']([^"']+)["']/i.exec(html || '');
    return m ? m[1] : '';
  } catch (_e) { return ''; }
}

// Tell every open tab a newer build is now cached and ready. The page decides what to do —
// the worker does not force anything, because a reload underneath someone mid-form is worse
// than being one build behind for another minute.
function announceUpdate(version) {
  self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then(function (list) {
    list.forEach(function (c) {
      try { c.postMessage({ type: 'app-update-ready', version: version }); } catch (_e) {}
    });
  });
}

self.addEventListener('fetch', function (e) {
  const req = e.request;
  if (req.method !== 'GET') return;

  let url;
  try { url = new URL(req.url); } catch (_e) { return; }
  if (url.origin !== self.location.origin) return; // don't touch Firebase/Google/CDN requests

  const isHTML = req.mode === 'navigate' ||
    (req.headers.get('accept') || '').indexOf('text/html') !== -1;

  if (isHTML) {
    // STALE-WHILE-REVALIDATE for the app shell.
    //
    // This used to be NETWORK-FIRST, which meant every single launch re-downloaded the whole
    // ~3MB index.html before rendering anything — roughly 10 seconds on mobile data, every
    // time. That was the price of guaranteeing a new deploy always won.
    //
    // It's no longer a price worth paying, because network-first is now REDUNDANT. It was
    // added back when the app had no update mechanism at all. The app has since grown a real
    // one (registerSW: reg.update() on load + hourly → updatefound → SKIP_WAITING →
    // controllerchange → reload), which catches every deploy on its own — provided sw.js's
    // bytes change, which the mandatory cache-version bump guarantees.
    //
    // "Provided" is doing real work in that sentence, so this does NOT rely on it alone.
    // Version drift is documented in the handoff twice already (sw.js's own comment ran 16
    // builds stale; so did the handoff header). If someone ships index.html and forgets to
    // bump sw.js, the worker never reinstalls and the auto-update path never fires. So the
    // background revalidate below independently compares the freshly-fetched HTML's version
    // meta against the cached one, and tells the page to reload when they differ. Belt and
    // braces, without the 10-second tax.
    e.respondWith(
      caches.open(CACHE).then(function (c) {
        return c.match(req).then(function (cached) {
          const net = fetch(req)
            .then(function (res) {
              if (!res || res.status !== 200) return res;
              const forCache = res.clone();
              const forCheck = res.clone();
              // Only announce the update AFTER it's safely in the cache — otherwise a reload
              // could race the put(), serve the old copy again, and fire a second reload.
              c.put(req, forCache).then(function () {
                if (!cached) return; // first ever load: nothing to compare against
                return Promise.all([cached.clone().text(), forCheck.text()])
                  .then(function (t) {
                    const was = versionOf(t[0]);
                    const now = versionOf(t[1]);
                    if (was && now && was !== now) announceUpdate(now);
                  })
                  .catch(function () { /* comparison is best-effort; never break the fetch */ });
              }).catch(function () {});
              return res;
            })
            .catch(function () {
              return cached || caches.match('./index.html');
            });
          // Cached copy renders immediately; the network copy lands in the cache for next time.
          return cached || net;
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
