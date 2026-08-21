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

// Still initialized: getToken() in index.html passes this registration to the SDK, so the
// messaging instance needs to exist here for tokens to be issued at all. What changed is that
// DISPLAY no longer goes through the SDK's onBackgroundMessage - see the push listener below.
const messaging = firebase.messaging();

// Take over immediately on install/activate — without this, a fix to this file (like the
// notification badge below) sits in "waiting" until every open tab is fully closed, which
// for a PWA people keep open for days could mean the fix never actually takes effect.
self.addEventListener('install', function (e) { self.skipWaiting(); });
self.addEventListener('activate', function (e) { e.waitUntil(self.clients.claim()); });

// ─────────────────────────────────────────────────────────────────────────────
// WHY THIS IS A RAW `push` LISTENER AND NOT messaging.onBackgroundMessage()
//
// Reported: iPhone drivers receive nothing, while the send side is provably healthy - the
// sendPush Cloud Function runs clean on every invocation, and the affected driver (Kathleen)
// has a valid device token stored. So the message reaches the phone; it just never becomes a
// visible notification.
//
// iOS is far stricter than Android here: every push event MUST result in a visible
// notification, and showNotification() must be registered inside the push event's
// waitUntil() so WebKit can see the promise before the event settles. If it doesn't, iOS
// treats the push as "silent" - it drops it, and after a few of those Safari REVOKES the
// site's push permission entirely, which is why this tends to get worse over time rather
// than failing cleanly from day one.
//
// The SDK's onBackgroundMessage() is a wrapper over this same push event, and it does not
// give the callback access to the event - so there is no way to waitUntil() from inside it.
// That's a known cause of exactly this symptom on iOS (firebase-js-sdk issue #8010). Handling
// the raw event directly is the only way to guarantee the notification is displayed within
// the event's lifetime.
//
// Deliberately does NOT register onBackgroundMessage as well: both would fire for the same
// push and show it twice on Android. The tag below is a second line of defence for that.
// ─────────────────────────────────────────────────────────────────────────────
self.addEventListener('push', function (event) {
  let title = 'Northwest Drivers';
  let body = '';
  let data = {};

  try {
    if (event.data) {
      const payload = event.data.json();
      // sendPush sends data-only, but read notification too so this keeps working if the
      // server side is ever changed to include one.
      data = payload.data || {};
      const n = payload.notification || {};
      title = n.title || data.title || title;
      body  = n.body  || data.body  || body;
    }
  } catch (err) {
    // A malformed or non-JSON payload must NOT stop us showing something - a generic
    // notification is recoverable, a silent push on iOS costs the permission.
  }

  // Silent update-check push (nightlyUpdateCheck / functions-index.js, added v926). Not a
  // driver-facing alert - sendPush sends this as {type:'force-update'} with no title/body, so
  // without this branch it would fall through to the generic notification below and show an
  // empty "Northwest Drivers" alert every night for no reason. Instead: no visible
  // notification at all, just ask this worker to check for a newer deploy, matching the exact
  // contract documented in functions-index.js's sendPush/nightlyUpdateCheck comments.
  if (data.type === 'force-update') {
    event.waitUntil(self.registration.update());
    return;
  }

  // Tag derived from the message content, not a timestamp. Two DIFFERENT messages get
  // different tags and both display (a driver assigned two rides sees two alerts). The same
  // message arriving twice collapses into one, so a duplicate can never reach the user even
  // if something upstream sends it twice. A timestamp tag - as this file used before - makes
  // every notification unique and so can never dedupe anything.
  const tag = 'nda-' + String(title + '|' + body).replace(/\s+/g, '-').slice(0, 60);

  // waitUntil is the whole point: it tells iOS a notification is on its way, and keeps the
  // service worker alive until showNotification actually resolves.
  event.waitUntil(
    self.registration.showNotification(title, {
      body: body,
      icon: 'icon-192.png',
      badge: 'badge-monochrome.png',
      tag: tag,
      renotify: true
    })
  );
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
