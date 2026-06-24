const jwt = require('jsonwebtoken');

// Production deployments MUST set `JWT_SECRET`. The dev fallback exists so
// local sign-ups still work the moment you `npm run dev` without a .env
// — but we shout loud once at boot so it's impossible to ship without
// noticing.
const DEV_SECRET = 'dev-not-for-prod';
const SECRET = process.env.JWT_SECRET || DEV_SECRET;
if (SECRET === DEV_SECRET) {
  console.warn(
    '[auth] JWT_SECRET is not set — using a dev-only fallback. ' +
      'Set JWT_SECRET in .env before deploying to anything real.'
  );
}

// 7-day sessions match the Flutter SharedPreferences persistence window
// (the app holds the token around between cold starts; users only get
// bounced back to /login when the token actually expires).
const EXPIRES_IN = process.env.JWT_TTL || '7d';

/**
 * Sign an access token for the given account. The Flutter side reads
 * `sub` to know "which account is this" and `role` to route into the
 * right home screen on cold-start.
 */
function signToken({ sub, role }) {
  if (!sub) throw new Error('signToken: sub is required');
  return jwt.sign({ sub: String(sub), role: role || 'user' }, SECRET, {
    algorithm: 'HS256',
    expiresIn: EXPIRES_IN,
  });
}

/**
 * Verify + decode a token. Returns the payload (`{sub, role, iat, exp}`)
 * on success, throws on tamper / expiry. Callers should catch and 401.
 */
function verifyToken(token) {
  return jwt.verify(token, SECRET, { algorithms: ['HS256'] });
}

module.exports = { signToken, verifyToken };
