// Masks `payout_details.account_number` to its last 4 characters so
// the full account string never leaves the server in a read response.
// Adds a sibling `account_number_last4` for clean UI rendering (the
// Flutter sheet shows "**** **** *5678" — derived from this value).
//
// Used by every Provider-read path that exposes payout:
//   GET /doctor/profile          (the merged response)
//   GET /doctor/profile-status   (the completion engine response)
//   GET /doctor/dashboard        (when it returns provider snippets)
//
// Idempotent — calling it on an already-masked object is a no-op so
// the helper can be sprinkled liberally without double-masking risk.
function maskAccountNumber(raw) {
  const s = String(raw || '');
  if (!s) return '';
  // Already-masked input — skip.
  if (s.includes('*')) return s;
  const last4 = s.slice(-4);
  if (s.length <= 4) return last4;
  // 12 leading stars rendered as "**** **** *XXXX" — keeps the
  // visual width consistent across short and long account numbers.
  return `**** **** *${last4}`;
}

/**
 * Returns a shallow-cloned Provider JSON with `payout_details.account_number`
 * masked. Pass either a Mongoose doc (we call `.toJSON()`) or a plain
 * object. Returns `null` when the input is null/undefined so callers
 * can chain through without an extra guard.
 */
function maskPayoutInJSON(input) {
  if (!input) return null;
  const obj = typeof input.toJSON === 'function' ? input.toJSON() : { ...input };
  const payout = obj.payout_details;
  if (!payout) return obj;
  const masked = { ...payout };
  const raw = payout.account_number || '';
  masked.account_number = maskAccountNumber(raw);
  masked.account_number_last4 = raw ? raw.slice(-4) : '';
  obj.payout_details = masked;
  return obj;
}

module.exports = { maskAccountNumber, maskPayoutInJSON };
