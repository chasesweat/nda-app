/* NWDA — push delivery Cloud Function.
 *
 * THE GAP THIS FILLS: the app writes every notification to nda/kat/pushQueue and stops there
 * (see sendPushToDriver() in index.html) - by design, a browser can't call the FCM send API
 * directly with admin privileges. Something server-side has to read that queue and actually
 * call Firebase Cloud Messaging. Nothing in this repo did that, which is why notifications were
 * enqueuing successfully (the app looked completely healthy) while never actually arriving on
 * any device, iPhone or otherwise.
 *
 * Verified against the real app before writing this, not assumed:
 *   - Queue entries live at nda/kat/pushQueue/{id} = { to, title, body, ts, data? }
 *     (sendPushToDriver in index.html)
 *   - Tokens live at nda/kat/fcmTokens/{driverName}/{deviceKey} = token string
 *     (registerFcmToken and _purgeDeviceTokens in index.html - storageSet('kat:fcmTokens/...')
 *     resolves to this exact path, since storageSet writes to 'nda/'+key.replace(/:/g,'/'))
 *   - A driver can have multiple devices, each its own token under their name - this sends to
 *     all of them, not just one.
 *
 * Uses the CURRENT (2026) Admin SDK API - sendMulticast() is deprecated and removed in recent
 * firebase-admin versions; sendEachForMulticast() is the replacement. Verified this directly
 * before writing, since shipping a function that calls a removed method would just be a new,
 * different silent failure - it would deploy fine and then throw on every single invocation.
 */

const { onValueCreated } = require('firebase-functions/v2/database');
const { logger } = require('firebase-functions');
const admin = require('firebase-admin');

admin.initializeApp();

exports.processPushQueue = onValueCreated(
  '/nda/kat/pushQueue/{pushId}',
  async (event) => {
    const pushId = event.params.pushId;
    const entry = event.data.val();

    if (!entry || !entry.to) {
      logger.warn(`pushQueue/${pushId}: no recipient ("to") on this entry, skipping`, entry);
      await event.data.ref.remove();
      return;
    }

    // All of this driver's device tokens - a driver can be logged in on more than one phone,
    // and every device that's turned notifications on has its own token here.
    const tokensSnap = await admin.database()
      .ref(`nda/kat/fcmTokens/${entry.to}`)
      .once('value');
    const tokensObj = tokensSnap.val() || {};
    const deviceKeys = Object.keys(tokensObj);
    const tokens = deviceKeys.map((k) => tokensObj[k]).filter(Boolean);

    if (tokens.length === 0) {
      // Not an error - this is the expected, ordinary state for a driver who has never turned
      // push on, or an iPhone driver who hasn't installed to their home screen yet (see the
      // v842 install-requirement work). Mark processed with a reason rather than deleting
      // silently, so this is visible later if someone's checking why a specific driver never
      // got a specific notification.
      logger.info(`pushQueue/${pushId}: no tokens for "${entry.to}", nothing to send`);
      await event.data.ref.update({ processed: true, processedAt: Date.now(), result: 'no-tokens' });
      return;
    }

    // FCM's data payload must be all-string values - the app's own optional navData can include
    // a numeric rideId (see sendPushToDriver), so every value is stringified here rather than
    // passed through as-is, which would otherwise make the whole send throw.
    const dataPayload = {};
    if (entry.data && typeof entry.data === 'object') {
      for (const k in entry.data) {
        if (entry.data[k] != null) dataPayload[k] = String(entry.data[k]);
      }
    }

    const message = {
      notification: {
        title: entry.title || 'Northwest Drivers',
        body: entry.body || '',
      },
      data: dataPayload,
      tokens,
    };

    let response;
    try {
      response = await admin.messaging().sendEachForMulticast(message);
    } catch (err) {
      // A total failure here means the call itself was rejected (bad credentials, malformed
      // message) - not that individual tokens failed, which is handled separately below.
      logger.error(`pushQueue/${pushId}: sendEachForMulticast threw`, err);
      await event.data.ref.update({ processed: true, processedAt: Date.now(), result: 'error', error: String(err) });
      return;
    }

    // Clean up tokens FCM says are dead (uninstalled app, expired, etc.) - left alone they'd
    // accumulate forever and every future send would keep paying the cost of trying them.
    const staleRemovals = [];
    response.responses.forEach((r, i) => {
      if (r.success) return;
      const code = r.error && r.error.code;
      if (code === 'messaging/invalid-registration-token' ||
          code === 'messaging/registration-token-not-registered') {
        const deadKey = deviceKeys[i];
        staleRemovals.push(
          admin.database().ref(`nda/kat/fcmTokens/${entry.to}/${deadKey}`).remove()
        );
      } else {
        logger.warn(`pushQueue/${pushId}: send failed for a token, not treating as stale`, code);
      }
    });
    if (staleRemovals.length) await Promise.all(staleRemovals);

    logger.info(`pushQueue/${pushId}: sent to "${entry.to}" - ${response.successCount}/${tokens.length} succeeded`);
    await event.data.ref.update({
      processed: true,
      processedAt: Date.now(),
      result: 'sent',
      successCount: response.successCount,
      failureCount: response.failureCount,
    });
  }
);
