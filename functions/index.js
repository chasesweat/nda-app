// NWDA push sender. Watches the pushQueue; when the app drops a request in,
// it looks up the target driver's device tokens and delivers the notification.
const functions = require('firebase-functions/v1');
const admin = require('firebase-admin');
admin.initializeApp();

// v2 HTTPS trigger, coexisting with the v1 database trigger above — firebase-functions ^6.0.0
// (see package.json) supports both styles exported from the same file/deploy. Reuses the
// `admin` app already initialized above rather than calling admin.initializeApp() a second
// time, which would throw.
const { onRequest } = require('firebase-functions/v2/https');

exports.sendPush = functions.database
  .ref('/nda/kat/pushQueue/{id}')
  .onCreate(async (snap) => {
    const req = snap.val() || {};
    const cleanup = () => snap.ref.remove().catch(() => {});
    const to = req.to;

    // Every exit path below now logs WHY. Previously this function's only log lines were
    // Google's automatic "started"/"finished with status: ok" markers - so a run that found no
    // tokens and gave up looked identical to a run that delivered successfully. Debugging a
    // real delivery failure was impossible from the logs alone; that cost a lot of time, and
    // these few lines are what stop it happening again.
    if (!to) {
      console.warn('sendPush: queue entry has no "to" field, dropping', JSON.stringify(req));
      await cleanup();
      return null;
    }

    const tokenSnap = await admin.database().ref('nda/kat/fcmTokens/' + to).once('value');
    const raw = tokenSnap.val();
    let tokens = [];
    if (typeof raw === 'string') tokens = [raw];
    else if (Array.isArray(raw)) tokens = raw.filter((t) => typeof t === 'string');
    else if (raw && typeof raw === 'object') tokens = Object.values(raw).filter((t) => typeof t === 'string');
    tokens = [...new Set(tokens)];

    if (!tokens.length) {
      // Not an error - this is the ordinary state for a driver who never turned notifications
      // on. Logged explicitly so it is distinguishable from a successful send at a glance.
      console.log('sendPush: no device tokens stored for "' + to + '" - nothing to send');
      await cleanup();
      return null;
    }
    console.log('sendPush: sending to "' + to + '" on ' + tokens.length + ' device(s)');

    const message = {
      // Deliberately DATA-ONLY, with no `notification` block. The service worker
      // (firebase-messaging-sw.js) draws every notification itself from these fields, inside
      // the push event's waitUntil - which is what iOS requires. Adding a `notification` block
      // here would make FCM auto-display it as well, and Android would then show every alert
      // twice. If the service worker's push listener is ever removed, this must change too -
      // the two files are a matched pair.
      data: {
        title: String(req.title || 'Northwest Drivers'),
        body: String(req.body || '')
      },
      // Urgency high tells Apple's push service to deliver promptly rather than batching for
      // power saving, which on iOS can otherwise delay a notification by minutes. TTL keeps an
      // undelivered message alive for a day (a phone that was off overnight still gets it)
      // rather than FCM's default of keeping it four weeks, which is far too long for a ride
      // alert that would be stale by then anyway.
      webpush: {
        headers: { Urgency: 'high', TTL: '86400' }
      },
      tokens
    };

    let resp;
    try {
      resp = await admin.messaging().sendEachForMulticast(message);
    } catch (err) {
      // A throw here means the whole call was rejected (bad credentials, malformed message),
      // not that individual tokens failed - that's handled per-token below. Deliberately does
      // NOT clean up the queue entry, so a systemic failure leaves evidence behind instead of
      // silently deleting itself.
      console.error('sendPush: send failed entirely for "' + to + '"', err);
      return null;
    }

    console.log('sendPush: "' + to + '" - ' + resp.successCount + '/' + tokens.length + ' delivered');

    // Prune tokens that are no longer valid so the queue stays clean.
    const dead = [];
    resp.responses.forEach((r, i) => {
      if (r.success) return;
      const code = r.error && r.error.code;
      if (code === 'messaging/registration-token-not-registered' ||
          code === 'messaging/invalid-registration-token') {
        dead.push(tokens[i]);
      } else {
        // A failure that is NOT a dead token is worth seeing - it could be a quota problem, an
        // APNs configuration issue, or a malformed payload, none of which fix themselves.
        console.warn('sendPush: delivery failed for a device of "' + to + '" - ' + code);
      }
    });

    if (dead.length) {
      console.log('sendPush: pruning ' + dead.length + ' dead token(s) for "' + to + '"');
      const updates = {};
      const rawObj = (raw && typeof raw === 'object' && !Array.isArray(raw)) ? raw : {};
      Object.keys(rawObj).forEach((deviceKey) => {
        if (dead.indexOf(rawObj[deviceKey]) >= 0) updates['nda/kat/fcmTokens/' + to + '/' + deviceKey] = null;
      });
      if (Object.keys(updates).length) {
        await admin.database().ref().update(updates).catch((e) => console.warn('sendPush: prune failed', e));
      }
    }

    await cleanup();
    return null;
  });

// ============================================================================================
// calendarFeed — new addition, appended below sendPush. First HTTPS-triggered function in this
// project; see NWDA-APP-HANDOFF.md v882 for the full "why" and the client-side half of this
// feature (token generation, the Settings UI). Deploy with:
//   firebase deploy --only functions:calendarFeed
// After deploying, Firebase prints the real URL — confirm it matches the us-central1 guess
// already in index.html's CALENDAR_FEED_BASE_URL (no .region() call anywhere in this file, so
// the deploy should land on Firebase's default region, us-central1 — but confirm against the
// actual printed URL rather than trusting that inference a second time).
// ============================================================================================

exports.calendarFeed = onRequest({ cors: true }, async (req, res) => {
  try {
    const token = (req.query.token || '').toString().trim();
    if (!token) { res.status(400).send('Missing token'); return; }

    const db = admin.database();

    // Token → driver name. Written by index.html's _getOrCreateCalendarToken() to
    // nda/kat/calendarTokens/{token} = { driverName, createdAt }.
    const tokenSnap = await db.ref('nda/kat/calendarTokens/' + token).once('value');
    if (!tokenSnap.exists()) { res.status(404).send('Invalid or expired calendar link'); return; }
    const driverName = (tokenSnap.val() || {}).driverName || '';
    if (!driverName) { res.status(404).send('Invalid or expired calendar link'); return; }

    // Same node the app itself reads (kat:rides → nda/kat/rides), stored as an array.
    const ridesSnap = await db.ref('nda/kat/rides').once('value');
    const ridesRaw = ridesSnap.val() || [];
    const rides = Array.isArray(ridesRaw) ? ridesRaw : Object.values(ridesRaw);

    // This driver's rides only, with a real date, and not more than a day in the past —
    // nobody needs six months of history clogging their phone calendar. No upper bound going
    // forward; if it's scheduled, it shows.
    const cutoff = Date.now() - 24 * 60 * 60 * 1000;
    const relevant = rides.filter(function (r) {
      if (!r || !r.date) return false;
      if (((r.driver || '').trim()) !== driverName) return false;
      const dt = parseRideDateTime(r.date, r.time);
      return dt && dt.getTime() > cutoff;
    });

    const ics = buildICS(relevant, driverName);
    res.set('Content-Type', 'text/calendar; charset=utf-8');
    // Calendar apps decide their own re-check interval regardless of this header on most
    // platforms, but it costs nothing to be explicit about intent.
    res.set('Cache-Control', 'no-cache, max-age=0');
    res.status(200).send(ics);
  } catch (err) {
    console.error('calendarFeed error', err);
    res.status(500).send('Server error building calendar feed');
  }
});

// ---------------------------------------------------------------------------- helpers

function parseRideDateTime(dateStr, timeStr) {
  try {
    const t = (timeStr || '00:00').trim() || '00:00';
    const d = new Date(dateStr + 'T' + t + ':00');
    return isNaN(d.getTime()) ? null : d;
  } catch (e) { return null; }
}

// UTC, no separators — the DTSTAMP/DTSTART/DTEND format RFC 5545 requires.
function icsStamp(date) {
  return date.toISOString().replace(/[-:]/g, '').split('.')[0] + 'Z';
}

// RFC 5545 §3.3.11 — commas, semicolons, backslashes, and newlines must be escaped in text
// fields (SUMMARY, DESCRIPTION, LOCATION), or the file is invalid and some calendar apps will
// refuse the whole feed rather than just mangling one field.
function escapeICS(text) {
  return String(text || '')
    .replace(/\\/g, '\\\\')
    .replace(/;/g, '\\;')
    .replace(/,/g, '\\,')
    .replace(/\n/g, '\\n');
}

// A ride has no tracked end time — this app has never needed one, since the schedule/quote
// screens only ever store a start time. Default the calendar block to 1 hour, which is long
// enough to be visible on a day view without implying false precision about when a ride
// actually wraps up.
const DEFAULT_EVENT_MINUTES = 60;

function buildICS(rides, driverName) {
  const now = new Date();
  const lines = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//NWDA//Calendar Feed//EN',
    'CALSCALE:GREGORIAN',
    'METHOD:PUBLISH',
    'X-WR-CALNAME:NWDA Rides \u2014 ' + escapeICS(driverName),
    // Advisory hints some calendar apps (notably Google) honor for how often to re-check a
    // subscribed feed. Not a guarantee — see the file-level comment above.
    'REFRESH-INTERVAL;VALUE=DURATION:PT1H',
    'X-PUBLISHED-TTL:PT1H',
  ];

  rides.forEach(function (r) {
    const start = parseRideDateTime(r.date, r.time);
    if (!start) return; // already filtered upstream, but never trust a second time for free
    const end = new Date(start.getTime() + DEFAULT_EVENT_MINUTES * 60000);

    const client = (r.client || 'Client').trim();
    const type = (r.type || 'Ride').trim();
    const summary = escapeICS(type + ' \u2014 ' + client);
    const location = escapeICS(r.pickup || r.home || '');

    const descParts = [];
    if (r.pickup) descParts.push('Pickup: ' + r.pickup);
    if (r.home && r.home !== r.pickup) descParts.push('Destination: ' + r.home);
    if (r.flight) descParts.push('Flight: ' + r.flight);
    if (r.terminal) descParts.push('Terminal: ' + r.terminal);
    if (r.price !== undefined && r.price !== null && r.price !== '') descParts.push('Price: $' + r.price);
    const description = escapeICS(descParts.join('\n'));

    lines.push(
      'BEGIN:VEVENT',
      'UID:' + (r.id !== undefined ? r.id : (client + start.getTime())) + '@nwda-calendar-feed',
      'DTSTAMP:' + icsStamp(now),
      'DTSTART:' + icsStamp(start),
      'DTEND:' + icsStamp(end),
      'SUMMARY:' + summary,
      (location ? 'LOCATION:' + location : null),
      (description ? 'DESCRIPTION:' + description : null),
      'END:VEVENT'
    );
  });

  lines.push('END:VCALENDAR');
  // RFC 5545 requires CRLF line endings, not bare \n.
  return lines.filter(function (l) { return l !== null; }).join('\r\n');
}

// Exported for testing without deploying — see calendarFeed-test.js.
module.exports.buildICS = buildICS;
module.exports.escapeICS = escapeICS;
module.exports.parseRideDateTime = parseRideDateTime;
