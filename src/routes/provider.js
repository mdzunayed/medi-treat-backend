const express = require('express');
const Provider = require('../models/Provider');
const Account = require('../models/Account');
const CareRequest = require('../models/CareRequest');
const { requireAccountId } = require('../middleware/auth');
const { loadProviderPair } = require('../utils/doctorView');

const router = express.Router();

// Resolve the signed-in provider (doctor / nurse / helper) from the session
// account id. The Provider row links to the Account by email / full_name +
// role (there is no account_id FK), so we read the Account's role first and
// hand it to `loadProviderPair` which walks both collections. Returns
// `{ account, provider }` — `provider` may be null if the nurse hasn't
// materialised a Provider row yet (first save creates it).
async function resolveSessionProvider(accountId) {
  const account = await Account.findById(accountId);
  const role = (account && account.role) || 'doctor';
  const pair = await loadProviderPair(accountId, role);
  // loadProviderPair resolves the account too, but prefer the direct lookup
  // so the role is always available even when the provider row is absent.
  return { account: account || pair.account, provider: pair.provider, role };
}

// Lazily materialise a Provider row for a session that doesn't have one yet,
// mirroring the first-save path in `PATCH /doctor/nurse-profile`. Keeps the
// availability / fee writes from 404-ing for a freshly provisioned nurse.
async function ensureProvider(account, role) {
  return Provider.create({
    full_name: (account && account.full_name) || 'Provider',
    email: (account && account.email) || '',
    phone: (account && account.phone) || '',
    role: role === 'nurse' || role === 'helper' ? role : 'doctor',
  });
}

// PATCH /api/provider/availability  { online }
//
// Session-resolved on/off-duty flip. Unlike the legacy
// `PATCH /doctor/availability` (which requires the caller to send the
// Provider._id), this resolves the provider from the bearer session, so the
// Flutter duty toggle never has to know the Provider id. The admin match
// queue reads `availability_status`, so flipping OFFLINE here hides the
// provider from dispatch within one poll cycle.
router.patch('/availability', requireAccountId, async (req, res) => {
  try {
    const body = req.body || {};
    if (typeof body.online !== 'boolean') {
      return res.status(400).json({ message: 'online (boolean) is required' });
    }
    let { provider, account, role } = await resolveSessionProvider(req.accountId);
    if (!provider && !account) {
      return res.status(404).json({ message: 'Provider not found' });
    }
    if (!provider) provider = await ensureProvider(account, role);
    provider.availability_status = body.online ? 'online' : 'offline';
    await provider.save();
    res.json(provider.toJSON());
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// PATCH /api/provider/profile-settings  { fee }
//
// Session-resolved update of the provider's default visit fee / base charge.
// Kept intentionally thin + extensible (future settings slot in alongside
// `fee`). `fee` must be a finite integer >= 0.
router.patch('/profile-settings', requireAccountId, async (req, res) => {
  try {
    const body = req.body || {};
    const rawFee = body.fee;
    const fee = Number(rawFee);
    if (
      rawFee === undefined ||
      rawFee === null ||
      rawFee === '' ||
      !Number.isFinite(fee) ||
      fee < 0 ||
      !Number.isInteger(fee)
    ) {
      return res
        .status(400)
        .json({ message: 'fee must be a non-negative integer' });
    }
    let { provider, account, role } = await resolveSessionProvider(req.accountId);
    if (!provider && !account) {
      return res.status(404).json({ message: 'Provider not found' });
    }
    if (!provider) provider = await ensureProvider(account, role);
    provider.fee = fee;
    await provider.save();
    res.json(provider.toJSON());
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// GET /api/provider/earnings
//
// Settled-vs-pending payout ledger for the signed-in provider. The
// CareRequest `assigned_nurse_id` / `assigned_doctor_id` may hold either an
// Account id or a Provider id (the admin assign path writes whichever it was
// given), so we match against the id SET {provider._id, account._id}.
//   • settled  → payment.released_at is set
//   • pending  → completed / nurse_completed but not yet released
// Amount per ticket prefers payment.total, then payment.nurse_fee, then the
// negotiated final_price / offered_budget so older rows still contribute.
router.get('/earnings', requireAccountId, async (req, res) => {
  try {
    const { provider, account } = await resolveSessionProvider(req.accountId);
    if (!provider && !account) {
      return res.status(404).json({ message: 'Provider not found' });
    }
    const ids = [];
    if (provider && provider._id) ids.push(provider._id.toString());
    if (account && account._id) ids.push(account._id.toString());
    if (req.accountId) ids.push(String(req.accountId));
    const idSet = [...new Set(ids)];

    const rows = await CareRequest.find({
      $or: [
        { assigned_nurse_id: { $in: idSet } },
        { assigned_doctor_id: { $in: idSet } },
      ],
      status: { $in: ['completed', 'nurse_completed'] },
    })
      .sort({ completed_at: -1, updated_at: -1 })
      .lean();

    let totalSettled = 0;
    let totalPending = 0;
    const items = rows.map((r) => {
      const pay = r.payment || {};
      const amount =
        Number(pay.total) > 0
          ? Number(pay.total)
          : Number(pay.nurse_fee) > 0
            ? Number(pay.nurse_fee)
            : Number(r.final_price ?? r.offered_budget) || 0;
      const settled = !!(pay.released_at);
      if (settled) totalSettled += amount;
      else totalPending += amount;
      return {
        id: r._id.toString(),
        patient_name: r.patient_name || '',
        care_type: r.care_type || '',
        completed_at: r.completed_at || r.updated_at || null,
        amount,
        settled,
      };
    });

    res.json({
      total_settled: totalSettled,
      total_pending: totalPending,
      currency: 'BDT',
      items,
    });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

module.exports = router;
