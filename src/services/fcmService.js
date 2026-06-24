// Firebase Cloud Messaging dispatch service.
//
// Strategy:
//   - The `firebase-admin` package is loaded lazily so the server
//     can boot WITHOUT credentials configured (the in-app notification
//     fan-out keeps working; FCM pushes simply degrade to a logged
//     warning until the platform team wires the service-account JSON).
//   - `sendHighPriorityPush(userId, title, body, data)` resolves the
//     target's `fcm_tokens[]` array, batches into a multicast send,
//     and prunes invalid tokens off the Account row so a stale device
//     can't keep getting 404s forever.
//
// Configuration (set in `.env`):
//   FIREBASE_SERVICE_ACCOUNT_JSON  — full JSON string of the service
//                                   account creds (preferred for
//                                   stateless deploys / containers).
//   FIREBASE_PROJECT_ID            — optional override.
//
// Or drop a service-account.json file at:
//   backend/firebase/service-account.json
//
// The first present source wins.

const path = require('path');
const fs = require('fs');
const Account = require('../models/Account');

let _adminMod = null;
let _initAttempted = false;
let _initError = null;
let _initialized = false;

function loadServiceAccount() {
  const env = process.env.FIREBASE_SERVICE_ACCOUNT_JSON;
  if (env) {
    try {
      return JSON.parse(env);
    } catch (e) {
      throw new Error(
        '[fcm] FIREBASE_SERVICE_ACCOUNT_JSON is not valid JSON: ' + e.message,
      );
    }
  }
  const filePath = path.join(
    __dirname,
    '..',
    '..',
    'firebase',
    'service-account.json',
  );
  if (fs.existsSync(filePath)) {
    return JSON.parse(fs.readFileSync(filePath, 'utf-8'));
  }
  return null;
}

function ensureInitialized() {
  if (_initialized) return _adminMod;
  if (_initAttempted) return null;
  _initAttempted = true;
  try {
    // eslint-disable-next-line global-require
    _adminMod = require('firebase-admin');
  } catch (e) {
    _initError = '`firebase-admin` package is not installed. ' +
      'Install with: npm i firebase-admin';
    console.warn('[fcm] ' + _initError);
    return null;
  }
  const cred = loadServiceAccount();
  if (!cred) {
    _initError =
      'No Firebase service-account credentials found. Set ' +
      'FIREBASE_SERVICE_ACCOUNT_JSON or drop firebase/service-account.json.';
    console.warn('[fcm] ' + _initError);
    return null;
  }
  try {
    if (!_adminMod.apps.length) {
      _adminMod.initializeApp({
        credential: _adminMod.credential.cert(cred),
        projectId: process.env.FIREBASE_PROJECT_ID || cred.project_id,
      });
    }
    _initialized = true;
    console.log('[fcm] Firebase Admin initialized.');
    return _adminMod;
  } catch (e) {
    _initError = '[fcm] init failed: ' + (e.message || e);
    console.warn(_initError);
    return null;
  }
}

// Optional warm-up call at boot time — safe to call from server.js.
function init() {
  return ensureInitialized();
}

/**
 * Dispatch a high-priority push to every device the given account
 * has registered. Resolves with `{ sent, failed, pruned }`. NEVER
 * throws — a failed push is best-effort and is logged but doesn't
 * tank the originating mutation (admin assign, prescription issue,
 * etc.).
 *
 * `data` is the structural background payload the Flutter app reads
 * (e.g. `{ appointmentId, prescriptionId, click_action }`). FCM only
 * accepts string values inside `data`, so non-strings are coerced.
 */
async function sendHighPriorityPush(userId, title, body, data = {}) {
  if (!userId) {
    return { sent: 0, failed: 0, pruned: 0, skipped: 'no userId' };
  }
  const admin = ensureInitialized();
  if (!admin) {
    return { sent: 0, failed: 0, pruned: 0, skipped: 'fcm not configured' };
  }
  try {
    const account = await Account.findById(userId, 'fcm_tokens');
    const tokens = (account && Array.isArray(account.fcm_tokens))
      ? account.fcm_tokens.filter((t) => typeof t === 'string' && t.trim())
      : [];
    if (tokens.length === 0) {
      return { sent: 0, failed: 0, pruned: 0, skipped: 'no tokens' };
    }

    // FCM `data` must be string-valued. Cast everything.
    const stringData = {};
    Object.keys(data || {}).forEach((k) => {
      const v = data[k];
      if (v === undefined || v === null) return;
      stringData[k] = String(v);
    });
    // Default click_action — Flutter side wires it through
    // `_firebaseMessagingBackgroundHandler`.
    if (!stringData.click_action) {
      stringData.click_action = 'FLUTTER_NOTIFICATION_CLICK';
    }

    const message = {
      tokens,
      notification: { title: title || '', body: body || '' },
      data: stringData,
      android: {
        priority: 'high',
        notification: {
          channelId: 'medi_treat_high_priority',
          sound: 'default',
          defaultSound: true,
          defaultVibrateTimings: true,
          visibility: 'public',
        },
      },
      apns: {
        headers: { 'apns-priority': '10' },
        payload: {
          aps: { sound: 'default', contentAvailable: true },
        },
      },
    };

    const res = await admin.messaging().sendEachForMulticast(message);

    // Prune invalid tokens — `messaging/registration-token-not-registered`
    // and friends mean the device uninstalled the app or got a new
    // token. Remove them so the array stays lean.
    const dead = [];
    res.responses.forEach((r, idx) => {
      if (!r.success && r.error) {
        const code = r.error.code || '';
        if (
          code.includes('registration-token-not-registered') ||
          code.includes('invalid-registration-token') ||
          code.includes('mismatched-credential')
        ) {
          dead.push(tokens[idx]);
        }
      }
    });
    if (dead.length > 0 && account) {
      account.fcm_tokens = tokens.filter((t) => !dead.includes(t));
      await account.save();
    }

    return {
      sent: res.successCount,
      failed: res.failureCount,
      pruned: dead.length,
    };
  } catch (err) {
    console.warn('[fcm] push failed for user=' + userId + ': ' + err.message);
    return {
      sent: 0,
      failed: 0,
      pruned: 0,
      error: err.message || String(err),
    };
  }
}

module.exports = { init, sendHighPriorityPush };
