/* NWDA Driver Portal — Firebase Cloud Messaging background handler.
   Lives at the site root so push works when the app is closed. */
importScripts('https://www.gstatic.com/firebasejs/9.23.0/firebase-app-compat.js');
importScripts('https://www.gstatic.com/firebasejs/9.23.0/firebase-messaging-compat.js');

firebase.initializeApp({
  apiKey: "AIzaSyAfJLWQwemBO2VqxL8RYmvmDZ1LTzTE-g4",
  authDomain: "nda-transportation.firebaseapp.com",
  databaseURL: "https://nda-transportation-default-rtdb.firebaseio.com",
  projectId: "nda-transportation",
  storageBucket: "nda-transportation.firebasestorage.app",
  messagingSenderId: "585911670194",
  appId: "1:585911670194:web:746a9fa4d97a9171cc40ab"
});

const messaging = firebase.messaging();

// Take over immediately on install/activate — without this, a fix to this file (like the
// notification badge below) sits in "waiting" until every open tab is fully closed, which
// for a PWA people keep open for days could mean the fix never actually takes effect.
self.addEventListener('install', function (e) { self.skipWaiting(); });
self.addEventListener('activate', function (e) { e.waitUntil(self.clients.claim()); });

// Data-only messages arrive here when the app is backgrounded/closed.
messaging.onBackgroundMessage(function (payload) {
  const d = payload.data || {};
  const n = payload.notification || {};
  self.registration.showNotification(n.title || d.title || 'Northwest Drivers', {
    body: n.body || d.body || '',
    icon: 'icon-192.png',
    badge: 'badge-monochrome.png',
    tag: 'nda-' + Date.now()
  });
});

// Tapping the notification focuses (or opens) the app.
self.addEventListener('notificationclick', function (event) {
  event.notification.close();
  event.waitUntil(
    clients.matchAll({ type: 'window', includeUncontrolled: true }).then(function (list) {
      for (const c of list) { if ('focus' in c) return c.focus(); }
      if (clients.openWindow) return clients.openWindow('./');
    })
  );
});
