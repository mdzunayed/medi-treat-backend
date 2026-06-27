const express = require('express');
const mongoose = require('mongoose');
const CareRequest = require('../models/CareRequest');
const Provider = require('../models/Provider');
const Account = require('../models/Account');
const { maskPayoutInJSON } = require('../utils/payout');
const { attachAccountId } = require('../middleware/auth');

const router = express.Router();

// Populate `req.accountId` / `req.accountRole` from the bearer token (or the
// `x-account-id` / `?account_id=` fallbacks) on every doctor route WITHOUT
// forcing a 401 — the read endpoints below use it to key data off the
// authenticated clinician's own identity rather than a client-supplied id.
router.use(attachAccountId);

// Prefer the authenticated clinician's OWN id (from the decoded token) over a
// client-supplied id, so a provider session always reads its own appointments
// / earnings / records and can never be pointed at a different (or
// administrative) id by tampering with the request. Falls back to the URL /
// query id only when the caller isn't a signed-in doctor/nurse (e.g. an
// internal tool or a test hitting the route without a provider token).
function sessionProviderId(req, fallbackId) {
  if (
    req.accountId &&
    (req.accountRole === 'doctor' || req.accountRole === 'nurse')
  ) {
    return req.accountId;
  }
  return fallbackId;
}

// ---------------------------------------------------------------------------
// Profile-completion engine. Shared between the dashboard payload, the
// dedicated `/profile-status` endpoint, and the post-save responses on
// `/work-experience` and `/payout-details` so the percentage never
// drifts between surfaces.
//
// Each of five items represents exactly 20% of the profile:
//   1. Profile photo               2. BMDC license number
//   3. Specialization details      4. Work experience (≥ 1 entry)
//   5. Bank / bKash payout details
// ---------------------------------------------------------------------------

function nonEmptyString(v) {
  return typeof v === 'string' && v.trim().length > 0;
}

function computeProfileStatus(provider, account) {
  const p = provider || {};
  const a = account || {};
  const isNurse = (p.role || a.role) === 'nurse';

  const has_photo =
    nonEmptyString(p.profile_picture) ||
    nonEmptyString(a.profile_picture) ||
    nonEmptyString(a.photo_url);
  const has_bmdc = nonEmptyString(p.bmdc_license);
  const has_nursing_license = nonEmptyString(p.nursing_license);
  // Unified license flag — the row label changes by role on the client,
  // but the status engine only cares that *some* license is filled in.
  const has_license = isNurse ? has_nursing_license : has_bmdc;
  const has_specialty = nonEmptyString(p.specialization);
  const has_experience = Array.isArray(p.experience) && p.experience.length > 0;
  const has_payout =
    !!(p.payout_details &&
       p.payout_details.method &&
       nonEmptyString(p.payout_details.account_number));

  const flags = [has_photo, has_license, has_specialty, has_experience, has_payout];
  const done = flags.filter(Boolean).length;
  return {
    has_photo,
    has_bmdc,
    has_nursing_license,
    has_license,
    has_specialty,
    has_experience,
    has_payout,
    completion_percent: done * 20,
    items_remaining: 5 - done,
    role: isNurse ? 'nurse' : 'doctor',
  };
}

// Same Account-id ↔ Provider-id resolution we use in `GET /doctor/profile`,
// extracted so the new status + experience + payout endpoints can share
// it. Role-aware: when the seed Account belongs to a nurse, the Provider
// lookup looks for `role: 'nurse'` rather than 'doctor'. Returns
// `{ account, provider }` where either may be null. The caller decides
// what to do when both are null.
async function resolveDoctor(doctorId) {
  if (!doctorId || !mongoose.isValidObjectId(doctorId)) {
    return { account: null, provider: null };
  }
  let provider = await Provider.findById(doctorId);
  let account = null;
  if (provider) {
    // Backfill account by email if possible (purely for completeness
    // calculations — we don't need it for writes).
    if (provider.email) {
      account = await Account.findOne({ email: provider.email });
    }
  } else {
    account = await Account.findById(doctorId);
    if (account) {
      // Mirror the account's role onto the Provider lookup so a nurse
      // account links to its nurse Provider row and not some unrelated
      // doctor with the same name.
      const providerRole = account.role === 'nurse' ? 'nurse' : 'doctor';
      if (account.email) {
        provider = await Provider.findOne({
          email: account.email,
          role: providerRole,
        });
      }
      if (!provider) {
        provider = await Provider.findOne({
          full_name: account.full_name,
          role: providerRole,
        });
      }
    }
  }
  return { account, provider };
}

// Build the full set of ids a clinician's visits could be filed under. The
// admin assign path historically wrote EITHER the Account._id OR the linked
// Provider._id onto `assigned_doctor_id`/`assigned_nurse_id`. A read that
// matches only the id the client sent (usually the Account id) therefore
// silently returns ZERO rows whenever admin stored the other id — the root
// cause of the "No patient records / No active visits / ৳0" dashboards.
// Resolving to BOTH ids and matching `$in` fixes it without changing what the
// client sends. Returns a deduped array of id strings (possibly just `[id]`).
async function resolveProviderIds(id) {
  const ids = new Set();
  if (id) ids.add(id.toString());
  const { account, provider } = await resolveDoctor(id);
  if (account && account._id) ids.add(account._id.toString());
  if (provider && provider._id) ids.add(provider._id.toString());
  return [...ids];
}

const ACTIVE_DOCTOR_STATUSES = ['assigned', 'enroute', 'arrived', 'in_service'];

// --- Earnings aggregation -------------------------------------------------
// The dashboard, the dedicated /doctor/:id/stats endpoint, and the
// "complete visit" success path all need the same {earnings, visits}
// rollup. Sharing one helper guarantees they never drift.
function dayBoundsForDoctor(d = new Date()) {
  const start = new Date(d.getFullYear(), d.getMonth(), d.getDate());
  const end = new Date(start);
  end.setDate(start.getDate() + 1);
  return { start, end };
}

function weekBoundsForDoctor(d = new Date()) {
  const start = new Date(d.getFullYear(), d.getMonth(), d.getDate());
  start.setDate(start.getDate() - 6); // last 7 days inclusive of today
  const end = new Date(d.getFullYear(), d.getMonth(), d.getDate());
  end.setDate(end.getDate() + 1);
  return { start, end };
}

// Sum the doctor's completed-visit revenue in [start, end). Uses
// `final_price` when set (admin negotiated price), falling back to the
// patient's `offered_budget` so older visits still contribute.
async function doctorEarnings(providerIds, start, end) {
  const ids = Array.isArray(providerIds) ? providerIds : [providerIds];
  if (!ids.length) return { earnings: 0, visits: 0 };
  const rows = await CareRequest.aggregate([
    {
      $match: {
        // Union both sides so a nurse session also collects their
        // completed-visit revenue from the same aggregation. Match the
        // clinician's full id set (Account + Provider) so revenue isn't
        // dropped when admin filed the visit under the other id form.
        $or: [
          { assigned_doctor_id: { $in: ids } },
          { assigned_nurse_id: { $in: ids } },
        ],
        status: 'completed',
        updated_at: { $gte: start, $lt: end },
      },
    },
    {
      $group: {
        _id: null,
        earnings: {
          $sum: { $ifNull: ['$final_price', '$offered_budget'] },
        },
        visits: { $sum: 1 },
      },
    },
  ]);
  if (!rows.length) return { earnings: 0, visits: 0 };
  return {
    earnings: Number(rows[0].earnings) || 0,
    visits: Number(rows[0].visits) || 0,
  };
}

// GET /doctor/dashboard?doctor_id=
// Builds the dashboard payload the Flutter doctorDashboardFromMongo expects.
router.get('/dashboard', async (req, res) => {
  try {
    // Identity comes from the decoded token first (tamper-proof), falling
    // back to the `?doctor_id=` only for non-provider/internal callers.
    const identityId = sessionProviderId(req, req.query.doctor_id);
    // Resolve the clinician to their FULL id set (Account + Provider) so the
    // match works regardless of which id form admin filed the assignment
    // under. Without this the dashboard zeroes out for a session whose id
    // doesn't equal the stored `assigned_*_id`.
    const providerIds = identityId ? await resolveProviderIds(identityId) : [];
    const filter = { status: { $in: ACTIVE_DOCTOR_STATUSES } };
    // The same dashboard surface backs both the doctor and the nurse
    // session. Match when the signed-in id is on EITHER side of the
    // assignment — that way a nurse-only visit (no doctor yet) still
    // shows up on the nurse's "Upcoming today" list.
    if (providerIds.length) {
      filter.$or = [
        { assigned_doctor_id: { $in: providerIds } },
        { assigned_nurse_id: { $in: providerIds } },
      ];
    }

    const rows = await CareRequest.find(filter).sort({ preferred_time: 1 });

    const upcoming = rows.map((d) => {
      const o = d.toJSON();
      return {
        id: o.id,
        patient_name: o.patient_name,
        patient_phone: o.patient_phone,        // for the Message / call CTA
        patient_account_id: o.patient_account_id, // for the chat surface
        care_type: o.care_type,
        final_price: o.final_price,
        offered_budget: o.offered_budget,
        preferred_time: o.preferred_time,
        location_text: o.location_text,
        status: o.status,                       // drives the doctor-side state machine
      };
    });

    // Real earnings rollup. The Doctor's "TODAY / WEEK" cards read these
    // values, so any drift here is visible immediately as a wrong
    // rupee total on the dashboard.
    const today = dayBoundsForDoctor();
    const week = weekBoundsForDoctor();
    // Earnings + resolved-doctor lookup in parallel. The resolver
    // walks both Account and Provider so the completion engine has
    // both rows for the boolean checks even when the session id
    // belongs to the other collection.
    const [{ account, provider }, todayStats, weekStats] = await Promise.all([
      identityId
        ? resolveDoctor(identityId)
        : Promise.resolve({ account: null, provider: null }),
      providerIds.length
        ? doctorEarnings(providerIds, today.start, today.end)
        : { earnings: 0, visits: 0 },
      providerIds.length
        ? doctorEarnings(providerIds, week.start, week.end)
        : { earnings: 0, visits: 0 },
    ]);

    const status = computeProfileStatus(provider, account);

    res.json({
      today_earnings: todayStats.earnings,
      today_visits: todayStats.visits,
      week_earnings: weekStats.earnings,
      week_visits: weekStats.visits,
      rating: provider ? provider.rating : 0,
      review_count: provider ? provider.review_count : 0,
      unread_count: 0,
      // Real completion percentage derived from field presence. The
      // banner on the dashboard reads this; the per-item booleans are
      // also exposed so the credentials sheet can render without a
      // second roundtrip.
      profile_completeness: status.completion_percent,
      profile_checklist: status,
      availability: provider ? provider.availability_status === 'online' : true,
      latest_review: null,
      reviews: [],
      pending_assignment: null,
      upcoming_today: upcoming,
    });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// Hardcoded rating fallback for accounts that don't have a matching
// providers row yet (e.g. the seeded `doctor@meditreat.app` Account
// whose Provider doc lives under a different _id). Swap for a real
// review aggregation once feedback ships.
const DEFAULT_RATING = 4.8;
const DEFAULT_REVIEW_COUNT = 0;

// GET /doctor/:id/stats — earnings/visits rollup for the Doctor
// dashboard's TODAY / WEEK tiles. Polled every 15 s and invalidated
// immediately after "Complete Visit" returns 200.
//
// Defensive shape:
//   • Validates the `:id` is a real ObjectId so a malformed URL returns
//     400 instead of throwing inside the aggregation pipeline.
//   • Falls back to the hardcoded rating when no Provider row matches
//     this id — the Flutter session uses the Account `_id`, which is
//     unrelated to the Provider `_id`. Returning a clean zeroed
//     payload is correct (no earnings yet) AND keeps the dashboard
//     from blanking with a 404.
router.get('/:id/stats', async (req, res) => {
  try {
    const doctorId = sessionProviderId(req, req.params.id);
    if (!mongoose.isValidObjectId(doctorId)) {
      return res.status(400).json({ message: 'Invalid doctor id' });
    }
    const today = dayBoundsForDoctor();
    const week = weekBoundsForDoctor();
    // Match the clinician's full id set so TODAY/WEEK earnings aren't zeroed
    // when admin filed the visit under the Provider id but the session
    // queries by Account id (or vice-versa). `resolveDoctor` also yields the
    // Provider row for rating/reviews even when `doctorId` is an Account id.
    const [ids, { provider }] = await Promise.all([
      resolveProviderIds(doctorId),
      resolveDoctor(doctorId),
    ]);
    const [todayStats, weekStats] = await Promise.all([
      doctorEarnings(ids, today.start, today.end),
      doctorEarnings(ids, week.start, week.end),
    ]);
    res.json({
      today_earnings: todayStats.earnings,
      today_visits: todayStats.visits,
      week_earnings: weekStats.earnings,
      week_visits: weekStats.visits,
      rating: provider ? (provider.rating || DEFAULT_RATING) : DEFAULT_RATING,
      review_count: provider
        ? (provider.review_count || DEFAULT_REVIEW_COUNT)
        : DEFAULT_REVIEW_COUNT,
    });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// POST /doctor/location  { doctor_id, latitude, longitude,
//                           accuracy_meters?, speed_mps? }
//
// Heartbeat from the Doctor app's LocationTrackingService. Writes a
// GeoJSON Point to the matching record so the admin's match scoring
// can later run nearest-doctor queries via a `2dsphere` index.
//
// Look-up order: Account first (the Flutter session id maps here),
// Provider second (covers callers that pass the providers `_id`
// directly, e.g. seeded doctors). At least one must match or we 404.
router.post('/location', async (req, res) => {
  try {
    const b = req.body || {};
    const doctorId = b.doctor_id;
    const lat = Number(b.latitude);
    const lng = Number(b.longitude);

    if (!doctorId) {
      return res.status(400).json({ message: 'doctor_id is required' });
    }
    if (!mongoose.isValidObjectId(doctorId)) {
      return res.status(400).json({ message: 'Invalid doctor_id' });
    }
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) {
      return res.status(400).json({
        message: 'latitude and longitude must be numbers',
      });
    }
    // Defensive range check — outside this envelope the coordinates
    // are almost certainly a unit/format bug, not a real fix.
    if (lat < -90 || lat > 90 || lng < -180 || lng > 180) {
      return res.status(400).json({
        message: 'latitude/longitude are out of range',
      });
    }

    const current_location = {
      type: 'Point',
      coordinates: [lng, lat], // GeoJSON spec: [longitude, latitude]
      accuracy_meters: Number.isFinite(Number(b.accuracy_meters))
        ? Number(b.accuracy_meters)
        : null,
      speed_mps: Number.isFinite(Number(b.speed_mps))
        ? Number(b.speed_mps)
        : null,
      updated_at: new Date(),
    };

    // Try Account first (logged-in doctor id), then Provider, in
    // parallel — whichever matched gets the write applied. Two writes
    // are safe because each is conditional on the id existing in that
    // collection.
    const [acctRes, provRes] = await Promise.all([
      Account.updateOne(
        { _id: doctorId },
        { $set: { current_location } }
      ),
      Provider.updateOne(
        { _id: doctorId },
        { $set: { current_location } }
      ).catch(() => ({ matchedCount: 0 })),
    ]);

    const matched =
      (acctRes.matchedCount || 0) + (provRes.matchedCount || 0);
    if (matched === 0) {
      return res.status(404).json({
        success: false,
        message: 'Doctor not found',
      });
    }

    return res.json({
      success: true,
      message: 'Location updated successfully',
    });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// POST /doctor/availability  { doctor_id, online } — legacy back-compat.
// New code should use PATCH /doctor/availability below; this stays so
// existing Flutter builds keep working until they redeploy.
router.post('/availability', async (req, res) => {
  try {
    const { doctor_id, online } = req.body || {};
    if (doctor_id) {
      await Provider.findByIdAndUpdate(doctor_id, {
        availability_status: online ? 'online' : 'offline',
      });
    }
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// PATCH /doctor/availability  { doctor_id, online }
// Returns the updated Provider so the Flutter notifier can swap in the new
// `availability_status` without a follow-up GET. The admin's match queue
// reads this field, so a doctor flipping OFFLINE here is invisible to
// admin dispatch within one poll cycle.
router.patch('/availability', async (req, res) => {
  try {
    const { doctor_id, online } = req.body || {};
    if (!doctor_id) {
      return res.status(400).json({ message: 'doctor_id is required' });
    }
    const provider = await Provider.findByIdAndUpdate(
      doctor_id,
      { availability_status: online ? 'online' : 'offline' },
      { new: true }
    );
    if (!provider) return res.status(404).json({ message: 'Doctor not found' });
    res.json(provider.toJSON());
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// Fields the doctor profile screen is allowed to mutate. Verification /
// rating / review_count are admin-controlled and explicitly excluded.
// `bio` + `hospital_affiliation` are the new professional fields that
// land on the Profile redesign. `is_verified_doctor` is editable too so
// the admin / QA tools can light up the badge for testing without
// going through the full verification workflow.
const DOCTOR_EDITABLE_FIELDS = [
  'full_name',
  'email',
  'phone',
  'specialization',
  'specialty',
  'years_experience',
  'fee',
  'service_radius_km',
  'bio',
  'hospital_affiliation',
  'is_verified_doctor',
  'is_verified_nurse',
  'bmdc_license',
  'nursing_license',
  'role',
];

function pickDoctorFields(body) {
  const out = {};
  for (const k of DOCTOR_EDITABLE_FIELDS) {
    if (body[k] !== undefined && body[k] !== null) {
      out[k] = typeof body[k] === 'string' ? body[k].trim() : body[k];
    }
  }
  return out;
}

// GET /doctor/profile?doctor_id=
//
// Resilient lookup. The Flutter session id is the Account `_id`, but
// professional fields (specialty, fee, bio, hospital_affiliation,
// rating, …) live on the Provider row. The two collections have
// unrelated `_id` values, so the old "Provider.findById(account_id)"
// path returned 404 for every signed-in doctor. We now:
//
//   1. Try Provider.findById  → exact id match wins.
//   2. Else Account.findById  → identity row by Account id.
//   3. Find the linked Provider via Account.email (preferred) and
//      fall back to a `full_name + role:'doctor'` match.
//   4. Merge the two into one response — identity from Account,
//      professional from Provider — so the Flutter Profile screen
//      always has both.
//
// 404 only when neither collection has a matching row.
router.get('/profile', async (req, res) => {
  try {
    const { doctor_id } = req.query;
    if (!doctor_id || !mongoose.isValidObjectId(doctor_id)) {
      return res.status(400).json({ message: 'doctor_id is required' });
    }

    // Path 1 — direct provider hit (admin tools pass the Provider id).
    let provider = await Provider.findById(doctor_id);
    let account = null;

    if (!provider) {
      // Path 2 — account id, then resolve the linked provider.
      account = await Account.findById(doctor_id);
      if (!account) {
        return res.status(404).json({ message: 'Doctor not found' });
      }
      if (account.email) {
        provider = await Provider.findOne({
          email: account.email,
          role: 'doctor',
        });
      }
      if (!provider) {
        provider = await Provider.findOne({
          full_name: account.full_name,
          role: 'doctor',
        });
      }
    }

    // Fold both rows into one response. Provider wins for professional
    // fields it owns; Account fills identity. Empty objects are safe —
    // the spread just no-ops.
    const accountJson = account ? account.toJSON() : {};
    const providerJson = provider ? provider.toJSON() : {};
    const merged = {
      // Identity bias toward Account when present (it's the
      // source-of-truth for what the user signed up with).
      ...providerJson,
      full_name: accountJson.full_name || providerJson.full_name,
      email: accountJson.email || providerJson.email || '',
      phone: accountJson.phone || providerJson.phone || '',
      address: accountJson.address || '',
      // Profile picture lives on both rows from the avatar upload —
      // prefer the explicit uploaded photo over the OAuth photo_url.
      profile_picture:
        accountJson.profile_picture ||
        providerJson.profile_picture ||
        accountJson.photo_url ||
        '',
      // Keep the Account id as the canonical `id` so subsequent edits
      // from Flutter (which only has Account.id in the session) still
      // route through the new PUT /api/users/:id/profile endpoint.
      id: accountJson.id || providerJson.id,
      provider_id: providerJson.id || null,
      created_at: accountJson.created_at || providerJson.created_at,
    };
    res.json(merged);
  } catch (err) {
    console.error('[doctor.profile]', err);
    res.status(500).json({ message: err.message });
  }
});

// PATCH /doctor/profile  { doctor_id, ...editable fields }
// Partial update via findByIdAndUpdate — a save touching only `phone`
// does not wipe `specialization`, `fee`, etc.
router.patch('/profile', async (req, res) => {
  try {
    const body = req.body || {};
    const doctorId = body.doctor_id;
    if (!doctorId) {
      return res.status(400).json({ message: 'doctor_id is required' });
    }
    const updates = pickDoctorFields(body);
    if (Object.keys(updates).length === 0) {
      return res.status(400).json({ message: 'No editable fields supplied' });
    }
    const provider = await Provider.findByIdAndUpdate(
      doctorId,
      { $set: updates },
      { new: true, runValidators: true }
    );
    if (!provider) return res.status(404).json({ message: 'Doctor not found' });
    res.json(provider.toJSON());
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// ---------------------------------------------------------------------------
// Nurse professional profile. Distinct from the doctor profile path so the
// nurse-specific field labels (BNMC registration via `nursing_license`)
// resolve cleanly. Uses the role-aware `resolveDoctor` so a nurse Account
// id links to its nurse Provider row, and creates that Provider row on the
// first save when one doesn't exist yet.
// ---------------------------------------------------------------------------

// Whitelist of nurse-editable Provider fields (snake_case canonical).
const NURSE_EDITABLE = [
  'nursing_license',
  'specialization',
  'years_experience',
  'hospital_affiliation',
  'bio',
];

function pickNurseFields(body) {
  const b = body || {};
  const out = {};
  // snake_case + camelCase aliases the Flutter client may send.
  const aliases = {
    nursingLicense: 'nursing_license',
    yearsExperience: 'years_experience',
    hospitalAffiliation: 'hospital_affiliation',
  };
  for (const [k, v] of Object.entries(b)) {
    if (v === undefined || v === null) continue;
    const key = aliases[k] || k;
    if (!NURSE_EDITABLE.includes(key)) continue;
    out[key] =
      key === 'years_experience'
        ? Number(v) || 0
        : typeof v === 'string'
        ? v.trim()
        : v;
  }
  return out;
}

// GET /doctor/nurse-profile?account_id= — merged identity + professional
// fields for the signed-in nurse.
router.get('/nurse-profile', async (req, res) => {
  try {
    const accountId = req.query.account_id || req.query.doctor_id;
    if (!accountId || !mongoose.isValidObjectId(accountId)) {
      return res.status(400).json({ message: 'account_id is required' });
    }
    const { account, provider } = await resolveDoctor(accountId);
    if (!account && !provider) {
      return res.status(404).json({ message: 'Nurse not found' });
    }
    const a = account ? account.toJSON() : {};
    const p = provider ? provider.toJSON() : {};
    res.json({
      id: a.id || accountId,
      provider_id: p.id || null,
      full_name: a.full_name || p.full_name || '',
      email: a.email || p.email || '',
      phone: a.phone || p.phone || '',
      profile_picture:
        a.profile_picture || p.profile_picture || a.photo_url || '',
      nursing_license: p.nursing_license || '',
      specialization: p.specialization || '',
      years_experience: p.years_experience || 0,
      hospital_affiliation: p.hospital_affiliation || '',
      bio: p.bio || '',
      fee: p.fee || 0,
      availability_status: p.availability_status || 'offline',
      verification_status: p.verification_status || 'pending',
      is_verified_nurse: p.is_verified_nurse || false,
    });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// PATCH /doctor/nurse-profile { account_id, nursing_license, specialization,
//   years_experience, hospital_affiliation, bio }
router.patch('/nurse-profile', async (req, res) => {
  try {
    const body = req.body || {};
    const accountId = body.account_id || body.doctor_id;
    if (!accountId || !mongoose.isValidObjectId(accountId)) {
      return res.status(400).json({ message: 'account_id is required' });
    }
    const updates = pickNurseFields(body);
    if (Object.keys(updates).length === 0) {
      return res.status(400).json({ message: 'No editable fields supplied' });
    }
    // eslint-disable-next-line prefer-const
    let { account, provider } = await resolveDoctor(accountId);
    if (!account && !provider) {
      return res.status(404).json({ message: 'Nurse not found' });
    }
    if (!provider) {
      // First save — materialise the nurse's Provider row, linked to the
      // Account by identity so future `resolveDoctor` calls find it.
      provider = await Provider.create({
        full_name: (account && account.full_name) || 'Nurse',
        email: (account && account.email) || '',
        phone: (account && account.phone) || '',
        role: 'nurse',
        ...updates,
      });
    } else {
      provider = await Provider.findByIdAndUpdate(
        provider._id,
        { $set: updates },
        { new: true, runValidators: true }
      );
    }
    res.json(provider.toJSON());
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// ---------------------------------------------------------------------------
// Complete-your-profile sheet endpoints
//
//   GET /doctor/profile-status         → per-item booleans + percentage
//   PUT /doctor/work-experience        → replaces the experience array
//   PUT /doctor/payout-details         → upserts the payout sub-doc
//
// All three accept the same doctor id resolver as `/doctor/profile`, so
// the Flutter session id (which is the Account `_id`) works alongside
// admin tools that pass a Provider `_id` directly.
// ---------------------------------------------------------------------------

router.get('/profile-status', async (req, res) => {
  try {
    const { doctor_id } = req.query;
    const { account, provider } = await resolveDoctor(doctor_id);
    if (!account && !provider) {
      return res.status(404).json({
        success: false,
        message: 'Doctor not found',
      });
    }
    const status = computeProfileStatus(provider, account);
    res.json({
      success: true,
      status,
      provider: maskPayoutInJSON(provider),
    });
  } catch (err) {
    console.error('[doctor.profile-status]', err);
    res.status(500).json({ success: false, message: err.message });
  }
});

// PUT /doctor/work-experience  { doctor_id, experience: [{hospital_name|hospitalName, designation, years}] }
//
// Replaces the experience array (the Flutter sheet sends the full list
// because the modal renders existing entries above the add form, so a
// full set is always what the client has in memory). Validates each
// entry — empty hospital_name or designation rejects the whole payload
// rather than silently saving partial garbage.
router.put('/work-experience', async (req, res) => {
  try {
    const body = req.body || {};
    const { account, provider } = await resolveDoctor(body.doctor_id);
    if (!provider && !account) {
      return res.status(404).json({
        success: false,
        message: 'Doctor not found',
      });
    }
    const rawList = Array.isArray(body.experience) ? body.experience : [];
    if (rawList.length > 20) {
      return res.status(400).json({
        success: false,
        message: 'Too many experience entries (max 20)',
      });
    }
    const cleaned = [];
    for (const raw of rawList) {
      const hospital = String(raw.hospital_name ?? raw.hospitalName ?? '').trim();
      const designation = String(raw.designation ?? '').trim();
      const years = Number(raw.years ?? 0);
      if (!hospital || !designation) {
        return res.status(400).json({
          success: false,
          message: 'Every experience entry needs a hospital and a designation',
        });
      }
      cleaned.push({
        hospital_name: hospital,
        designation,
        years: Number.isFinite(years) ? years : 0,
        started_at: raw.started_at ? new Date(raw.started_at) : null,
        ended_at: raw.ended_at ? new Date(raw.ended_at) : null,
      });
    }
    const target = provider || (await Provider.findOne({
      full_name: account.full_name,
      role: 'doctor',
    }));
    if (!target) {
      // Account exists but no Provider row to attach the experience to.
      // We don't auto-create one here — admin Assign Team creates the
      // Provider row, and the doctor profile screen surfaces the
      // "complete your profile" sheet only for known doctors anyway.
      return res.status(404).json({
        success: false,
        message: 'No provider row linked to this doctor account',
      });
    }
    target.experience = cleaned;
    await target.save();
    const status = computeProfileStatus(target, account);
    res.json({
      success: true,
      message: 'Work experience updated',
      status,
      provider: maskPayoutInJSON(target),
    });
  } catch (err) {
    console.error('[doctor.work-experience]', err);
    res.status(500).json({ success: false, message: err.message });
  }
});

// PUT /doctor/payout-details
//   body: { doctor_id, method: 'bKash'|'Bank',
//           accountNumber|account_number,
//           accountName?, bankName?, branch? }
//
// Stores plaintext; reads always go through `maskPayoutInJSON` so the
// account_number never leaves the server unmasked. `method` is enum-
// gated by the schema, but we validate it here too so the response is
// a friendly 400 instead of a Mongoose ValidationError.
router.put('/payout-details', async (req, res) => {
  try {
    const body = req.body || {};
    const { account, provider } = await resolveDoctor(body.doctor_id);
    if (!provider && !account) {
      return res.status(404).json({
        success: false,
        message: 'Doctor not found',
      });
    }
    const method = String(body.method || '').trim();
    if (!['bKash', 'Bank'].includes(method)) {
      return res.status(400).json({
        success: false,
        message: "method must be 'bKash' or 'Bank'",
      });
    }
    const accountNumber = String(
      body.accountNumber ?? body.account_number ?? ''
    ).trim();
    if (!accountNumber) {
      return res.status(400).json({
        success: false,
        message: 'account number is required',
      });
    }
    const target = provider || (await Provider.findOne({
      full_name: account.full_name,
      role: 'doctor',
    }));
    if (!target) {
      return res.status(404).json({
        success: false,
        message: 'No provider row linked to this doctor account',
      });
    }
    target.payout_details = {
      method,
      account_number: accountNumber,
      account_name: String(body.accountName ?? body.account_name ?? '').trim(),
      bank_name: String(body.bankName ?? body.bank_name ?? '').trim(),
      branch: String(body.branch ?? '').trim(),
      updated_at: new Date(),
    };
    await target.save();
    const status = computeProfileStatus(target, account);
    res.json({
      success: true,
      message: 'Payout details updated',
      status,
      provider: maskPayoutInJSON(target),
    });
  } catch (err) {
    console.error('[doctor.payout-details]', err);
    res.status(500).json({ success: false, message: err.message });
  }
});

// Generic status transition. `on_the_way` is accepted as an alias for the
// canonical `enroute` so the wire vocabulary matches both the Flutter
// enum and the legacy "on_the_way" copy.
const VALID_STATUSES = new Set([
  'submitted', 'approved', 'assigned',
  'enroute', 'on_the_way',
  'arrived', 'in_service', 'completed',
  'rejected', 'cancelled',
]);

// PATCH /doctor/visits/:id/status  { status }
// Used by the Active Service screen's state machine button:
//   on_the_way → arrived → in_service → completed
router.patch('/visits/:id/status', async (req, res) => {
  try {
    const raw = (req.body && req.body.status) ? String(req.body.status).toLowerCase() : '';
    if (!VALID_STATUSES.has(raw)) {
      return res.status(400).json({
        message: `status must be one of: ${[...VALID_STATUSES].join(', ')}`,
      });
    }
    // Normalize the legacy `on_the_way` to the schema enum value.
    const status = raw === 'on_the_way' ? 'enroute' : raw;

    // Stamp the finish time on completion so the patient History card
    // reads it directly off the row (mirrors appointments.js).
    const update = { status };
    if (status === 'completed') update.completed_at = new Date();

    const doc = await CareRequest.findByIdAndUpdate(
      req.params.id,
      update,
      { new: true }
    );
    if (!doc) return res.status(404).json({ message: 'Request not found' });

    // Room broadcast — the patient/doctor chat input gate subscribes to
    // this event to lock the conversation the moment the visit closes.
    // Mirrors POST /api/appointments/:id/update-status so the Active Care
    // Console's "Complete Visit" tears down the live chat room without a
    // separate socket call. We emit the wire-status the client expects.
    const io = req.app.get('io');
    if (io) {
      io.to(String(req.params.id)).emit('appointment_status_change', {
        appointmentId: String(req.params.id),
        status: raw,
        dbStatus: status,
        timestamp: new Date().toISOString(),
      });
    }

    res.json(doc.toJSON());
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// POST /doctor/assignments/:id/accept  → enroute
router.post('/assignments/:id/accept', async (req, res) => {
  try {
    // Atomic compare-and-swap: only the FIRST accept that finds the
    // request still in `assigned` wins the transition to `enroute`. A
    // racing second tap matches zero documents and is rejected — strict
    // mutual exclusion with no read-then-write window.
    const doc = await CareRequest.findOneAndUpdate(
      { _id: req.params.id, status: 'assigned' },
      { status: 'enroute' },
      { new: true }
    );
    if (!doc) {
      const stillExists = await CareRequest.exists({ _id: req.params.id });
      return res.status(stillExists ? 409 : 404).json({
        message: stillExists
          ? 'This dispatch is no longer available — it was already accepted or reassigned.'
          : 'Request not found',
      });
    }
    res.json(doc.toJSON());
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// POST /doctor/assignments/:id/decline  → back to approved (unassign)
router.post('/assignments/:id/decline', async (req, res) => {
  try {
    // Guarded so a decline only applies while the visit is still in an
    // active, pre-completion state — you can't unassign a visit that has
    // already finished or been cancelled out from under you.
    const doc = await CareRequest.findOneAndUpdate(
      { _id: req.params.id, status: { $in: ['assigned', 'enroute', 'arrived'] } },
      {
        status: 'approved',
        assigned_doctor_id: null,
        assigned_doctor_name: null,
      },
      { new: true }
    );
    if (!doc) {
      const stillExists = await CareRequest.exists({ _id: req.params.id });
      return res.status(stillExists ? 409 : 404).json({
        message: stillExists
          ? 'This dispatch can no longer be declined — its state has already changed.'
          : 'Request not found',
      });
    }
    res.json(doc.toJSON());
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// ---------------------------------------------------------------------------
// Patient Records + Medical Vault — backs the Doctor Operations Hub's
// "Patient Records" tab and the Active Care Console's medical-vault grid.
// ---------------------------------------------------------------------------

const BLOOD_TYPES = ['O+', 'O-', 'A+', 'A-', 'B+', 'B-', 'AB+', 'AB-', 'Unknown'];

// Normalise a stored (or absent) medical_vault sub-doc into the stable
// shape the Flutter `PatientMedicalVault` model parses.
function vaultJson(v) {
  const m = v || {};
  return {
    allergies: Array.isArray(m.allergies) ? m.allergies : [],
    chronic_conditions: Array.isArray(m.chronic_conditions)
      ? m.chronic_conditions
      : [],
    blood_type: m.blood_type || 'Unknown',
    emergency_notes: m.emergency_notes || '',
    updated_at: m.updated_at || null,
  };
}

// GET /doctor/:doctorId/patients?search=
// Patients this provider has treated, deduped from completed visits.
// Mirrors the `doctorEarnings` $match (either side of the assignment +
// status:'completed') but groups by patient_account_id so each patient
// appears once with a visit count and last-seen timestamp.
router.get('/:doctorId/patients', async (req, res) => {
  try {
    const doctorId = sessionProviderId(req, req.params.doctorId);
    const search = (req.query.search || '').toString().trim();
    const providerIds = await resolveProviderIds(doctorId);
    const match = {
      $or: [
        { assigned_doctor_id: { $in: providerIds } },
        { assigned_nurse_id: { $in: providerIds } },
      ],
      status: 'completed',
    };
    if (search) match.patient_name = { $regex: search, $options: 'i' };

    const rows = await CareRequest.aggregate([
      { $match: match },
      { $sort: { updated_at: -1 } },
      {
        $group: {
          _id: '$patient_account_id',
          patientName: { $first: '$patient_name' },
          patientPhone: { $first: '$patient_phone' },
          locationText: { $first: '$location_text' },
          lastCareType: { $first: '$care_type' },
          lastVisitAt: { $max: { $ifNull: ['$completed_at', '$updated_at'] } },
          visitCount: { $sum: 1 },
        },
      },
      { $sort: { lastVisitAt: -1 } },
    ]);

    const patients = rows
      // Drop legacy visits that never carried a patient account id —
      // they can't be opened into a record detail anyway.
      .filter((r) => r._id)
      .map((r) => ({
        patient_account_id: String(r._id),
        patient_name: r.patientName || 'Patient',
        patient_phone: r.patientPhone || '',
        location_text: r.locationText || '',
        last_care_type: r.lastCareType || '',
        last_visit_at: r.lastVisitAt,
        visit_count: r.visitCount,
      }));

    res.json({ patients });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// GET /doctor/:doctorId/history — completed/terminal sessions this provider
// has delivered, newest-first. Backs the Nurse + Doctor "Task History" tab.
// Returns full care_request docs so the Flutter `PatientHistoryItem` parser
// can lift `care_type` / prices / status / timestamps without a new model.
router.get('/:doctorId/history', async (req, res) => {
  try {
    const doctorId = sessionProviderId(req, req.params.doctorId);
    const limit = Math.min(Number(req.query.limit) || 100, 200);
    const providerIds = await resolveProviderIds(doctorId);
    const rows = await CareRequest.find({
      $or: [
        { assigned_doctor_id: { $in: providerIds } },
        { assigned_nurse_id: { $in: providerIds } },
      ],
      status: { $in: ['completed', 'cancelled', 'rejected'] },
    })
      .sort({ updated_at: -1 })
      .limit(limit);
    res.json({ history: rows.map((r) => r.toJSON()) });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// GET /doctor/patients/:accountId/vault — read a patient's medical vault.
router.get('/patients/:accountId/vault', async (req, res) => {
  try {
    const { accountId } = req.params;
    if (!mongoose.isValidObjectId(accountId)) {
      return res.status(400).json({ message: 'Invalid account id' });
    }
    const acct = await Account.findById(accountId).select('medical_vault');
    if (!acct) return res.status(404).json({ message: 'Patient not found' });
    res.json({ medical_vault: vaultJson(acct.medical_vault) });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// PATCH /doctor/patients/:accountId/vault — upsert vault fields.
// Body: { allergies?, chronic_conditions?, blood_type?, emergency_notes?,
//         updated_by? }. Only the keys present are written, so a partial
//         edit never blanks the rest of the vault.
router.patch('/patients/:accountId/vault', async (req, res) => {
  try {
    const { accountId } = req.params;
    if (!mongoose.isValidObjectId(accountId)) {
      return res.status(400).json({ message: 'Invalid account id' });
    }
    const b = req.body || {};
    const set = { 'medical_vault.updated_at': new Date() };

    const cleanList = (arr) =>
      arr.map((s) => String(s).trim()).filter(Boolean);
    if (Array.isArray(b.allergies)) {
      set['medical_vault.allergies'] = cleanList(b.allergies);
    }
    if (Array.isArray(b.chronic_conditions)) {
      set['medical_vault.chronic_conditions'] = cleanList(b.chronic_conditions);
    }
    if (typeof b.blood_type === 'string') {
      set['medical_vault.blood_type'] = BLOOD_TYPES.includes(b.blood_type)
        ? b.blood_type
        : 'Unknown';
    }
    if (typeof b.emergency_notes === 'string') {
      set['medical_vault.emergency_notes'] = b.emergency_notes.slice(0, 1000);
    }
    if (b.updated_by) set['medical_vault.updated_by'] = String(b.updated_by);

    const acct = await Account.findByIdAndUpdate(
      accountId,
      { $set: set },
      { new: true }
    ).select('medical_vault');
    if (!acct) return res.status(404).json({ message: 'Patient not found' });
    res.json({ medical_vault: vaultJson(acct.medical_vault) });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

module.exports = router;
