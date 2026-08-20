// NWDA push sender. Watches the pushQueue; when the app drops a request in,
// it looks up the target driver's device tokens and delivers the notification.
const functions = require('firebase-functions/v1');
const admin = require('firebase-admin');
admin.initializeApp();

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

// calendarFeed used to live here too, but that code was never actually what got deployed.
// The real, working calendarFeed is a separate Cloud Run service (created directly through
// Cloud Run's console, using @google-cloud/functions-framework, not the firebase-functions SDK
// this file uses) — see NWDA-APP-HANDOFF.md, v885, for the full story of why and what it took
// to get it actually working. It is not tracked in this repo. If it's ever moved into proper
// source control, it needs its own file/package.json (different runtime style than sendPush
// above, so it cannot simply be pasted back into this file without conflicts).
