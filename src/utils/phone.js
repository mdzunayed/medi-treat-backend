// Canonical phone form. Two-stage:
//   1. Strip every non-digit  ("+880 1700-00 01" → "880170000001").
//   2. Normalise Bangladesh local → international when the input is a
//      classic 11-digit "01XXXXXXXXX" — prepend "880" and drop the
//      leading 0 ("01700000001" → "8801700000001").
//
// Collapses the most common format ambiguity our test data hits: the
// same person typing their number in local vs international form
// during signup, login, and reset. New country branches layer in here.
function normalizePhone(raw) {
  const digits = String(raw || '').replace(/\D/g, '');
  if (digits.length === 11 && digits.startsWith('0')) {
    return '880' + digits.substring(1);
  }
  return digits;
}

module.exports = { normalizePhone };
