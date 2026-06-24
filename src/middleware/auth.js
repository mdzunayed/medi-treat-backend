// Lightweight identity extractor for endpoints that need to know
// "which account is hitting me right now". Three input sources are
// accepted, in this order:
//
//   1. `Authorization: Bearer <jwt>` header — canonical for new clients.
//   2. `x-account-id` header — used by the Flutter Dio interceptor when
//      a token isn't available yet (e.g. during fresh sign-up flows).
//   3. `account_id` query param — kept for backward compatibility with
//      existing REST handlers across the codebase.
//
// Routes can either:
//   - Use `attachAccountId` as middleware (`req.accountId` gets set,
//     unauthenticated requests pass through with `null`), then enforce
//     manually inside the handler.
//   - Use `requireAccountId` to send a 401 automatically when the
//     account can't be resolved.

const { verifyToken } = require('../utils/jwt');

function readBearerToken(req) {
  const auth = req.headers && req.headers.authorization;
  if (!auth) return null;
  const m = /^Bearer\s+(.+)$/.exec(auth.trim());
  return m ? m[1] : null;
}

function attachAccountId(req, _res, next) {
  try {
    const token = readBearerToken(req);
    if (token) {
      const payload = verifyToken(token);
      if (payload && payload.sub) {
        req.accountId = String(payload.sub);
        req.accountRole = payload.role || null;
        return next();
      }
    }
  } catch (_e) {
    // Token present but invalid — fall through to header / query fallbacks.
  }
  const headerId = req.headers && (req.headers['x-account-id'] || req.headers['X-Account-Id']);
  if (headerId) {
    req.accountId = String(headerId);
    return next();
  }
  const queryId = req.query && (req.query.account_id || req.query.accountId);
  if (queryId) {
    req.accountId = String(queryId);
    return next();
  }
  req.accountId = null;
  next();
}

function requireAccountId(req, res, next) {
  attachAccountId(req, res, () => {
    if (!req.accountId) {
      return res
        .status(401)
        .json({ success: false, message: 'Authentication required' });
    }
    next();
  });
}

// `restrictTo('admin', 'doctor', ...)` style guard — verifies that the
// account behind the bearer token holds one of the allow-listed roles.
// Roles are looked up live from Mongo so a freshly-demoted admin can't
// keep impersonating with a still-fresh JWT. Returns:
//   401 — no token / unrecognised account
//   403 — token belongs to a real account but the wrong role
const Account = require('../models/Account');

function requireRole(...allowedRoles) {
  // Accept both client-vocabulary ('admin') and DB-vocabulary
  // ('support_member') in the allow-list so callers can stay clean.
  const allow = new Set(
    allowedRoles
      .flatMap((r) => {
        const v = String(r || '').toLowerCase();
        switch (v) {
          case 'admin':
            return ['admin', 'support_member'];
          case 'patient':
            return ['user'];
          default:
            return [v];
        }
      })
      .filter(Boolean),
  );
  return async function roleGuard(req, res, next) {
    attachAccountId(req, res, async () => {
      try {
        if (!req.accountId) {
          return res
            .status(401)
            .json({ success: false, message: 'Authentication required' });
        }
        const account = await Account.findById(req.accountId, 'role');
        if (!account) {
          return res
            .status(401)
            .json({ success: false, message: 'Authentication required' });
        }
        req.accountRole = account.role;
        if (!allow.has(account.role)) {
          return res.status(403).json({
            success: false,
            message: 'You do not have permission to perform this action.',
          });
        }
        return next();
      } catch (err) {
        return res
          .status(500)
          .json({ success: false, message: err.message || 'Server error' });
      }
    });
  };
}

module.exports = { attachAccountId, requireAccountId, requireRole };
