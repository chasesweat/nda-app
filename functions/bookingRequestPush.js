/**
 * NWDA — booking-link push notification (server-side)
 * ---------------------------------------------------
 * WHY THIS EXISTS
 * Before this, the push for a booking-link submission was enqueued by
 * processClientRequests() inside index.html — which only runs while the driver's
 * app is OPEN (on load, then every 60s). If the app was closed when a client
 * submitted, nothing was ever enqueued, so no push arrived until the driver next
 * opened the app — by which point they'd see the bell notification anyway. The
 * push only worked when it was least needed.
 *
 * This moves the trigger to the database itself, so the submission causes the
 * push no matter what any phone is doing.
 *
 * WHAT IT DOES (deliberately minimal)
 * It does NOT send FCM directly. It writes an entry into `nda/kat/pushQueue/`,
 * in exactly the shape index.html already writes — so the EXISTING, proven push
 * function does the actual sending, token lookup and cleanup. That keeps this
 * function small, keeps one code path responsible for delivery, and means a
 * change to how pushes are sent doesn't have to be made in two places.
 *
 * PATHS (verified against index.html, not assumed)
 *   requests : nda/kat/clientRequests/{reqId}     (storageGet('kat:clientRequests'))
 *   queue    : nda/kat/pushQueue/{id}             (sendPushToDriver)
 *   tokens   : nda/kat/fcmTokens/{driver}/{dev}   (read by the existing push fn)
 * index.html maps a storage key to a path via 'nda/' + key.replace(/:/g,'/').
 *
 * DUPLICATE SAFETY
 * index.html's own polling ALSO still enqueues a push when the app is open, so
 * without care a driver with the app open would get two. Guarded three ways:
 *   1. Only fires on a transition INTO status 'pending' (a new request), never on
 *      the later flip to 'processed' that index.html performs.
 *   2. Writes a marker at nda/kat/pushSentForRequest/{reqId} and refuses to run
 *      twice for the same request — a separate node on purpose, so writing it
 *      cannot re-trigger this function the way touching the request itself would.
 *   3. The marker is written BEFORE the queue entry, so a retry or a concurrent
 *      invocation loses the race rather than duplicating the push.
 * index.html's client-side enqueue is intentionally left in place: it costs one
 * de-duplicated entry at worst, and it keeps working if this function is ever
 * disabled.
 */

const functions = require('firebase-functions');
const admin = require('firebase-admin');
if (!admin.apps.length) admin.initializeApp();

// FALLBACK COPY ONLY — normally unused.
//
// The live map is published to the database by index.html (_publishUserDriverMap), at
// nda/kat/userDriverMap, and resolveDriverName() reads that FIRST. So adding a driver to
// USER_DRIVER_MAP in index.html and deploying the app is enough — this function picks them up
// on the very next request, with no redeploy and no second list to maintain.
//
// This copy exists only so the function still works if that node is missing (a fresh project,
// or before the app has been opened once since deploying the version that publishes it). If you
// ever see the "using built-in fallback map" warning in the logs, the published node isn't
// there — check that index.html is current, rather than editing this.
const USER_DRIVER_MAP_FALLBACK = {
  'Kat':      'Kathleen Herringdine',
  'Michael':  'Michael Herringdine',
  'Allen':    'Allen Westerfield',
  'Chase':    'Chase Sweat',
  'Cheo':     'Cheo Walker',
  'Ed':       'Ed Judd',
  'Eric':     'Eric Meckes',
  'Jamie':    'Jamie Crump',
  'Jennifer': 'Jennifer Thames',
  'Jim':      'Jim Fortner',
  'JK':       'JK Westerfield',
  'John':     'John Terrell',
  'Lamin':    'Lamin Saidy',
  'MikeW':    'Michael Williams',
  'Morgan':   'Morgan Newton',
  'Omead':    'Omead',
  'Rick':     'Rick Powers',
  'Victoria': 'Victoria Herringdine',
};

// login name -> driver name, case-insensitively. Four sources, in order, so a newly added
// driver works automatically and a missing map still fails safe rather than silently:
//   1. the map the APP publishes (nda/kat/userDriverMap) — the normal path
//   2. the built-in fallback above, only if that node is absent
//   3. an fcmTokens entry already stored under that exact name
//   4. nothing — logs clearly and sends no push
// It will never resolve to the WRONG driver: worst case is no push plus a log line saying why.
async function resolveDriverName(loginName) {
  const login = String(loginName || '').trim();
  if (!login) return null;

  let map = null;
  try {
    const snap = await admin.database().ref('nda/kat/userDriverMap').once('value');
    map = snap.val();
  } catch (e) {
    console.warn('[bookingPush] could not read published userDriverMap:', e);
  }
  if (!map || typeof map !== 'object' || !Object.keys(map).length) {
    console.warn('[bookingPush] no published userDriverMap at nda/kat/userDriverMap — ' +
                 'using built-in fallback map. Check that index.html is up to date.');
    map = USER_DRIVER_MAP_FALLBACK;
  }

  const hit = Object.keys(map).find(k => k.toLowerCase() === login.toLowerCase());
  if (hit) return map[hit];

  try {
    const snap = await admin.database().ref('nda/kat/fcmTokens').once('value');
    const all = snap.val() || {};
    const byName = Object.keys(all)
      .find(n => n.toLowerCase() === login.toLowerCase());
    if (byName) {
      console.warn('[bookingPush] login "' + login + '" not in the driver map; ' +
                   'matched an fcmTokens entry instead.');
      return byName;
    }
  } catch (e) {
    console.warn('[bookingPush] fcmTokens fallback lookup failed:', e);
  }

  console.warn('[bookingPush] could not resolve login "' + login + '" to a driver. ' +
               'Push not sent. Is this login in USER_DRIVER_MAP in index.html?');
  return null;
}

// Short human summary for the notification body. Kept deliberately brief — the
// full detail already goes into the in-app bell notification that index.html
// builds; this only has to be enough to decide whether to open the app now.
function summarize(r) {
  const kind = r.requestType === 'quote' ? 'Quote request' : 'Ride request';
  const who  = (r.clientName || 'A client').trim();
  const bits = [];
  if (r.type) bits.push(r.type);
  if (r.date) bits.push(r.date + (r.time ? ' ' + r.time : ''));
  return {
    title: '📋 New request via your booking link',
    body: kind + ' from ' + who + (bits.length ? ' — ' + bits.join(' · ') : '')
  };
}

exports.bookingRequestPush = functions.database
  .ref('/nda/kat/clientRequests/{reqId}')
  .onWrite(async (change, context) => {
    const reqId = context.params.reqId;
    const after = change.after.val();
    const before = change.before.val();

    // Only a NEW pending request. Skips index.html flipping status to
    // 'processed', and skips deletions.
    if (!after || after.status !== 'pending') return null;
    if (before && before.status === 'pending') return null;

    const db = admin.database();
    const markerRef = db.ref('nda/kat/pushSentForRequest/' + reqId);

    // Claim this request before doing anything else. transaction() so two
    // concurrent invocations can't both win.
    const claim = await markerRef.transaction(cur => (cur ? undefined : Date.now()));
    if (!claim.committed) {
      console.log('[bookingPush] ' + reqId + ' already pushed — skipping.');
      return null;
    }

    const driverName = await resolveDriverName(after.loginName);
    if (!driverName) return null;

    const { title, body } = summarize(after);
    const id = Date.now() + '_' + Math.random().toString(36).slice(2, 7);

    // Same entry shape index.html's sendPushToDriver writes, so the existing
    // push-sending function handles it with no changes.
    await db.ref('nda/kat/pushQueue/' + id).set({
      to: driverName,
      title: title,
      body: body,
      ts: Date.now(),
      data: { type: 'client_request', clientRequestId: reqId }
    });

    console.log('[bookingPush] queued push for ' + driverName + ' (request ' + reqId + ')');
    return null;
  });

/**
 * Housekeeping: drop push markers older than 30 days so the node doesn't grow
 * without bound. Runs daily. Safe to delete this export if you'd rather keep
 * every marker — the main function doesn't depend on it.
 */
exports.cleanupBookingPushMarkers = functions.pubsub
  .schedule('every 24 hours')
  .onRun(async () => {
    const cutoff = Date.now() - 30 * 24 * 60 * 60 * 1000;
    const ref = admin.database().ref('nda/kat/pushSentForRequest');
    const snap = await ref.once('value');
    const all = snap.val() || {};
    const updates = {};
    Object.keys(all).forEach(k => {
      const ts = Number(all[k]);
      if (isFinite(ts) && ts < cutoff) updates[k] = null;
    });
    const n = Object.keys(updates).length;
    if (n) await ref.update(updates);
    console.log('[bookingPush] cleanup removed ' + n + ' old marker(s).');
    return null;
  });
