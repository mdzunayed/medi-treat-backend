const bcrypt = require('bcryptjs');
const CareRequest = require('../models/CareRequest');
const Provider = require('../models/Provider');
const Account = require('../models/Account');

const BCRYPT_ROUNDS = 10;

// Statuses that count as "currently in flight" — mirrors
// ACTIVE_SERVICE_STATUSES in routes/admin.js so the telemetry card and the
// Live Monitor count never drift. The spec's 'transit'/'active' vocabulary
// maps onto this canonical DB set.
const ACTIVE_SERVICE_STATUSES = [
  'assigned',
  'enroute',
  'on_the_way',
  'arrived',
  'in_service',
];

const REVENUE_PRICE = { $ifNull: ['$final_price', '$offered_budget'] };

// [start, end) bounds for the calendar day a Date falls in.
function dayBounds(d = new Date()) {
  const start = new Date(d.getFullYear(), d.getMonth(), d.getDate());
  const end = new Date(start);
  end.setDate(start.getDate() + 1);
  return { start, end };
}

function firstCount(facetArr) {
  return Array.isArray(facetArr) && facetArr.length
    ? Number(facetArr[0].n) || 0
    : 0;
}

function firstRevenue(facetArr) {
  if (!Array.isArray(facetArr) || !facetArr.length) {
    return { revenue: 0, visits: 0 };
  }
  return {
    revenue: Number(facetArr[0].revenue) || 0,
    visits: Number(facetArr[0].visits) || 0,
  };
}

/**
 * GET /api/admin/dashboard-telemetry
 *
 * Real-time operations telemetry for the Overview metric cards. The three
 * CareRequest-sourced metrics (active services, emergency alerts, daily +
 * yesterday revenue) are computed in a SINGLE `$facet` aggregation so the
 * collection is scanned once. The fourth metric (pending provider
 * approvals) lives in the `providers` collection, so it runs as a parallel
 * `countDocuments` — both kick off together via `Promise.all`, keeping the
 * handler non-blocking.
 *
 * Response is snake_case to match every other admin endpoint and the
 * Flutter `AdminKpi.fromJson` parser.
 */
async function getDashboardTelemetry(_req, res) {
  try {
    const today = dayBounds();
    const yStart = new Date(today.start);
    yStart.setDate(yStart.getDate() - 1);
    const yesterday = { start: yStart, end: today.start };

    const [facet, pendingApprovals] = await Promise.all([
      CareRequest.aggregate([
        {
          $facet: {
            // activeServices — bookings currently in transit / active.
            activeServices: [
              { $match: { status: { $in: ACTIVE_SERVICE_STATUSES } } },
              { $count: 'n' },
            ],
            // emergencyAlerts — unresolved critical-priority requests.
            emergencyAlerts: [
              {
                $match: {
                  urgency_level: 'critical',
                  status: { $nin: ['completed', 'cancelled', 'rejected'] },
                },
              },
              { $count: 'n' },
            ],
            // dailyRevenue — completed transactions in today's window.
            dailyRevenue: [
              {
                $match: {
                  status: 'completed',
                  created_at: { $gte: today.start, $lt: today.end },
                },
              },
              {
                $group: {
                  _id: null,
                  revenue: { $sum: REVENUE_PRICE },
                  visits: { $sum: 1 },
                },
              },
            ],
            // yesterdayRevenue — for the day-over-day delta badge.
            yesterdayRevenue: [
              {
                $match: {
                  status: 'completed',
                  created_at: { $gte: yesterday.start, $lt: yesterday.end },
                },
              },
              {
                $group: { _id: null, revenue: { $sum: REVENUE_PRICE } },
              },
            ],
          },
        },
      ]),
      // pendingApprovals — providers awaiting verification. Distinct
      // collection, so it can't join the $facet above.
      Provider.countDocuments({ verification_status: 'pending' }),
    ]);

    const f = facet[0] || {};
    const activeServices = firstCount(f.activeServices);
    const emergencyAlerts = firstCount(f.emergencyAlerts);
    const todayRev = firstRevenue(f.dailyRevenue);
    const yesterdayRev = firstRevenue(f.yesterdayRevenue);

    // Day-over-day delta, clamped so the UI never renders "Infinity%".
    let revenueDelta = 0;
    if (yesterdayRev.revenue > 0) {
      revenueDelta =
        ((todayRev.revenue - yesterdayRev.revenue) / yesterdayRev.revenue) *
        100;
    }

    res.json({
      active_services: activeServices,
      pending_approvals: pendingApprovals,
      emergency_alerts: emergencyAlerts,
      daily_revenue: todayRev.revenue,
      revenue_delta: Math.round(revenueDelta * 10) / 10,
      today_visits: todayRev.visits,
    });
  } catch (err) {
    res.status(500).json({ message: err.message || 'Server error' });
  }
}

// ───────────────────────────────────────────────────────────────────────────
// GET /api/admin/live-services
//
// Every visit currently in flight (transit / active), shaped for the Live
// Monitor's real-time list + map. `elapsedMinutes` is measured from the
// row's last status change (`updated_at`); `progressPercent` is the elapsed
// fraction of the scheduled duration, clamped to [0, 1].
// ───────────────────────────────────────────────────────────────────────────
const _LIVE_STATUS_WIRE = {
  enroute: 'on_the_way',
  on_the_way: 'on_the_way',
  assigned: 'on_the_way',
  arrived: 'arrived',
  in_service: 'in_service',
};

async function getLiveServices(_req, res) {
  try {
    const rows = await CareRequest.find({
      status: { $in: ACTIVE_SERVICE_STATUSES },
    })
      .sort({ updated_at: -1 })
      .limit(200);

    const now = Date.now();
    const services = rows.map((doc) => {
      const o = doc.toJSON();
      const since = o.updated_at ? new Date(o.updated_at).getTime() : now;
      const elapsedMinutes = Math.max(0, Math.round((now - since) / 60000));
      const totalMinutes = Math.max(15, (Number(o.duration_hours) || 1) * 60);
      const providerName =
        o.assigned_doctor_name || o.assigned_nurse_name || 'Unassigned';
      const area = o.area || o.location_text || 'Dhaka';
      const wireStatus = _LIVE_STATUS_WIRE[o.status] || 'on_the_way';
      // Arrived holds at 0 progress (waiting to start); otherwise show the
      // elapsed fraction of the scheduled window.
      const progressPercent = wireStatus === 'arrived'
        ? 0
        : Math.min(1, elapsedMinutes / totalMinutes);

      return {
        // Names the Flutter parser reads:
        id: o.id,
        patientName: o.patient_name,
        doctorName: providerName,
        area,
        status: wireStatus,
        progressPercent,
        elapsedMinutes,
        totalMinutes,
        // Spec-named aliases (same data, explicit keys):
        _id: o.id,
        providerName,
        serviceType: o.care_type,
        currentLocationText: area,
      };
    });

    res.json(services);
  } catch (err) {
    res.status(500).json({ message: err.message || 'Server error' });
  }
}

// ───────────────────────────────────────────────────────────────────────────
// PATCH /api/admin/providers/:id/verify
//
// Flips a provider's verification status pending ⇄ verified. Uses
// find-then-save so the Provider pre('save') hook keeps the role-specific
// `is_verified_{doctor,nurse}` badge flags in lockstep.
// ───────────────────────────────────────────────────────────────────────────
async function toggleProviderVerification(req, res) {
  try {
    const provider = await Provider.findById(req.params.id);
    if (!provider) {
      return res
        .status(404)
        .json({ success: false, message: 'Provider not found' });
    }
    provider.verification_status =
      provider.verification_status === 'verified' ? 'pending' : 'verified';
    // The pre-save hook only lights badges ON when verified; clear them
    // explicitly on the way back down to pending.
    if (provider.verification_status === 'pending') {
      provider.is_verified_doctor = false;
      provider.is_verified_nurse = false;
    }
    await provider.save();
    res.json({ success: true, provider: provider.toJSON() });
  } catch (err) {
    res
      .status(500)
      .json({ success: false, message: err.message || 'Server error' });
  }
}

// ───────────────────────────────────────────────────────────────────────────
// POST /api/admin/register-sub-admin   { name, email, password, phone? }
//
// Root-admin-only creation of a secondary admin account. The route guard
// (requireRole('admin')) enforces the base administrative claim; here we
// validate input, bcrypt the password, and persist with role: 'admin'.
// ───────────────────────────────────────────────────────────────────────────
async function registerSubAdmin(req, res) {
  try {
    const b = req.body || {};
    const fullName = (b.name || b.fullName || b.full_name || '').toString().trim();
    const email = (b.email || '').toString().toLowerCase().trim();
    const phone = (b.phone || '').toString().trim();
    const password = (b.password || '').toString();

    if (!fullName) {
      return res
        .status(400)
        .json({ success: false, message: 'name is required' });
    }
    if (!email || !/^\S+@\S+\.\S+$/.test(email)) {
      return res
        .status(400)
        .json({ success: false, message: 'A valid email is required' });
    }
    if (password.length < 8) {
      return res.status(400).json({
        success: false,
        message: 'Password must be at least 8 characters',
      });
    }

    const dupe = await Account.findOne({ email });
    if (dupe) {
      return res.status(409).json({
        success: false,
        message: 'An account with that email already exists.',
      });
    }

    const password_hash = await bcrypt.hash(password, BCRYPT_ROUNDS);
    const account = await Account.create({
      full_name: fullName,
      email,
      phone: phone || undefined,
      password_hash,
      role: 'admin',
      status: 'active',
      // A self-chosen password — admin is active immediately, no forced
      // reset (unlike the auto-provisioned doctor/nurse flow).
      is_verified: true,
      requires_password_reset: false,
    });

    console.log(
      `[admin] sub-admin created by admin=${req.accountId}: account=${account._id}`,
    );

    return res.status(201).json({
      success: true,
      message: 'Admin account created.',
      account: account.toJSON(),
    });
  } catch (err) {
    if (err && err.code === 11000) {
      return res.status(409).json({
        success: false,
        message: 'An account with those identifiers already exists.',
      });
    }
    return res
      .status(500)
      .json({ success: false, message: err.message || 'Server error' });
  }
}

module.exports = {
  getDashboardTelemetry,
  getLiveServices,
  toggleProviderVerification,
  registerSubAdmin,
};
