// NWDA App — Service Worker
// Version: 20260602-0120 — auto-updated
const CACHE_NAME = 'nwda-app-202606020120';

// Files to cache for offline use
const CACHE_URLS = [
  '/nda-app/',
  '/nda-app/index.html',
];

// ── INSTALL: cache core files ──
self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(CACHE_NAME).then(cache => {
      return cache.addAll(CACHE_URLS).catch(err => {
        console.warn('Cache addAll partial failure:', err);
      });
    })
  );
  self.skipWaiting();
});

// ── ACTIVATE: delete ALL old caches immediately ──
self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys().then(keys =>
      Promise.all(keys.map(k => {
        if(k !== CACHE_NAME){
          console.log('SW: deleting old cache', k);
          return caches.delete(k);
        }
      }))
    ).then(() => self.clients.claim())
  );
});

// ── FETCH: network first for HTML, cache for assets ──
self.addEventListener('fetch', event => {
  if(event.request.method !== 'GET') return;
  const url = event.request.url;

  // Never cache Firebase, Maps, or API calls
  if(url.includes('firebaseio.com') || url.includes('googleapis.com/maps') ||
     url.includes('gstatic.com/firebasejs') || url.includes('fueleconomy.gov') ||
     url.includes('square.link')){
    return;
  }

  // Network-first for HTML — always get the latest index.html
  if(url.includes('index.html') || url.endsWith('/nda-app/') || url.endsWith('/nda-app')){
    event.respondWith(
      fetch(event.request).then(response => {
        const clone = response.clone();
        caches.open(CACHE_NAME).then(cache => cache.put(event.request, clone));
        return response;
      }).catch(() => caches.match(event.request))
    );
    return;
  }

  // Cache-first for icons and other assets
  event.respondWith(
    caches.match(event.request).then(cached => {
      return cached || fetch(event.request).then(response => {
        if(response.ok){
          const clone = response.clone();
          caches.open(CACHE_NAME).then(cache => cache.put(event.request, clone));
        }
        return response;
      }).catch(() => cached);
    })
  );
});

// ── PUSH NOTIFICATIONS ──
self.addEventListener('push', event => {
  let data = { title: 'NDA', body: 'You have a new notification' };
  try {
    if(event.data) data = event.data.json();
  } catch(e) {
    if(event.data) data.body = event.data.text();
  }
  const options = {
    body: data.body || '',
    icon: 'icon-192.png',
    badge: 'icon-72.png',
    vibrate: [200, 100, 200],
    data: { url: data.url || '/' },
    tag: data.tag || 'nda-notification',
  };
  event.waitUntil(self.registration.showNotification(data.title, options));
});

// ── NOTIFICATION CLICK ──
self.addEventListener('notificationclick', event => {
  event.notification.close();
  if(event.action === 'dismiss') return;
  const targetUrl = event.notification.data?.url || '/';
  event.waitUntil(
    clients.matchAll({ type: 'window', includeUncontrolled: true }).then(windowClients => {
      for(const client of windowClients){
        if(client.url.includes('nda-app') && 'focus' in client) return client.focus();
      }
      if(clients.openWindow) return clients.openWindow('https://chasesweat.github.io/nda-app');
    })
  );
});
