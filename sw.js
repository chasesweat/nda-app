// NWDA App — Service Worker
// Version: 1.0 — update this number when you deploy changes
const CACHE_NAME = 'nwda-app-v1';

// Files to cache for offline use
const CACHE_URLS = [
  '/',
  '/index.html',
  'https://fonts.googleapis.com/css2?family=DM+Sans:wght@300;400;500;600&family=Playfair+Display:wght@700&display=swap',
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

// ── ACTIVATE: clean up old caches ──
self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys().then(keys =>
      Promise.all(keys.filter(k => k !== CACHE_NAME).map(k => caches.delete(k)))
    )
  );
  self.clients.claim();
});

// ── FETCH: serve from cache, fall back to network ──
self.addEventListener('fetch', event => {
  // Only cache GET requests
  if(event.request.method !== 'GET') return;
  // Don't cache Firebase or Google APIs — always fetch live
  const url = event.request.url;
  if(url.includes('firebaseio.com') || url.includes('googleapis.com/maps') ||
     url.includes('gstatic.com/firebasejs') || url.includes('fueleconomy.gov')){
    return;
  }
  event.respondWith(
    caches.match(event.request).then(cached => {
      return cached || fetch(event.request).then(response => {
        // Cache successful responses
        if(response.ok && event.request.url.startsWith('http')){
          const clone = response.clone();
          caches.open(CACHE_NAME).then(cache => cache.put(event.request, clone));
        }
        return response;
      }).catch(() => cached); // offline fallback to cache
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
    actions: [
      { action: 'open', title: 'Open App' },
      { action: 'dismiss', title: 'Dismiss' }
    ],
    requireInteraction: false,
    tag: data.tag || 'nda-notification',
  };

  event.waitUntil(
    self.registration.showNotification(data.title, options)
  );
});

// ── NOTIFICATION CLICK: open app ──
self.addEventListener('notificationclick', event => {
  event.notification.close();
  if(event.action === 'dismiss') return;

  const targetUrl = event.notification.data?.url || '/';
  event.waitUntil(
    clients.matchAll({ type: 'window', includeUncontrolled: true }).then(windowClients => {
      // If app is already open, focus it
      for(const client of windowClients){
        if(client.url.includes('nda-app') && 'focus' in client){
          return client.focus();
        }
      }
      // Otherwise open a new window
      if(clients.openWindow){
        return clients.openWindow('https://chasesweat.github.io/nda-app');
      }
    })
  );
});

// ── BACKGROUND SYNC (for offline ride saving) ──
self.addEventListener('sync', event => {
  if(event.tag === 'sync-rides'){
    event.waitUntil(
      self.clients.matchAll().then(clients => {
        clients.forEach(client => client.postMessage({ type: 'SYNC_RIDES' }));
      })
    );
  }
});
