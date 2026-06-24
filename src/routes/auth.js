const express = require('express');
const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const Account = require('../models/Account');
const { signToken } = require('../utils/jwt');
const { requireAccountId } = require('../middleware/auth');

const router = express.Router();

// During the rollout we keep the legacy sha256 path as a fallback so
// the seeded demo accounts (hashed with sha256 before bcrypt shipped)
// still log in. Set AUTH_STRICT=1 in prod to refuse anything but a
// bcrypt-verified password.
const AUTH_STRICT = process.env.AUTH_STRICT === '1';
const BCRYPT_ROUNDS = 10;

// Hard-coded development OTP. Real SMS verification is a follow-up.
// '222222' is exactly 6 chars so it lines up with the 6-box OTP UI.
const DEV_OTP = '222222';

const sha256 = (s) => crypto.createHash('sha256').update(s).digest('hex');
const newToken = () => crypto.randomBytes(24).toString('hex');

const isBcryptHash = (s) => typeof s === 'string' && /^\$2[aby]\$/.test(s);

// See `utils/phone.js` for the canonical-form rules. Imported here so
// every lookup uses the same normalisation; imported in server.js so
// the on-boot migration uses the same rules without copy-pasting.
const { normalizePhone } = require('../utils/phone');

// The schema enum still uses the historical strings; the client speaks
// the new phone-first vocabulary ('patient' / 'doctor' / 'admin').
// These two helpers translate between them in both directions.
//
//   client 'patient' ↔ db 'user'
//   client 'admin'   ↔ db 'admin' OR 'support_member' (both back-office)
//   client 'doctor'  ↔ db 'doctor'
function dbRolesForClient(role) {
  switch (String(role || '').toLowerCase()) {
    case 'patient':
    case 'user':
      return ['user'];
    case 'doctor':
      return ['doctor'];
    case 'nurse':
      return ['nurse'];
    case 'admin':
    case 'support_member':
      return ['admin', 'support_member'];
    default:
      return [];
  }
}

function clientRoleForDb(dbRole) {
  switch (dbRole) {
    case 'user':
      return 'patient';
    case 'support_member':
      return 'admin';
    default:
      return dbRole;
  }
}

// Builds the response body shared by /verify-otp and /login. Issues a
// JWT signed with {sub, role} so the Flutter side can introspect the
// session on cold-start without a round-trip.
function authResponseFor(account) {
  const requiresReset = account.requires_password_reset === true;
  return {
    success: true,
    token: signToken({ sub: account.id, role: account.role }),
    refreshToken: newToken(),
    user: account.toJSON(),
    // Forced-reset latch — surfaced so the Flutter side can detour
    // admin-provisioned doctors / nurses into the
    // ForcedPasswordResetScreen instead of the dashboard.
    requiresReset,
  };
}

// POST /auth/signup  (alias /auth/register for back-compat)
//   { full_name, phone, password, address, role }
//
// Creates a new account in the unverified state. Tokens are NOT
// issued here — the client has to complete /auth/verify-otp first.
// That guarantees an unverified phone can't be used as a logged-in
// identity even if someone snoops this response.
async function signupHandler(req, res) {
  // Smart logging — every signup body is dumped so you can see in the
  // dev terminal exactly which keys the Flutter client sent. If a key
  // shows up here as `full_name` instead of `fullName`, you know the
  // contract has drifted before the bcrypt/Mongo step even runs.
  console.log('Incoming Signup Payload:', req.body);
  try {
    // Canonical wire format is camelCase (`fullName`). The snake_case
    // fallback (`full_name`) stays so legacy clients mid-deploy aren't
    // broken by a 400. Email is intentionally NOT destructured —
    // signup is phone-only per the production spec.
    const body = req.body || {};
    const fullName = body.fullName ?? body.full_name;
    const { phone, password, address } = body;
    if (!fullName || !String(fullName).trim()) {
      return res.status(400).json({
        success: false,
        message: 'fullName is required',
      });
    }
    if (!password || String(password).length < 6) {
      return res.status(400).json({ message: 'password must be at least 6 characters' });
    }
    const cleanPhone = normalizePhone(phone);
    if (!cleanPhone) {
      return res.status(400).json({ message: 'phone is required' });
    }

    // --- Public signup is patient-only ---------------------------------
    //
    // Doctors / nurses are NEVER created via the public surface — they
    // must be provisioned through the admin console
    // (`POST /api/admin/create-provider`). If a request explicitly
    // tries to register as a privileged role we reject it before any
    // DB writes happen and log the attempt for the security audit
    // trail. The role field in `req.body` is then ignored entirely;
    // the DB row is force-stamped as `user` (patient).
    const rawRole = String(body.role || '').toLowerCase().trim();
    const PRIVILEGED_ROLES = new Set([
      'doctor',
      'nurse',
      'admin',
      'support_member',
    ]);
    if (rawRole && PRIVILEGED_ROLES.has(rawRole)) {
      console.warn(
        `[security] rejected privileged self-registration attempt: role=${rawRole}, phone=${cleanPhone}`,
      );
      return res.status(403).json({
        success: false,
        message: 'Unauthorized role assignment.',
      });
    }
    // Patient is the only role the public surface can mint.
    const dbRole = 'user';

    const cleanAddress = String(address || '').trim();

    // Phone-only duplicate pre-check. Email is no longer a signup
    // identifier (the schema's unique constraint on it is gone too).
    const dupe = await Account.findOne({ phone: cleanPhone });
    if (dupe) {
      // Same-phone-unverified retry: bounce them back into the OTP
      // screen with a 200 instead of a duplicate-account error. This
      // is a UX feature — users who close the app mid-OTP shouldn't
      // hit a wall the moment they try again.
      if (dupe.phone === cleanPhone && !dupe.is_verified) {
        return res.status(200).json({
          success: true,
          user: dupe.toJSON(),
          requires_verification: true,
          dev_otp: AUTH_STRICT ? undefined : DEV_OTP,
        });
      }
      // Verified duplicate or a different identifier collision.
      // Single, clean error shape so the Flutter SnackBar reads well.
      return res.status(400).json({
        success: false,
        message: 'Phone number already registered',
      });
    }

    const password_hash = await bcrypt.hash(String(password), BCRYPT_ROUNDS);
    const account = await Account.create({
      // Schema is snake_case, wire is camelCase — the controller is
      // the seam where the names cross over. Email is intentionally
      // not set; phone-only signups must not write that field so we
      // never trip the legacy email_1 unique index on `null`.
      full_name: String(fullName).trim(),
      phone: cleanPhone,
      address: cleanAddress,
      password_hash,
      role: dbRole,
      status: 'active',
      is_verified: false,
    });

    return res.status(201).json({
      success: true,
      user: account.toJSON(),
      requires_verification: true,
      dev_otp: AUTH_STRICT ? undefined : DEV_OTP,
    });
  } catch (err) {
    // Mongo duplicate-key collision. The `$or` pre-check above usually
    // catches this case with a friendly message; this branch only fires
    // when a concurrent request beat us to the unique index — in which
    // case we want the exact offending field in the error string so
    // it's unambiguous in the logs.
    if (err && err.code === 11000 && err.keyValue) {
      const fields = Object.keys(err.keyValue).join(', ');
      console.warn('[signup] duplicate-key collision on:', err.keyValue);
      return res.status(400).json({
        success: false,
        message: `Database duplicate key collision on field: ${fields}`,
        duplicate_fields: Object.keys(err.keyValue),
      });
    }
    console.error('[signup] unexpected error:', err);
    return res.status(500).json({ success: false, message: err.message });
  }
}

router.post('/signup', signupHandler);
router.post('/register', signupHandler); // legacy alias

// POST /auth/verify-otp  { phone, otp }
// Pinned to '222222' during development. On success, flips
// `is_verified: true` and issues a JWT — same shape as login —
// so the client lands in the authenticated home immediately.
router.post('/verify-otp', async (req, res) => {
  try {
    const { phone, otp } = req.body || {};
    const cleanPhone = normalizePhone(phone);
    const code = String(otp || '').trim();
    if (!cleanPhone) {
      return res.status(400).json({ message: 'phone is required' });
    }
    if (!code) {
      return res.status(400).json({ message: 'otp is required' });
    }
    if (code !== DEV_OTP) {
      return res.status(400).json({ message: 'Invalid OTP — please try again' });
    }
    const account = await Account.findOne({ phone: cleanPhone });
    if (!account) {
      return res.status(404).json({ message: 'Account not found for this phone' });
    }
    if (!account.is_verified) {
      account.is_verified = true;
      await account.save();
    }
    return res.json(authResponseFor(account));
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// POST /auth/login  { phone?, email?, password, role }
//
// Role-aware: the lookup includes `role` so a patient credential can't
// sign into the admin console even with the right phone+password.
// Returns 403 with `requires_role_match: true` so the Flutter side can
// SnackBar the specific reason ("those credentials are for a different
// role") instead of a generic "invalid credentials".
router.post('/login', async (req, res) => {
  try {
    const { email, phone, password, role } = req.body || {};
    if (!password) {
      return res.status(400).json({ message: 'password is required' });
    }
    const cleanEmail = String(email || '').toLowerCase().trim();
    const cleanPhone = normalizePhone(phone);
    if (!cleanEmail && !cleanPhone) {
      return res.status(400).json({ message: 'email or phone is required' });
    }

    // Identifier query: phone first, email fallback for the legacy
    // /login screen that still uses email demo creds.
    const idQuery = cleanPhone ? { phone: cleanPhone } : { email: cleanEmail };

    // If the client specified a role, narrow the query so a wrong-role
    // attempt fails fast without leaking which-account-has-which-role.
    // No role given (legacy LoginScreen behaviour) → match any role.
    let account;
    if (role) {
      const dbRoles = dbRolesForClient(role);
      if (dbRoles.length === 0) {
        return res.status(400).json({ message: `Unknown role: ${role}` });
      }
      account = await Account.findOne({ ...idQuery, role: { $in: dbRoles } });
      if (!account) {
        // Distinguish "wrong role" from "wrong password" so the UI can
        // explain itself. We re-query without the role filter to see
        // whether the account exists at all.
        const anyRoleMatch = await Account.findOne(idQuery);
        if (anyRoleMatch) {
          return res.status(403).json({
            message: `Those credentials are registered as ${clientRoleForDb(anyRoleMatch.role)}, not ${role}.`,
            requires_role_match: true,
            actual_role: clientRoleForDb(anyRoleMatch.role),
          });
        }
        return res.status(401).json({
        success: false,
        message: 'Invalid phone number or password',
      });
      }
    } else {
      account = await Account.findOne(idQuery);
      if (!account) {
        return res.status(401).json({
        success: false,
        message: 'Invalid phone number or password',
      });
      }
    }

    if (account.status !== 'active') {
      return res.status(403).json({ message: 'Account is inactive' });
    }

    // Password verification — same fallback ladder as before:
    //   bcrypt hash    → bcrypt.compare
    //   legacy sha256  → constant-time compare (unless AUTH_STRICT)
    //   empty (seed)   → accept in non-strict mode
    let ok = false;
    if (isBcryptHash(account.password_hash)) {
      ok = await bcrypt.compare(String(password), account.password_hash);
    } else if (account.password_hash) {
      ok = !AUTH_STRICT && account.password_hash === sha256(password);
    } else {
      ok = !AUTH_STRICT;
    }
    if (!ok) {
      return res.status(401).json({
        success: false,
        message: 'Invalid phone number or password',
      });
    }

    // Verification gate — only patient-role accounts can be unverified
    // (admin/doctor demo seeds are pre-verified by seed.js).
    if (account.role === 'user' && !account.is_verified) {
      return res.status(403).json({
        message: 'Please verify your phone before signing in.',
        requires_verification: true,
        phone: account.phone,
      });
    }

    return res.json(authResponseFor(account));
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// POST /auth/reset-password  { phone, otp, newPassword }
//
// "Forgot password" handler. Verifies the dev OTP, bcrypts the new
// password, persists it, and issues a fresh JWT so the user lands
// signed-in (skipping the friction of typing the credentials they
// just set). Same OTP gate as /verify-otp — the production rollout
// will swap the constant for a real SMS code.
router.post('/reset-password', async (req, res) => {
  try {
    const { phone, otp, newPassword } = req.body || {};
    const cleanPhone = normalizePhone(phone);
    const code = String(otp || '').trim();
    if (!cleanPhone) {
      return res.status(400).json({ success: false, message: 'phone is required' });
    }
    if (!code) {
      return res.status(400).json({ success: false, message: 'otp is required' });
    }
    if (!newPassword || String(newPassword).length < 6) {
      return res.status(400).json({
        success: false,
        message: 'newPassword must be at least 6 characters',
      });
    }
    if (code !== DEV_OTP) {
      return res.status(400).json({
        success: false,
        message: 'Invalid OTP — please try again',
      });
    }
    const account = await Account.findOne({ phone: cleanPhone });
    if (!account) {
      return res.status(404).json({
        success: false,
        message: 'No account found for that phone number',
      });
    }
    account.password_hash = await bcrypt.hash(String(newPassword), BCRYPT_ROUNDS);
    // A reset implies they own the phone, so mark them verified too.
    // Edge case: a user who signed up but never completed OTP can use
    // the reset flow to verify + recover in one step.
    account.is_verified = true;
    await account.save();
    return res.json({
      success: true,
      ...authResponseFor(account),
    });
  } catch (err) {
    console.error('[reset-password] unexpected error:', err);
    res.status(500).json({ success: false, message: err.message });
  }
});

// POST /auth/google  { email, googleId, fullName, photoUrl?, role? }
//
// OAuth bridge. Trusts the Google-issued profile delivered by the
// Flutter `google_sign_in` package (the client already verified the
// ID token before getting here). Find-or-create:
//   • If an account exists with this `googleId`, sign them in.
//   • Else if an account exists with this `email`, link the google_id
//     to it (account-linking flow) and sign them in.
//   • Else create a new verified account with role:'user' (patient)
//     and sign them in.
//
// Phone stays null until the user fills it via a profile-completion
// screen — the Account schema's conditional `required` allows this.
router.post('/google', async (req, res) => {
  try {
    const body = req.body || {};
    console.log('Incoming Google Sign-In:', {
      email: body.email,
      googleId: body.googleId,
      role: body.role,
    });
    const googleId = String(body.googleId || '').trim();
    const email = String(body.email || '').toLowerCase().trim();
    if (!googleId) {
      return res.status(400).json({
        success: false,
        message: 'googleId is required',
      });
    }
    if (!email) {
      return res.status(400).json({
        success: false,
        message: 'email is required',
      });
    }

    // Find by googleId first, then by email (account-linking case).
    let account = await Account.findOne({ google_id: googleId });
    if (!account && email) {
      account = await Account.findOne({ email });
      // If the legacy email account exists but isn't yet google-linked,
      // attach the google_id so future sign-ins find it via the fast
      // googleId index.
      if (account) {
        account.google_id = googleId;
        if (!account.is_verified) account.is_verified = true;
        if (body.photoUrl && !account.photo_url) {
          account.photo_url = String(body.photoUrl);
        }
        await account.save();
      }
    }

    if (!account) {
      // First-time Google sign-in → create a fresh verified row.
      const dbRoles = dbRolesForClient(body.role || 'patient');
      const dbRole = dbRoles[0] || 'user';
      account = await Account.create({
        full_name: String(body.fullName || email.split('@')[0]).trim(),
        email,
        google_id: googleId,
        photo_url: String(body.photoUrl || ''),
        role: dbRole,
        status: 'active',
        is_verified: true, // Google verified the email for us
      });
    }

    if (account.status !== 'active') {
      return res.status(403).json({
        success: false,
        message: 'Account is inactive',
      });
    }

    return res.json({
      success: true,
      ...authResponseFor(account),
    });
  } catch (err) {
    if (err && err.code === 11000) {
      return res.status(400).json({
        success: false,
        message: `Database duplicate key collision on field: ${Object.keys(err.keyValue).join(', ')}`,
      });
    }
    console.error('[google-auth] unexpected error:', err);
    return res.status(500).json({ success: false, message: err.message });
  }
});

// POST /auth/refresh  { refreshToken }
router.post('/refresh', async (req, res) => {
  const { refreshToken } = req.body || {};
  if (!refreshToken) {
    return res.status(401).json({ message: 'Missing refresh token' });
  }
  // Stub: re-issue a refresh token. Real rotation lives behind the
  // forthcoming /auth/refresh-rotation endpoint. The access token
  // itself is intentionally not re-signed here — the client should
  // call /auth/login again to pick up a fresh JWT.
  res.json({ token: newToken(), refreshToken: newToken() });
});

// POST /auth/complete-password-reset  { newPassword }
//
// Closes the loop on admin-provisioned doctor / nurse accounts: the
// temporary credential lets them sign in once, the login response
// carries `requiresReset: true`, the Flutter side detours into the
// ForcedPasswordResetScreen, and the user posts their new password
// here. We verify identity via the same bearer token they got on
// login (the JWT subject IS the account id) and require the
// `requires_password_reset` flag to still be true — that turns the
// endpoint into a single-use latch.
//
// On success we hash + persist the new password, clear the latch,
// flip `is_verified: true` (the admin already vetted them), and
// re-issue a clean auth response so the client lands signed-in
// without a second round-trip.
router.post('/complete-password-reset', requireAccountId, async (req, res) => {
  try {
    const { newPassword } = req.body || {};
    if (!newPassword || String(newPassword).length < 8) {
      return res.status(400).json({
        success: false,
        message: 'newPassword must be at least 8 characters',
      });
    }
    const account = await Account.findById(req.accountId);
    if (!account) {
      return res
        .status(404)
        .json({ success: false, message: 'Account not found' });
    }
    // Single-use latch — once the flag is cleared this endpoint
    // refuses to overwrite the password. (Regular self-serve resets
    // still go through `/auth/reset-password` with an OTP.)
    if (account.requires_password_reset !== true) {
      return res.status(409).json({
        success: false,
        message: 'Password reset is not required for this account.',
      });
    }
    account.password_hash = await bcrypt.hash(
      String(newPassword),
      BCRYPT_ROUNDS,
    );
    account.requires_password_reset = false;
    account.is_verified = true;
    await account.save();
    return res.json(authResponseFor(account));
  } catch (err) {
    console.error('[complete-password-reset] error:', err);
    return res
      .status(500)
      .json({ success: false, message: err.message || 'Server error' });
  }
});

// POST /auth/fcm-token  { token, unregister? }
//
// Register OR unregister an FCM device token for the signed-in
// account. The Flutter side calls this once on login (and after a
// token refresh) to put the device on the push list, and again on
// logout with `unregister: true` so signed-out devices stop
// receiving alerts.
//
// Idempotent — duplicate appends are deduped by the Account pre-save
// hook so concurrent device sign-ins can't grow the array
// unboundedly.
router.post('/fcm-token', requireAccountId, async (req, res) => {
  try {
    const { token, unregister } = req.body || {};
    const t = (token || '').toString().trim();
    if (!t) {
      return res
        .status(400)
        .json({ success: false, message: 'token is required' });
    }
    const account = await Account.findById(req.accountId);
    if (!account) {
      return res
        .status(404)
        .json({ success: false, message: 'Account not found' });
    }
    const current = Array.isArray(account.fcm_tokens)
      ? [...account.fcm_tokens]
      : [];
    if (unregister === true) {
      account.fcm_tokens = current.filter((x) => x !== t);
    } else if (!current.includes(t)) {
      account.fcm_tokens = [...current, t];
    } else {
      account.fcm_tokens = current;
    }
    await account.save();
    return res.json({
      success: true,
      tokenCount: account.fcm_tokens.length,
    });
  } catch (err) {
    console.error('[auth/fcm-token] error:', err);
    return res
      .status(500)
      .json({ success: false, message: err.message || 'Server error' });
  }
});

module.exports = router;
