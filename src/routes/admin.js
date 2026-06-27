const express = require('express');
const crypto = require('crypto');
const mongoose = require('mongoose');
const bcrypt = require('bcryptjs');
const CareRequest = require('../models/CareRequest');
const Provider = require('../models/Provider');
const Account = require('../models/Account');
const {
  loadDoctorPair,
  loadProviderPair,
  attachDoctorToRequest,
} = require('../utils/doctorView');
const {
  safeEmitNotification,
  userRoomFor,
} = require('../services/notificationService');
const { sendHighPriorityPush } = require('../services/fcmService');
const { requireRole } = require('../middleware/auth');
const { normalizePhone } = require('../utils/phone');
const adminController = require('../controllers/admin.controller');

const BCRYPT_ROUNDS = 10;

// Terminal states a request can never be (re)assigned out of. Used as the
// guard in the atomic compare-and-swap assignment writes below so a
// completed/cancelled/rejected visit can't be silently re-dispatched by a
// late or concurrent admin action.
const TERMINAL = ['completed', 'cancelled', 'rejected'];

// Folds the four fee sub-fields into `payment.total`, mirroring the
// CareRequest `pre('save')` hook. We need it inline because the atomic
// `findOneAndUpdate` assignment path below bypasses Mongoose middleware.
function withPaymentTotal(payment) {
  const merged = { ...payment };
  merged.total =
    (Number(merged.doctor_fee) || 0) +
    (Number(merged.nurse_fee) || 0) +
    (Number(merged.helper_fee) || 0) +
    (Number(merged.platform_fee) || 0);
  return merged;
}

// Cryptographically-secure ten-character alphanumeric password used as
// the one-shot temporary credential for admin-provisioned doctors and
// nurses. Excludes ambiguous glyphs (0/O, 1/I/l) so the admin can read
// it aloud over the phone without spelling it letter-by-letter.
function generateTemporaryPassword(length = 10) {
  const alphabet =
    'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789';
  const bytes = crypto.randomBytes(length);
  let out = '';
  for (let i = 0; i < length; i++) {
    out += alphabet[bytes[i] % alphabet.length];
  }
  return out;
}

const router = express.Router();

// Shared notification fan-out for both assign paths. Writes a row to
// the patient AND to each freshly-assigned provider (doctor, nurse)
// whose account id can be resolved so every bell badge updates in
// real time. `pairs` carries the resolved {provider, account} pair for
// each role so we don't re-walk Mongo here.
//
// `opts.notifyDoctor` / `opts.notifyNurse` gate each provider fan-out
// so a re-save that re-sends an UNCHANGED provider id (e.g. admin adds
// a nurse to a visit that already has a doctor) doesn't double-ping the
// already-assigned provider. Both default to `true` so any other caller
// keeps the original "notify whoever resolved" behavior. When BOTH are
// false the patient summary is skipped too — nothing actually changed.
async function notifyAssignment(io, careRequestDoc, pairs = {}, opts = {}) {
  if (!careRequestDoc) return;
  const notifyDoctor = opts.notifyDoctor !== false;
  const notifyNurse = opts.notifyNurse !== false;
  if (!notifyDoctor && !notifyNurse) return;
  const apptId = careRequestDoc._id.toString();
  const doctorPair = pairs.doctor || { provider: null, account: null };
  const nursePair = pairs.nurse || { provider: null, account: null };

  const doctorName =
    careRequestDoc.assigned_doctor_name ||
    (doctorPair.provider && doctorPair.provider.full_name) ||
    (doctorPair.account && doctorPair.account.full_name) ||
    null;
  const nurseName =
    careRequestDoc.assigned_nurse_name ||
    (nursePair.provider && nursePair.provider.full_name) ||
    (nursePair.account && nursePair.account.full_name) ||
    null;

  // Patient notification — single message summarising who showed up.
  if (careRequestDoc.patient_account_id) {
    let title;
    let body;
    if (doctorName && nurseName) {
      title = 'Care team assigned';
      body = `${doctorName} and nurse ${nurseName} are on the way for your ${careRequestDoc.care_type || 'visit'}.`;
    } else if (nurseName && !doctorName) {
      title = 'Nurse assigned';
      body = `Nurse ${nurseName} is on the way for your ${careRequestDoc.care_type || 'visit'}.`;
    } else if (doctorName) {
      title = 'Doctor Assigned';
      body = `${doctorName} is on the way for your ${careRequestDoc.care_type || 'visit'}.`;
    } else {
      title = 'Care team assigned';
      body = `Your ${careRequestDoc.care_type || 'visit'} is on the way.`;
    }
    await safeEmitNotification(io, {
      recipientId: careRequestDoc.patient_account_id,
      senderId: null,
      title,
      body,
      type: 'appointment',
      payload: { appointmentId: apptId, deepLink: 'tracking' },
    });
  }

  // Doctor notification — the resolved Account id is what the doctor
  // session uses to identify itself for the socket room.
  const doctorAccountId =
    doctorPair.account && doctorPair.account._id
      ? doctorPair.account._id.toString()
      : null;
  if (doctorAccountId && notifyDoctor) {
    const title = 'New visit assigned';
    const body = `${careRequestDoc.patient_name || 'A patient'} was just assigned to you for ${careRequestDoc.care_type || 'a visit'}.`;
    await safeEmitNotification(io, {
      recipientId: doctorAccountId,
      senderId: null,
      title,
      body,
      type: 'appointment',
      payload: { appointmentId: apptId, deepLink: 'doctor_dashboard' },
    });
    // FCM device push — fires the OS-level high-priority notification
    // so the doctor's app rings through even when suspended. Best-
    // effort: gracefully no-ops when Firebase Admin isn't configured.
    // eslint-disable-next-line no-floating-promises
    sendHighPriorityPush(doctorAccountId, title, body, {
      click_action: 'FLUTTER_NOTIFICATION_CLICK',
      appointmentId: apptId,
      deepLink: 'doctor_dashboard',
    });
    // High-priority real-time dispatch event — the Flutter socket manager
    // catches this and paints the intrusive incoming-dispatch overlay
    // (haptic + actionable card) without any poll/refresh.
    if (io) {
      io.to(userRoomFor(doctorAccountId)).emit('dispatch:incoming', {
        appointmentId: apptId,
        patientName: careRequestDoc.patient_name || 'A patient',
        careType: careRequestDoc.care_type || 'a visit',
        role: 'doctor',
        deepLink: 'doctor_dashboard',
        timestamp: new Date().toISOString(),
      });
    }
  }

  // Nurse notification — symmetric to the doctor branch above.
  const nurseAccountId =
    nursePair.account && nursePair.account._id
      ? nursePair.account._id.toString()
      : null;
  if (nurseAccountId && notifyNurse) {
    const title = 'New nursing visit assigned';
    const body = `${careRequestDoc.patient_name || 'A patient'} was just assigned to you for ${careRequestDoc.care_type || 'a visit'}.`;
    await safeEmitNotification(io, {
      recipientId: nurseAccountId,
      senderId: null,
      title,
      body,
      type: 'appointment',
      payload: { appointmentId: apptId, deepLink: 'nurse_dashboard' },
    });
    // eslint-disable-next-line no-floating-promises
    sendHighPriorityPush(nurseAccountId, title, body, {
      click_action: 'FLUTTER_NOTIFICATION_CLICK',
      appointmentId: apptId,
      deepLink: 'nurse_dashboard',
    });
    // Real-time intrusive dispatch overlay (see doctor branch).
    if (io) {
      io.to(userRoomFor(nurseAccountId)).emit('dispatch:incoming', {
        appointmentId: apptId,
        patientName: careRequestDoc.patient_name || 'A patient',
        careType: careRequestDoc.care_type || 'a visit',
        role: 'nurse',
        deepLink: 'nurse_dashboard',
        timestamp: new Date().toISOString(),
      });
    }
  }
}

// Build the `payment` sub-doc patch from any fee fields the admin
// supplied on the assign call. Returned object is `{}` when nothing was
// supplied — caller then skips the `payment` write entirely so the
// pre('save') hook doesn't recompute totals on an untouched row.
function pickPaymentPatch(b, currentPayment) {
  const out = {};
  const carry = currentPayment || {};
  const fields = ['doctor_fee', 'nurse_fee', 'helper_fee', 'platform_fee'];
  const aliases = {
    doctor_fee: ['doctorFee'],
    nurse_fee: ['nurseFee'],
    helper_fee: ['helperFee'],
    platform_fee: ['platformFee'],
  };
  let touched = false;
  for (const f of fields) {
    const rawSnake = b[f];
    const rawCamel = aliases[f].map((k) => b[k]).find((v) => v !== undefined);
    const raw = rawSnake !== undefined ? rawSnake : rawCamel;
    if (raw === undefined || raw === null || raw === '') {
      out[f] = Number(carry[f]) || 0;
      continue;
    }
    const n = Number(raw);
    if (!Number.isFinite(n)) continue;
    out[f] = n;
    touched = true;
  }
  return touched ? out : {};
}

// POST /admin/create-provider  { name, email, phone, role }
//
// Provisioning rail for doctors and nurses. The public signup path
// refuses to mint these roles (see `routes/auth.js`) — only an admin
// session can land them in the DB, and only with the strict
// allow-list of {'doctor', 'nurse'}.
//
// On success:
//   1. A linked Account row is created (login identity) with a
//      cryptographically-random 10-char temp password (hashed with
//      bcrypt; the plaintext is returned in the response ONCE so the
//      admin can hand it to the hired provider).
//   2. A matching Provider row is created (professional profile)
//      pre-stamped with the role so the existing dashboard surfaces
//      find it.
//   3. Both rows carry `is_verified: false` + the Account carries
//      `requires_password_reset: true` so the provider's first login
//      detours into the ForcedPasswordResetScreen.
router.post(
  '/create-provider',
  requireRole('admin'),
  async (req, res) => {
    try {
      const b = req.body || {};
      const fullName = (b.name || b.fullName || b.full_name || '').toString().trim();
      const email = (b.email || '').toString().toLowerCase().trim();
      const phoneIn = (b.phone || '').toString().trim();
      const role = (b.role || '').toString().toLowerCase().trim();

      if (!fullName) {
        return res
          .status(400)
          .json({ success: false, message: 'name is required' });
      }
      if (!phoneIn) {
        return res
          .status(400)
          .json({ success: false, message: 'phone is required' });
      }
      if (role !== 'doctor' && role !== 'nurse') {
        return res.status(400).json({
          success: false,
          message: "role must be 'doctor' or 'nurse'",
        });
      }
      const cleanPhone = normalizePhone(phoneIn);
      if (!cleanPhone) {
        return res
          .status(400)
          .json({ success: false, message: 'Invalid phone number' });
      }

      // Duplicate guards — admin shouldn't be able to silently overwrite
      // an existing account. Email is optional but if supplied must not
      // collide; phone is required + must be unique.
      const phoneDupe = await Account.findOne({ phone: cleanPhone });
      if (phoneDupe) {
        return res.status(409).json({
          success: false,
          message: 'An account with that phone already exists.',
        });
      }
      if (email) {
        const emailDupe = await Account.findOne({ email });
        if (emailDupe) {
          return res.status(409).json({
            success: false,
            message: 'An account with that email already exists.',
          });
        }
      }

      const tempPassword = generateTemporaryPassword(10);
      const password_hash = await bcrypt.hash(tempPassword, BCRYPT_ROUNDS);

      const account = await Account.create({
        full_name: fullName,
        email: email || undefined,
        phone: cleanPhone,
        password_hash,
        role,
        status: 'active',
        // Provider rows are admin-vetted up-front, but the first-login
        // password reset still has to land before the account is
        // considered fully verified.
        is_verified: false,
        requires_password_reset: true,
      });

      // Mirror the identity onto the Provider collection so the doctor /
      // nurse dashboards immediately find the professional row when
      // the provider logs in. The 5-step onboarding sheet fills in
      // BMDC / nursing license + specialty + payout later.
      const provider = await Provider.create({
        full_name: fullName,
        email: email || '',
        phone: cleanPhone,
        role,
        verification_status: 'pending',
        availability_status: 'offline',
      });

      console.log(
        `[admin] ${role} provisioned by admin=${req.accountId}: account=${account._id} provider=${provider._id}`,
      );

      return res.status(201).json({
        success: true,
        message: `${role.charAt(0).toUpperCase()}${role.slice(1)} created.`,
        account: account.toJSON(),
        providerId: provider._id.toString(),
        // The plaintext password is returned exactly once — the
        // admin UI is responsible for showing it inside the
        // copy-credentials card. We never read this value from
        // anywhere else; the DB only stores its bcrypt hash.
        temporaryPassword: tempPassword,
        requiresPasswordReset: true,
      });
    } catch (err) {
      console.error('[admin/create-provider] error:', err);
      // Duplicate-key race-condition fallback.
      if (err && err.code === 11000 && err.keyValue) {
        return res.status(409).json({
          success: false,
          message: 'An account with those identifiers already exists.',
          duplicateFields: Object.keys(err.keyValue),
        });
      }
      return res
        .status(500)
        .json({ success: false, message: err.message || 'Server error' });
    }
  },
);

// GET /admin/requests — full care-request list, newest first.
router.get('/requests', async (_req, res) => {
  try {
    const docs = await CareRequest.find().sort({ created_at: -1 });
    res.json(docs.map((d) => d.toJSON()));
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// POST /admin/requests/:id/assign
//   { doctor_id, doctor_name, helper_id?, helper_name?,
//     nurse_id?, nurse_name?, final_price?,
//     doctor_fee?, nurse_fee?, helper_fee?, platform_fee? }
router.post('/requests/:id/assign', async (req, res) => {
  try {
    const b = req.body || {};
    if (!b.doctor_id && !b.nurse_id) {
      return res
        .status(400)
        .json({ message: 'doctor_id or nurse_id is required' });
    }

    // Manual-pricing gateway. Pricing authority now lives entirely with the
    // admin (the patient no longer offers a budget), so a positive final
    // service fee is mandatory at assignment time — reject null/empty/zero.
    const amount = Number(b.final_price);
    if (!Number.isFinite(amount) || amount <= 0) {
      return res.status(400).json({
        message: 'A final service fee greater than 0 is required to assign.',
      });
    }

    // Load the existing row so we can build a clean `payment` patch on
    // top of the current fees (the pre-save hook recomputes total).
    const existing = await CareRequest.findById(req.params.id);
    if (!existing) {
      return res.status(404).json({ message: 'Request not found' });
    }

    // Snapshot the prior assignments BEFORE mutating so we only notify a
    // provider whose id actually changed on this call — re-sending an
    // unchanged doctor id alongside a new nurse must not re-ping the
    // doctor (the duplicate-notification defect).
    const prevDoctorId = (existing.assigned_doctor_id || '').toString();
    const prevNurseId = (existing.assigned_nurse_id || '').toString();

    const update = { status: 'assigned' };
    if (b.doctor_id) {
      update.assigned_doctor_id = b.doctor_id;
      update.assigned_doctor_name = b.doctor_name || null;
    }
    if (b.nurse_id) {
      update.assigned_nurse_id = b.nurse_id;
      update.assigned_nurse_name = b.nurse_name || null;
    }
    if (b.helper_id !== undefined) {
      update.assigned_helper_id = b.helper_id || null;
      update.assigned_helper_name = b.helper_name || null;
    }
    update.final_price = amount;
    const paymentPatch = pickPaymentPatch(b, existing.payment);
    if (Object.keys(paymentPatch).length) {
      const cur = existing.payment
        ? (existing.payment.toObject ? existing.payment.toObject() : existing.payment)
        : {};
      update.payment = withPaymentTotal({ ...cur, ...paymentPatch });
    }

    // Atomic compare-and-swap: write the assignment in a single round-trip
    // guarded on the request still being in a non-terminal state. This
    // closes the read-then-write window where two concurrent admin assigns
    // (or a double-tap) could clobber each other or re-dispatch a finished
    // visit. `findOneAndUpdate` bypasses the pre('save') hook, so
    // `payment.total` is folded in above.
    const result = await CareRequest.findOneAndUpdate(
      { _id: req.params.id, status: { $nin: TERMINAL } },
      { $set: update },
      { new: true },
    );
    if (!result) {
      return res.status(409).json({
        message:
          'This request can no longer be assigned — it was already completed, cancelled, or rejected.',
      });
    }

    const [doctorPair, nursePair] = await Promise.all([
      b.doctor_id ? loadProviderPair(b.doctor_id, 'doctor') : Promise.resolve({ provider: null, account: null }),
      b.nurse_id ? loadProviderPair(b.nurse_id, 'nurse') : Promise.resolve({ provider: null, account: null }),
    ]);
    await notifyAssignment(
      req.app.get('io'),
      result,
      { doctor: doctorPair, nurse: nursePair },
      {
        notifyDoctor: !!b.doctor_id && b.doctor_id.toString() !== prevDoctorId,
        notifyNurse: !!b.nurse_id && b.nurse_id.toString() !== prevNurseId,
      },
    );
    res.json(result.toJSON());
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// POST /admin/appointments/assign  { appointmentId, doctorId, helperId?,
//                                     helperName?, finalPrice? }
//
// Spec-named alias for the existing `POST /admin/requests/:id/assign`
// route. Body keys are camelCase per the production-spec contract;
// snake_case keys are also accepted so the existing admin web tools
// don't break. On success returns the updated appointment with the
// freshly-populated `doctor` block (full_name, profile_picture, …) so
// the assigning admin can confirm the join landed correctly.
router.post('/appointments/assign', async (req, res) => {
  try {
    const b = req.body || {};
    const appointmentId = b.appointmentId || b.appointment_id || b.request_id;
    const doctorId = b.doctorId || b.doctor_id || null;
    const nurseId = b.nurseId || b.nurse_id || null;
    if (!appointmentId) {
      return res.status(400).json({ message: 'appointmentId is required' });
    }
    if (!doctorId && !nurseId) {
      return res
        .status(400)
        .json({ message: 'doctorId or nurseId is required' });
    }
    if (!mongoose.isValidObjectId(appointmentId)) {
      return res.status(400).json({ message: 'Invalid appointmentId' });
    }
    // Manual-pricing gateway — same contract as POST /requests/:id/assign:
    // a positive final service fee is mandatory at assignment time.
    const amount = Number(b.finalPrice ?? b.final_price);
    if (!Number.isFinite(amount) || amount <= 0) {
      return res.status(400).json({
        message: 'A final service fee greater than 0 is required to assign.',
      });
    }

    // Resolve each provider up-front so we can store the human-readable
    // name alongside the id — and so the request fails 404 instead of
    // silently assigning a bogus pointer.
    const [doctorPair, nursePair] = await Promise.all([
      doctorId ? loadProviderPair(doctorId, 'doctor') : Promise.resolve({ provider: null, account: null }),
      nurseId ? loadProviderPair(nurseId, 'nurse') : Promise.resolve({ provider: null, account: null }),
    ]);
    if (doctorId && !doctorPair.provider && !doctorPair.account) {
      return res.status(404).json({ message: 'Doctor not found' });
    }
    if (nurseId && !nursePair.provider && !nursePair.account) {
      return res.status(404).json({ message: 'Nurse not found' });
    }
    const doctorName =
      b.doctorName ||
      b.doctor_name ||
      (doctorPair.provider && doctorPair.provider.full_name) ||
      (doctorPair.account && doctorPair.account.full_name) ||
      null;
    const nurseName =
      b.nurseName ||
      b.nurse_name ||
      (nursePair.provider && nursePair.provider.full_name) ||
      (nursePair.account && nursePair.account.full_name) ||
      null;

    const existing = await CareRequest.findById(appointmentId);
    if (!existing) {
      return res.status(404).json({ message: 'Appointment not found' });
    }

    // Snapshot prior assignments before mutating — only the role whose
    // id actually changed should be notified (see notifyAssignment).
    const prevDoctorId = (existing.assigned_doctor_id || '').toString();
    const prevNurseId = (existing.assigned_nurse_id || '').toString();

    const update = {
      status: 'assigned',
      accepted_at: new Date(),
    };
    if (doctorId) {
      update.assigned_doctor_id = doctorId;
      update.assigned_doctor_name = doctorName;
    }
    if (nurseId) {
      update.assigned_nurse_id = nurseId;
      update.assigned_nurse_name = nurseName;
    }
    if (b.helperId || b.helper_id) {
      update.assigned_helper_id = b.helperId || b.helper_id;
    }
    if (b.helperName || b.helper_name) {
      update.assigned_helper_name = b.helperName || b.helper_name;
    }
    update.final_price = amount;
    const paymentPatch = pickPaymentPatch(b, existing.payment);
    if (Object.keys(paymentPatch).length) {
      const cur = existing.payment
        ? (existing.payment.toObject ? existing.payment.toObject() : existing.payment)
        : {};
      update.payment = withPaymentTotal({ ...cur, ...paymentPatch });
    }

    // Atomic compare-and-swap (see /requests/:id/assign for rationale):
    // single guarded round-trip so concurrent assigns can't clobber each
    // other and a terminal visit can't be re-dispatched.
    const result = await CareRequest.findOneAndUpdate(
      { _id: appointmentId, status: { $nin: TERMINAL } },
      { $set: update },
      { new: true },
    );
    if (!result) {
      return res.status(409).json({
        success: false,
        message:
          'This appointment can no longer be assigned — it was already completed, cancelled, or rejected.',
      });
    }

    await notifyAssignment(
      req.app.get('io'),
      result,
      { doctor: doctorPair, nurse: nursePair },
      {
        notifyDoctor: !!doctorId && doctorId.toString() !== prevDoctorId,
        notifyNurse: !!nurseId && nurseId.toString() !== prevNurseId,
      },
    );
    const body = await attachDoctorToRequest(result.toJSON());
    res.json({ success: true, appointment: body });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// ===========================================================================
// 2-Step OTP gate for admin edits to a provider profile
// ===========================================================================
//
// Flow:
//   1. Admin taps the Edit icon on the providers table → POST
//      /admin/providers/:id/request-update-otp generates a 6-digit
//      code, stamps a 5-minute expiry on the provider doc, and
//      logs / mock-SMSes the code.
//   2. Admin types the code + the field changes into the verification
//      dialog → PATCH /admin/providers/:id/update-profile compares
//      the code against the stored value, refuses on mismatch /
//      expiry, applies the change, and clears the OTP latch.
//
// Both endpoints are gated by `requireRole('admin')` so only an
// authenticated admin session can reach them.

// Allowlist of provider fields the verified-update endpoint will
// persist. Any other key on the payload is silently dropped — this is
// the seam where a malicious admin can't sneak in a `verification_status`
// flip alongside a benign rename, for example.
const PROVIDER_EDITABLE_VIA_OTP = new Set([
  'full_name',
  'fullName',
  'phone',
  'email',
  'specialization',
  'specialty',
  'years_experience',
  'fee',
  'service_radius_km',
  'hospital_affiliation',
  'bio',
]);

// Camel-to-snake aliasing so the Flutter side can keep camelCase keys
// (the existing admin UI vocabulary) while the schema stays snake_case.
const PROVIDER_OTP_FIELD_ALIASES = {
  fullName: 'full_name',
  yearsExperience: 'years_experience',
  serviceRadiusKm: 'service_radius_km',
  hospitalAffiliation: 'hospital_affiliation',
};

function generateNumericOtp(length = 6) {
  const bytes = crypto.randomBytes(length);
  let out = '';
  for (let i = 0; i < length; i++) {
    out += (bytes[i] % 10).toString();
  }
  return out;
}

// POST /admin/providers/:id/request-update-otp
//
// Stage 1 — generate the code, persist it, log it. Returns the
// expiry so the dialog can render a countdown. In non-strict dev
// mode we ALSO surface the code in the response under `dev_otp` so
// the QA loop doesn't need to watch the server console; production
// (`AUTH_STRICT=1`) strips that field.
router.post(
  '/providers/:id/request-update-otp',
  requireRole('admin'),
  async (req, res) => {
    try {
      const { id } = req.params;
      if (!mongoose.isValidObjectId(id)) {
        return res
          .status(400)
          .json({ success: false, message: 'Invalid provider id' });
      }
      const provider = await Provider.findById(id);
      if (!provider) {
        return res
          .status(404)
          .json({ success: false, message: 'Provider not found' });
      }

      const otp = generateNumericOtp(6);
      const expiresAt = new Date(Date.now() + 5 * 60 * 1000);
      provider.update_authorization_otp = otp;
      provider.update_authorization_otp_expires = expiresAt;
      await provider.save();

      // Mock SMS interceptor. A production rollout swaps this for a
      // real provider — the `console.log` call site is the seam.
      console.log(
        `[OTP Sent to Provider] id=${provider._id} name="${provider.full_name}" code=${otp} expires=${expiresAt.toISOString()}`,
      );

      return res.json({
        success: true,
        message: 'Verification code dispatched to the provider.',
        providerId: provider._id.toString(),
        providerName: provider.full_name,
        expiresAt: expiresAt.toISOString(),
        // Non-strict dev only — strip the code from the production
        // response so an admin client can't bypass the SMS step.
        dev_otp: process.env.AUTH_STRICT === '1' ? undefined : otp,
      });
    } catch (err) {
      console.error('[providers/request-update-otp] error:', err);
      return res
        .status(500)
        .json({ success: false, message: err.message || 'Server error' });
    }
  },
);

// PATCH /admin/providers/:id/update-profile
//
// Stage 2 — verify the OTP, apply the field changes, clear the
// latch. Failures (missing / mismatched / expired) all return a
// single uniform 401 so the client can't probe whether the code
// expired vs. was wrong vs. was missing.
router.patch(
  '/providers/:id/update-profile',
  requireRole('admin'),
  async (req, res) => {
    try {
      const { id } = req.params;
      if (!mongoose.isValidObjectId(id)) {
        return res
          .status(400)
          .json({ success: false, message: 'Invalid provider id' });
      }
      const body = req.body || {};
      const otp = (body.otp || '').toString().trim();
      if (!otp) {
        return res.status(401).json({
          success: false,
          message: 'Invalid or expired provider verification token.',
        });
      }

      const provider = await Provider.findById(id);
      if (!provider) {
        return res
          .status(404)
          .json({ success: false, message: 'Provider not found' });
      }

      const stored = provider.update_authorization_otp;
      const expiresAt = provider.update_authorization_otp_expires;
      const expired =
        !expiresAt || new Date().getTime() > new Date(expiresAt).getTime();
      // Constant-time compare to make a brute-force timing attack on
      // the 6-digit code marginally harder. Length mismatch short-
      // circuits to a uniform failure response below.
      let matches = false;
      if (stored && otp.length === stored.length) {
        try {
          matches = crypto.timingSafeEqual(
            Buffer.from(otp),
            Buffer.from(stored),
          );
        } catch (_) {
          matches = false;
        }
      }
      if (!stored || expired || !matches) {
        // Defensive: if the code was expired, clear the latch so the
        // admin can request a fresh one. A genuine mismatch keeps the
        // current code intact (up to its existing expiry) so a
        // mis-type doesn't burn the whole 5-minute window.
        if (stored && expired) {
          provider.update_authorization_otp = null;
          provider.update_authorization_otp_expires = null;
          await provider.save();
        }
        return res.status(401).json({
          success: false,
          message: 'Invalid or expired provider verification token.',
        });
      }

      // OTP cleared — pick the editable fields off the body and
      // apply. Camel-cased aliases land on their snake-case
      // counterparts; everything else outside the allowlist is
      // silently dropped.
      let touched = false;
      for (const [key, raw] of Object.entries(body)) {
        if (key === 'otp') continue;
        if (!PROVIDER_EDITABLE_VIA_OTP.has(key)) continue;
        const targetKey = PROVIDER_OTP_FIELD_ALIASES[key] || key;
        let value = raw;
        if (typeof value === 'string') value = value.trim();
        provider.set(targetKey, value);
        touched = true;
      }

      // Clear the OTP latch regardless of whether any field actually
      // changed — the verification has been consumed.
      provider.update_authorization_otp = null;
      provider.update_authorization_otp_expires = null;
      await provider.save();

      console.log(
        `[OTP verified] admin=${req.accountId} updated provider=${provider._id} touched=${touched}`,
      );

      return res.json({
        success: true,
        message: 'Provider profile updated.',
        provider: provider.toJSON(),
      });
    } catch (err) {
      console.error('[providers/update-profile] error:', err);
      return res
        .status(500)
        .json({ success: false, message: err.message || 'Server error' });
    }
  },
);

// POST /admin/requests/bulk-status  { ids: [], status }
router.post('/requests/bulk-status', async (req, res) => {
  try {
    const { ids, status } = req.body || {};
    if (!Array.isArray(ids) || ids.length === 0) {
      return res.status(400).json({ message: 'ids[] is required' });
    }
    if (!status) {
      return res.status(400).json({ message: 'status is required' });
    }
    const result = await CareRequest.updateMany(
      { _id: { $in: ids } },
      { status }
    );
    res.json({ updated: result.modifiedCount ?? 0 });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// GET /admin/requests/:id/doctors — available doctors (providers).
router.get('/requests/:id/doctors', async (_req, res) => {
  try {
    const docs = await Provider.find({ role: 'doctor' }).sort({ rating: -1 });
    res.json(docs.map((d) => d.toJSON()));
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// GET /admin/requests/:id/nurses — available nurses (providers).
router.get('/requests/:id/nurses', async (_req, res) => {
  try {
    const docs = await Provider.find({ role: 'nurse' }).sort({ rating: -1 });
    res.json(docs.map((d) => d.toJSON()));
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// GET /admin/requests/:id/helpers — available medical helpers.
router.get('/requests/:id/helpers', async (_req, res) => {
  try {
    const docs = await Provider.find({ role: 'helper' }).sort({ fee: 1 });
    res.json(docs.map((d) => d.toJSON()));
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// GET /admin/requests/:id/team-pool
//
// Returns the verified + online doctor and nurse rosters in a single
// segregated payload so the admin Assign Team screen can render the
// dual-list view without firing two roundtrips. Both arrays are
// sorted rating-DESC so the highest-performing provider per role
// surfaces first.
//
// `:id` is currently unused server-side (the rosters are
// request-agnostic at this point in the funnel) but is part of the
// URL so a future per-request filter — e.g. distance / specialty
// match — has a place to plug in without a route rename.
router.get('/requests/:id/team-pool', async (_req, res) => {
  try {
    const sharedFilter = {
      verification_status: 'verified',
      availability_status: 'online',
    };
    const [doctors, nurses] = await Promise.all([
      Provider.find({ ...sharedFilter, role: 'doctor' }).sort({ rating: -1 }),
      Provider.find({ ...sharedFilter, role: 'nurse' }).sort({ rating: -1 }),
    ]);
    res.json({
      success: true,
      doctors: doctors.map((d) => d.toJSON()),
      nurses: nurses.map((n) => n.toJSON()),
    });
  } catch (err) {
    res
      .status(500)
      .json({ success: false, message: err.message || 'Server error' });
  }
});

// Statuses that count as "currently in flight". Used by both /admin/stats
// and /admin/dashboard so the Overview KPI matches the Live Monitor count.
const ACTIVE_SERVICE_STATUSES = [
  'assigned',
  'enroute',
  'on_the_way',
  'arrived',
  'in_service',
];

// Builds the [start, end) UTC bounds for the calendar day a Date falls in.
// The admin's "daily revenue" rolls over at local midnight server-side; we
// approximate that with UTC midnight for now and let the Flutter side
// render whatever the server returns.
function dayBounds(d = new Date()) {
  const start = new Date(d.getFullYear(), d.getMonth(), d.getDate());
  const end = new Date(start);
  end.setDate(start.getDate() + 1);
  return { start, end };
}

// Aggregates `final_price` for completed visits in the window. Falls
// back to `offered_budget` when `final_price` is null so admins still
// see revenue from older requests that finished before the price
// negotiation flow shipped.
async function revenueIn(start, end) {
  const result = await CareRequest.aggregate([
    {
      $match: {
        status: 'completed',
        created_at: { $gte: start, $lt: end },
      },
    },
    {
      $group: {
        _id: null,
        revenue: {
          $sum: {
            $ifNull: ['$final_price', '$offered_budget'],
          },
        },
        visits: { $sum: 1 },
      },
    },
  ]);
  if (!result.length) return { revenue: 0, visits: 0 };
  return {
    revenue: Number(result[0].revenue) || 0,
    visits: Number(result[0].visits) || 0,
  };
}

// Shared handler — the Overview tab polls this every 15 s, so it must
// be cheap. Five count/aggregate queries; every one is indexed
// (status, created_at).
async function adminStatsHandler(_req, res) {
  try {
    const today = dayBounds();
    const yesterday = (() => {
      const y = new Date(today.start);
      y.setDate(y.getDate() - 1);
      return dayBounds(y);
    })();

    const [active, pending, emergency, todayRev, yesterdayRev] =
      await Promise.all([
        CareRequest.countDocuments({
          status: { $in: ACTIVE_SERVICE_STATUSES },
        }),
        CareRequest.countDocuments({ status: 'submitted' }),
        CareRequest.countDocuments({
          urgency_level: 'critical',
          status: { $nin: ['completed', 'cancelled', 'rejected'] },
        }),
        revenueIn(today.start, today.end),
        revenueIn(yesterday.start, yesterday.end),
      ]);

    // Percentage change vs. yesterday — clamps the divide-by-zero case
    // to a flat 0 so the UI doesn't render "Infinity%" on slow days.
    let revenueDelta = 0;
    if (yesterdayRev.revenue > 0) {
      revenueDelta =
        ((todayRev.revenue - yesterdayRev.revenue) / yesterdayRev.revenue) *
        100;
    }

    res.json({
      active_services: active,
      pending_approvals: pending,
      emergency_alerts: emergency,
      daily_revenue: todayRev.revenue,
      revenue_delta: Math.round(revenueDelta * 10) / 10, // 1 decimal
      today_visits: todayRev.visits,
    });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
}

// GET /admin/stats  — canonical KPI route, polled every 15 s.
// GET /admin/dashboard — legacy alias. Same handler so the existing
//   Flutter `getAdminKpi()` keeps working until the next deploy flips it.
router.get('/stats', adminStatsHandler);
router.get('/dashboard', adminStatsHandler);

// GET /api/admin/dashboard-telemetry — real-time operations telemetry for
// the Overview cards, computed via a single $facet aggregation (see
// controllers/admin.controller.js). Protected: admin-only.
router.get(
  '/dashboard-telemetry',
  requireRole('admin'),
  adminController.getDashboardTelemetry,
);

// GET /api/admin/live-services — real-time in-flight dispatches for the
// Live Monitor. Admin-only.
router.get(
  '/live-services',
  requireRole('admin'),
  adminController.getLiveServices,
);

// PATCH /api/admin/providers/:id/verify — flip a provider's verification
// status (pending ⇄ verified). Admin-only.
router.patch(
  '/providers/:id/verify',
  requireRole('admin'),
  adminController.toggleProviderVerification,
);

// POST /api/admin/register-sub-admin — root-admin-only creation of a
// secondary admin account (bcrypt password, role: 'admin').
router.post(
  '/register-sub-admin',
  requireRole('admin'),
  adminController.registerSubAdmin,
);

// GET /admin/chart-data
// 7-day rollup for the Overview tab's BarChart. Returns one bucket per
// calendar day with `approved` (= approved | completed) and `declined`
// (= rejected | cancelled) counts. Days with zero rows still appear so
// the BarChart always renders exactly 7 bars in chronological order.
router.get('/chart-data', async (_req, res) => {
  try {
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const start = new Date(today);
    start.setDate(start.getDate() - 6); // 7-day inclusive window

    const rows = await CareRequest.aggregate([
      { $match: { created_at: { $gte: start } } },
      {
        $group: {
          // Local-time day-of-year bucket. `$dateTrunc` keeps DST jitter
          // out of the rollup — same docs always land in the same bucket.
          _id: {
            $dateTrunc: { date: '$created_at', unit: 'day' },
          },
          approved: {
            $sum: {
              $cond: [
                { $in: ['$status', ['approved', 'completed']] },
                1,
                0,
              ],
            },
          },
          declined: {
            $sum: {
              $cond: [
                { $in: ['$status', ['rejected', 'cancelled']] },
                1,
                0,
              ],
            },
          },
          total: { $sum: 1 },
        },
      },
      { $sort: { _id: 1 } },
    ]);

    // Index by ISO date for O(1) merge against the 7-slot template.
    const byDay = new Map();
    for (const r of rows) {
      const key = new Date(r._id).toISOString().slice(0, 10);
      byDay.set(key, {
        approved: r.approved || 0,
        declined: r.declined || 0,
        total: r.total || 0,
      });
    }

    // Build the canonical 7-day series so consumers don't have to fill
    // gaps client-side. Mon/Tue/Wed labels mirror the Flutter mockup.
    const days = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
    const series = [];
    for (let i = 0; i < 7; i++) {
      const d = new Date(start);
      d.setDate(start.getDate() + i);
      const key = d.toISOString().slice(0, 10);
      const cell = byDay.get(key) || { approved: 0, declined: 0, total: 0 };
      series.push({
        date: key,
        label: days[d.getDay()],
        approved: cell.approved,
        declined: cell.declined,
        total: cell.total,
      });
    }

    res.json({ series });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// GET /admin/patients — accounts where role:'user', newest first.
// Powers the new "Patients" sidebar screen.
router.get('/patients', async (_req, res) => {
  try {
    const rows = await Account.find({ role: 'user' })
      .sort({ created_at: -1 })
      .limit(500);
    res.json(rows.map((d) => d.toJSON()));
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// GET /admin/providers — full provider list (doctors + helpers), newest
// first. Powers the new "Providers" sidebar screen.
router.get('/providers', async (_req, res) => {
  try {
    const rows = await Provider.find()
      .sort({ created_at: -1 })
      .limit(500);
    res.json(rows.map((d) => d.toJSON()));
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// GET /admin/billing?startDate=&endDate= — completed care_requests with
// their final price, newest first. Optional ISO date params truncate the
// ledger to a [startDate, endDate] window (inclusive of the end day) so the
// admin's date-range picker can scope the report server-side.
router.get('/billing', async (req, res) => {
  try {
    const filter = { status: 'completed' };
    const start = req.query.startDate
      ? new Date(String(req.query.startDate))
      : null;
    const end = req.query.endDate ? new Date(String(req.query.endDate)) : null;
    const range = {};
    if (start && !Number.isNaN(start.getTime())) range.$gte = start;
    if (end && !Number.isNaN(end.getTime())) {
      // Make the end bound inclusive of the whole calendar day.
      const endOfDay = new Date(end);
      endOfDay.setHours(23, 59, 59, 999);
      range.$lte = endOfDay;
    }
    if (Object.keys(range).length) filter.updated_at = range;

    const rows = await CareRequest.find(filter)
      .sort({ updated_at: -1 })
      .limit(500);
    res.json(rows.map((d) => d.toJSON()));
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// GET /admin/activity — recent activity feed (newest requests as events).
router.get('/activity', async (_req, res) => {
  try {
    const docs = await CareRequest.find().sort({ created_at: -1 }).limit(8);
    res.json(
      docs.map((d) => {
        const o = d.toJSON();
        return {
          id: `ev_${o.id}`,
          message: `${o.patient_name} — ${o.care_type} (${o.status})`,
          timestamp: o.created_at,
          event_type: 'system',
          request_id: o.id,
        };
      })
    );
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

module.exports = router;
