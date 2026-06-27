const express = require('express');
const mongoose = require('mongoose');
const CareRequest = require('../models/CareRequest');
const Message = require('../models/Message');
const { attachDoctorToRequest, loadProviderPair } = require('../utils/doctorView');
const { requireAccountId } = require('../middleware/auth');
const Account = require('../models/Account');
const Provider = require('../models/Provider');

const router = express.Router();

const HISTORY_STATUSES = ['completed', 'cancelled'];

// Spec status vocabulary. The DB schema uses the legacy `enroute`
// value; we accept BOTH `on-the-way` (spec) and `enroute` (legacy)
// and canonicalise to `enroute` before persisting so downstream
// surfaces (doctor dashboard, patient tracking) keep rendering.
const PROVIDER_STATUS_ALIASES = {
  accepted: 'assigned',
  assigned: 'assigned',
  'on-the-way': 'enroute',
  on_the_way: 'enroute',
  enroute: 'enroute',
  arrived: 'arrived',
  in_service: 'in_service',
  completed: 'completed',
};
const ALLOWED_PROVIDER_STATUSES = new Set(Object.keys(PROVIDER_STATUS_ALIASES));

// Resolves the signed-in account to its provider role + id. Both
// the linked Account `_id` AND the Provider `_id` are treated as
// valid "assigned" identifiers since the legacy assign endpoints
// historically wrote either one onto the care request.
async function resolveProviderIdentity(accountId) {
  if (!accountId) return null;
  const account = await Account.findById(accountId);
  if (!account) return null;
  const role = account.role;
  if (role !== 'doctor' && role !== 'nurse') {
    return { role, ids: new Set([accountId]) };
  }
  // Linked Provider row by email / full_name. Either ID can match
  // the appointment's assigned field; collect both.
  let provider = null;
  if (account.email) {
    provider = await Provider.findOne({ email: account.email, role });
  }
  if (!provider && account.full_name) {
    provider = await Provider.findOne({ full_name: account.full_name, role });
  }
  const ids = new Set([accountId.toString()]);
  if (provider) ids.add(provider._id.toString());
  return { role, ids };
}

// Shared guard for the provider write surfaces (status / vitals /
// complete): the caller must be the doctor OR nurse assigned to this
// care request. Returns `{ ok, identity }` on success or `{ ok:false,
// code, message }` so the route can early-return the right HTTP status.
async function assertAssignedProvider(accountId, appt) {
  const identity = await resolveProviderIdentity(accountId);
  if (!identity || (identity.role !== 'doctor' && identity.role !== 'nurse')) {
    return {
      ok: false,
      code: 403,
      message: 'Only the assigned provider can update this appointment.',
    };
  }
  const assignedId =
    identity.role === 'doctor'
      ? (appt.assigned_doctor_id || '').toString()
      : (appt.assigned_nurse_id || '').toString();
  if (!assignedId) {
    return {
      ok: false,
      code: 403,
      message: 'Only the assigned provider can update this appointment.',
    };
  }
  // Fast path — the stored id is already in the caller's id set.
  if (identity.ids.has(assignedId)) {
    return { ok: true, identity };
  }
  // Robust fallback — resolve the appointment's assigned id (which may be an
  // Account._id OR a Provider._id, depending on what admin wrote) to its
  // {account, provider} pair and intersect with the caller's ids. This clears
  // the 403 lockout when the assigned side and the session side were stored
  // as different-but-linked ids, without loosening the assigned-only rule.
  const pair = await loadProviderPair(assignedId, identity.role);
  const assignedSet = new Set();
  if (pair.account && pair.account._id) {
    assignedSet.add(pair.account._id.toString());
  }
  if (pair.provider && pair.provider._id) {
    assignedSet.add(pair.provider._id.toString());
  }
  for (const id of assignedSet) {
    if (identity.ids.has(id)) {
      return { ok: true, identity };
    }
  }
  return {
    ok: false,
    code: 403,
    message: 'Only the assigned provider can update this appointment.',
  };
}

// Writes a vitals payload onto the care request's `vitals` sub-doc.
// Accepts both snake_case and camelCase keys; only non-empty values are
// applied so a partial save never blanks an existing reading. Stamps the
// recorder + timestamp. Returns true when at least one field was written.
function applyVitals(appt, vitals, recordedBy) {
  if (!vitals || typeof vitals !== 'object') return false;
  const v = appt.vitals || {};
  let touched = false;
  const setStr = (key, val) => {
    if (val === undefined || val === null) return;
    const s = String(val).trim();
    if (!s) return;
    v[key] = s;
    touched = true;
  };
  setStr('blood_pressure', vitals.blood_pressure ?? vitals.bloodPressure);
  setStr('temperature', vitals.temperature);
  setStr('spo2', vitals.spo2);
  setStr('pulse', vitals.pulse ?? vitals.heart_rate ?? vitals.heartRate);
  setStr('pain_score', vitals.pain_score ?? vitals.painScore);
  setStr('wound_status', vitals.wound_status ?? vitals.woundStatus);
  if (touched) {
    v.recorded_by = recordedBy || v.recorded_by || null;
    v.recorded_at = new Date();
    appt.vitals = v;
    appt.markModified('vitals');
  }
  return touched;
}

const TERMINAL_STATUSES = ['completed', 'cancelled', 'rejected'];

// `appointment` is the same domain concept as `care_request` in our
// schema. This router is the canonical `/api/appointments/*` surface
// (matches the production spec); under the hood it reads + writes the
// care_requests collection so we don't fork the data model.

// Allowed feedback tags. Mirrors the Flutter Rating screen's chip set
// so a typo from the client can't poison the database.
const ALLOWED_FEEDBACK_TAGS = new Set([
  'Professional',
  'On time',
  'Careful',
  'Friendly',
  'Explained well',
  'Clean tools',
]);

// GET /api/appointments/latest-completed?account_id=
//
// Declared BEFORE `/:id` so the literal path wins the matcher race
// (otherwise `latest-completed` would get bound as `:id` and crash
// the ObjectId validator).
//
// Returns the most recently completed visit for the given patient
// account so the Rating tab can show "your last visit". Without an
// `account_id` it returns the most recent completed visit globally,
// which is helpful for QA when no session exists.
router.get('/latest-completed', async (req, res) => {
  try {
    const { account_id } = req.query;
    const filter = { status: 'completed' };
    if (account_id) filter.patient_account_id = account_id;
    const doc = await CareRequest.findOne(filter).sort({ updated_at: -1 });
    if (!doc) {
      return res.status(404).json({
        success: false,
        message: 'No completed appointments yet',
      });
    }
    res.json(doc.toJSON());
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// GET /api/appointments/patient/active?account_id=
//
// Canonical patient-facing read for the live appointment. Returns the
// newest non-terminal care_request for the account with the assigned
// doctor populated (full_name, profile_picture, specialty, etc.) so the
// patient app's tracking screen can render the doctor card without a
// second roundtrip. Declared BEFORE `/:id` so the literal path wins the
// matcher race.
router.get('/patient/active', async (req, res) => {
  try {
    const { account_id } = req.query;
    const filter = { status: { $nin: TERMINAL_STATUSES } };
    if (account_id) filter.patient_account_id = account_id;
    const doc = await CareRequest.findOne(filter).sort({ created_at: -1 });
    if (!doc) {
      return res.status(404).json({
        success: false,
        message: 'No active appointment',
      });
    }
    const body = await attachDoctorToRequest(doc.toJSON());
    res.json(body);
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// GET /api/appointments/patient/history?account_id=
//
// Past appointments for the History tab. Returns every care_request
// for the supplied patient account whose status is `completed` or
// `cancelled`, sorted by `updated_at` descending so the most recent
// visit lands first. Each row is populated with the assigned doctor
// block (same shape as `/patient/active`) so the History cards can
// render the provider name + photo without a second roundtrip.
//
// Declared BEFORE `/:id` so the literal path wins the matcher race.
router.get('/patient/history', async (req, res) => {
  try {
    const { account_id } = req.query;
    if (!account_id) {
      return res
        .status(400)
        .json({ success: false, message: 'account_id is required' });
    }
    const limit = Math.min(Number(req.query.limit) || 50, 200);
    const filter = {
      patient_account_id: account_id,
      status: { $in: HISTORY_STATUSES },
    };
    const rows = await CareRequest.find(filter)
      .sort({ updated_at: -1 })
      .limit(limit);
    // Populate the doctor block per row in parallel — each lookup is
    // independent and the list is short.
    const populated = await Promise.all(
      rows.map((d) => attachDoctorToRequest(d.toJSON())),
    );
    res.json({ success: true, appointments: populated });
  } catch (err) {
    res
      .status(500)
      .json({ success: false, message: err.message || 'Server error' });
  }
});

// GET /api/appointments/:id/messages
//
// Read-only chat transcript for one historical visit. Returns every
// `messages` row where `appointmentId === :id`, sorted oldest-first
// so the archive screen can render the conversation chronologically
// without re-sorting. Declared BEFORE `/:id` so the literal sub-path
// wins the matcher race against the catch-all single-appointment
// route below.
router.get('/:id/messages', async (req, res) => {
  try {
    const { id } = req.params;
    if (!mongoose.isValidObjectId(id)) {
      return res
        .status(400)
        .json({ success: false, message: 'Invalid appointment id' });
    }
    const messages = await Message.find({ appointmentId: id })
      .sort({ timestamp: 1 })
      .lean();
    const out = messages.map((m) => ({
      id: m._id?.toString(),
      appointmentId: m.appointmentId?.toString(),
      senderId: m.senderId?.toString(),
      receiverId: m.receiverId?.toString(),
      messageText: m.messageText,
      timestamp: m.timestamp,
      isRead: m.isRead === true,
    }));
    res.json({ success: true, messages: out });
  } catch (err) {
    res
      .status(500)
      .json({ success: false, message: err.message || 'Server error' });
  }
});

// GET /api/appointments/:id
// Fetches one appointment (care_requests row) by its Mongo `_id`.
router.get('/:id', async (req, res) => {
  try {
    if (!mongoose.isValidObjectId(req.params.id)) {
      return res.status(400).json({ success: false, message: 'Invalid appointment id' });
    }
    const doc = await CareRequest.findById(req.params.id);
    if (!doc) {
      return res.status(404).json({ success: false, message: 'Appointment not found' });
    }
    const body = await attachDoctorToRequest(doc.toJSON());
    res.json(body);
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// PATCH /api/appointments/:id/update-status  { status }
//
// Canonical provider-driven status transition for the active visit:
//   accepted → on-the-way → arrived → completed
//
// Hardened:
//   - Bearer / header / query identity required (401 otherwise).
//   - Only an `assigned_doctor_id` OR `assigned_nurse_id` match for
//     the signed-in account / linked-provider id passes through
//     (403 for everyone else, including admins — admins use the
//     bulk-status endpoint).
//   - Status must be one of the spec-allowed values.
//   - On success the room broadcast (`appointment_status_change`)
//     fires so the patient's tracking screen and the chat input
//     gate flip instantly without a manual refresh.
router.patch(
  '/:id/update-status',
  requireAccountId,
  async (req, res) => {
    try {
      const { id } = req.params;
      if (!mongoose.isValidObjectId(id)) {
        return res
          .status(400)
          .json({ success: false, message: 'Invalid appointment id' });
      }
      const raw = (req.body && req.body.status ? String(req.body.status) : '')
        .toLowerCase()
        .trim();
      if (!ALLOWED_PROVIDER_STATUSES.has(raw)) {
        return res.status(400).json({
          success: false,
          message:
            "status must be one of: accepted, on-the-way, arrived, completed",
        });
      }
      const dbStatus = PROVIDER_STATUS_ALIASES[raw];

      const appt = await CareRequest.findById(id);
      if (!appt) {
        return res
          .status(404)
          .json({ success: false, message: 'Appointment not found' });
      }

      // Access control — the caller must be the assigned doctor OR
      // the assigned nurse on this care request. Admins are excluded
      // (they have a separate bulk-status surface) so the spec's
      // "strictly validate" requirement is respected.
      const identity = await resolveProviderIdentity(req.accountId);
      if (!identity || (identity.role !== 'doctor' && identity.role !== 'nurse')) {
        return res.status(403).json({
          success: false,
          message: 'Only the assigned provider can update this appointment.',
        });
      }
      const assignedDoctor = (appt.assigned_doctor_id || '').toString();
      const assignedNurse = (appt.assigned_nurse_id || '').toString();
      const isAssignedDoctor =
        identity.role === 'doctor' && identity.ids.has(assignedDoctor);
      const isAssignedNurse =
        identity.role === 'nurse' && identity.ids.has(assignedNurse);
      if (!isAssignedDoctor && !isAssignedNurse) {
        return res.status(403).json({
          success: false,
          message: 'Only the assigned provider can update this appointment.',
        });
      }

      // State-machine gate: a nurse flipping to `completed` on a visit
      // that has a doctor assigned parks in the `nurse_completed`
      // transitional state instead — the doctor still owes the
      // prescription (see POST /:id/complete for the same rule).
      let effectiveStatus = dbStatus;
      if (
        dbStatus === 'completed' &&
        identity.role === 'nurse' &&
        (appt.assigned_doctor_id || '').toString()
      ) {
        effectiveStatus = 'nurse_completed';
      }
      appt.status = effectiveStatus;
      // Completed visits stamp a server timestamp so the History
      // card timeline reads the finish time directly off the row
      // rather than racing it through `updated_at`. The transitional
      // `nurse_completed` state is NOT a finish, so it isn't stamped.
      if (effectiveStatus === 'completed') {
        appt.completed_at = appt.completed_at || new Date();
      }
      await appt.save();

      // Room broadcast — the chat input gate AND the patient
      // tracking screen both subscribe to this event. We emit the
      // wire-status (`on-the-way` etc.) so the client doesn't have
      // to know about the legacy enum.
      const io = req.app.get('io');
      if (io) {
        // When the nurse's `completed` was re-routed to the transitional
        // state, broadcast the real resulting status so the patient +
        // doctor screens reflect `nurse_completed`, not a premature close.
        const wireStatus =
          effectiveStatus === dbStatus ? raw : effectiveStatus;
        io.to(id).emit('appointment_status_change', {
          appointmentId: id,
          status: wireStatus,
          dbStatus: effectiveStatus,
          updatedBy: req.accountId,
          updatedRole: identity.role,
          timestamp: new Date().toISOString(),
        });
      }

      const body = await attachDoctorToRequest(appt.toJSON());
      return res.json({ success: true, appointment: body });
    } catch (err) {
      console.error('[appointments/update-status] error:', err);
      return res
        .status(500)
        .json({ success: false, message: err.message || 'Server error' });
    }
  },
);

// PATCH /api/appointments/:id/vitals  { vitals: { blood_pressure, pulse,
//                                                  spo2, temperature, ... } }
//
// Mid-visit vitals save from the Nurse Procedural Terminal. Writes the
// readings to the care request immediately (visible to admin + future
// doctor consults) without closing the visit. Assigned-provider only.
router.patch('/:id/vitals', requireAccountId, async (req, res) => {
  try {
    const { id } = req.params;
    if (!mongoose.isValidObjectId(id)) {
      return res
        .status(400)
        .json({ success: false, message: 'Invalid appointment id' });
    }
    const appt = await CareRequest.findById(id);
    if (!appt) {
      return res
        .status(404)
        .json({ success: false, message: 'Appointment not found' });
    }
    const guard = await assertAssignedProvider(req.accountId, appt);
    if (!guard.ok) {
      return res.status(guard.code).json({ success: false, message: guard.message });
    }
    applyVitals(appt, req.body && req.body.vitals, req.accountId);
    await appt.save();

    // Light broadcast so an admin watching the live monitor sees the
    // fresh readings without a refetch.
    const io = req.app.get('io');
    if (io) {
      io.to(id).emit('appointment_vitals_update', {
        appointmentId: id,
        vitals: appt.vitals,
        timestamp: new Date().toISOString(),
      });
    }
    const body = await attachDoctorToRequest(appt.toJSON());
    return res.json({ success: true, appointment: body });
  } catch (err) {
    console.error('[appointments/vitals] error:', err);
    return res
      .status(500)
      .json({ success: false, message: err.message || 'Server error' });
  }
});

// POST /api/appointments/:id/complete  { vitals?, summary? }
//
// The Nurse/Doctor console's "Complete Care Session" engine: persists the
// final vitals matrix + free-text wrap-up summary, flips the visit to
// `completed` (stamping `completed_at`), and emits `appointment_status_change`
// so the live chat room locks. Assigned-provider only.
router.post('/:id/complete', requireAccountId, async (req, res) => {
  try {
    const { id } = req.params;
    if (!mongoose.isValidObjectId(id)) {
      return res
        .status(400)
        .json({ success: false, message: 'Invalid appointment id' });
    }
    const appt = await CareRequest.findById(id);
    if (!appt) {
      return res
        .status(404)
        .json({ success: false, message: 'Appointment not found' });
    }
    const guard = await assertAssignedProvider(req.accountId, appt);
    if (!guard.ok) {
      return res.status(guard.code).json({ success: false, message: guard.message });
    }

    const body = req.body || {};
    applyVitals(appt, body.vitals, req.accountId);
    if (typeof body.summary === 'string') {
      appt.completion_summary = body.summary.trim().slice(0, 2000);
    }

    // State-machine gate: when the NURSE wraps up a visit that also has a
    // doctor assigned, the visit is not yet finished — it parks in the
    // `nurse_completed` transitional state so the doctor still has a
    // window to run "Finalize and Issue Prescription". A doctor closing
    // the visit, or a nurse-only visit (no doctor), goes straight to
    // `completed` and stamps the finish time.
    const hasDoctor = !!(appt.assigned_doctor_id || '').toString();
    const nurseAwaitingDoctor =
      guard.identity.role === 'nurse' && hasDoctor;
    const nextStatus = nurseAwaitingDoctor ? 'nurse_completed' : 'completed';
    appt.status = nextStatus;
    if (nextStatus === 'completed') {
      appt.completed_at = appt.completed_at || new Date();
    }
    await appt.save();

    const io = req.app.get('io');
    if (io) {
      io.to(id).emit('appointment_status_change', {
        appointmentId: id,
        status: nextStatus,
        dbStatus: nextStatus,
        updatedBy: req.accountId,
        updatedRole: guard.identity.role,
        timestamp: new Date().toISOString(),
      });
    }
    const out = await attachDoctorToRequest(appt.toJSON());
    return res.json({ success: true, appointment: out });
  } catch (err) {
    console.error('[appointments/complete] error:', err);
    return res
      .status(500)
      .json({ success: false, message: err.message || 'Server error' });
  }
});

// PATCH /api/appointments/:id/accept
//
// Provider accepts an incoming dispatch (status `assigned`). Shifts the
// visit straight into transit mode (`enroute` — "On the Way") and emits
// the status-change broadcast so the patient's tracking card flips.
// Assigned-provider only.
router.patch('/:id/accept', requireAccountId, async (req, res) => {
  try {
    const { id } = req.params;
    if (!mongoose.isValidObjectId(id)) {
      return res
        .status(400)
        .json({ success: false, message: 'Invalid appointment id' });
    }
    const appt = await CareRequest.findById(id);
    if (!appt) {
      return res
        .status(404)
        .json({ success: false, message: 'Appointment not found' });
    }
    const guard = await assertAssignedProvider(req.accountId, appt);
    if (!guard.ok) {
      return res.status(guard.code).json({ success: false, message: guard.message });
    }
    // Atomic transition guarded on the request still being `assigned`. The
    // identity check above proves the caller owns the dispatch; this CAS
    // proves no one (a provider double-tap, or a concurrent admin re-route)
    // has already moved it on. Only the first writer wins.
    const updated = await CareRequest.findOneAndUpdate(
      { _id: id, status: 'assigned' },
      { status: 'enroute' },
      { new: true },
    );
    if (!updated) {
      return res.status(409).json({
        success: false,
        message:
          'This dispatch was already accepted or is no longer awaiting acceptance.',
      });
    }

    const io = req.app.get('io');
    if (io) {
      io.to(id).emit('appointment_status_change', {
        appointmentId: id,
        status: 'on-the-way',
        dbStatus: 'enroute',
        updatedBy: req.accountId,
        updatedRole: guard.identity.role,
        timestamp: new Date().toISOString(),
      });
    }
    const out = await attachDoctorToRequest(updated.toJSON());
    return res.json({ success: true, appointment: out });
  } catch (err) {
    console.error('[appointments/accept] error:', err);
    return res
      .status(500)
      .json({ success: false, message: err.message || 'Server error' });
  }
});

// PATCH /api/appointments/:id/reject
//
// Provider declines an incoming dispatch. Unassigns the caller (clears
// their assignment fields) and drops the request back to `approved` so an
// admin can re-route it — leaving the nurse's board at "no active
// dispatches". Assigned-provider only.
router.patch('/:id/reject', requireAccountId, async (req, res) => {
  try {
    const { id } = req.params;
    if (!mongoose.isValidObjectId(id)) {
      return res
        .status(400)
        .json({ success: false, message: 'Invalid appointment id' });
    }
    const appt = await CareRequest.findById(id);
    if (!appt) {
      return res
        .status(404)
        .json({ success: false, message: 'Appointment not found' });
    }
    const guard = await assertAssignedProvider(req.accountId, appt);
    if (!guard.ok) {
      return res.status(guard.code).json({ success: false, message: guard.message });
    }
    // Clear only the caller's side of the assignment, atomically, and only
    // while the visit is still in a pre-completion state — so a reject
    // racing a completion (or a double-tap) can't resurrect a finished
    // visit back to `approved`.
    const clear =
      guard.identity.role === 'nurse'
        ? { assigned_nurse_id: null, assigned_nurse_name: null }
        : { assigned_doctor_id: null, assigned_doctor_name: null };
    const updated = await CareRequest.findOneAndUpdate(
      { _id: id, status: { $in: ['assigned', 'enroute', 'arrived'] } },
      { $set: { status: 'approved', ...clear } },
      { new: true },
    );
    if (!updated) {
      return res.status(409).json({
        success: false,
        message:
          'This dispatch can no longer be declined — its state has already changed.',
      });
    }

    const io = req.app.get('io');
    if (io) {
      io.to(id).emit('appointment_status_change', {
        appointmentId: id,
        status: 'approved',
        dbStatus: 'approved',
        updatedBy: req.accountId,
        updatedRole: guard.identity.role,
        timestamp: new Date().toISOString(),
      });
    }
    const out = await attachDoctorToRequest(updated.toJSON());
    return res.json({ success: true, appointment: out });
  } catch (err) {
    console.error('[appointments/reject] error:', err);
    return res
      .status(500)
      .json({ success: false, message: err.message || 'Server error' });
  }
});

// POST /api/appointments/:id/feedback  { rating, tags, comment?, account_id? }
//
// Writes the patient's rating + selected tags into the appointment
// feedback sub-doc and flips `is_reviewed: true`. Validates:
//   • rating in [1, 5]
//   • tags is an array of strings from the allow-list
//   • appointment is completed (you can't rate an in-flight visit)
//   • appointment isn't already reviewed
//   • appointment belongs to the requesting patient (when `account_id`
//     is provided; admin tools can omit it for moderation flows)
router.post('/:id/feedback', async (req, res) => {
  try {
    const { id } = req.params;
    if (!mongoose.isValidObjectId(id)) {
      return res.status(400).json({ success: false, message: 'Invalid appointment id' });
    }
    const body = req.body || {};
    const rating = Number(body.rating);
    if (!Number.isFinite(rating) || rating < 1 || rating > 5) {
      return res.status(400).json({
        success: false,
        message: 'rating must be an integer between 1 and 5',
      });
    }
    const tagsIn = Array.isArray(body.tags) ? body.tags : [];
    const tags = [];
    for (const t of tagsIn) {
      const s = String(t).trim();
      if (!ALLOWED_FEEDBACK_TAGS.has(s)) {
        return res.status(400).json({
          success: false,
          message: `Unknown feedback tag: ${s}`,
        });
      }
      if (!tags.includes(s)) tags.push(s); // dedupe
    }
    const comment = String(body.comment || '').trim().slice(0, 2000);

    const appt = await CareRequest.findById(id);
    if (!appt) {
      return res.status(404).json({ success: false, message: 'Appointment not found' });
    }
    if (appt.status !== 'completed') {
      return res.status(409).json({
        success: false,
        message: 'Appointment is not completed yet',
      });
    }
    // Ownership check when the client passes account_id. The doctor /
    // admin app could moderate without this, but the patient app
    // always sends it.
    if (
      body.account_id &&
      appt.patient_account_id &&
      String(appt.patient_account_id) !== String(body.account_id)
    ) {
      return res.status(403).json({
        success: false,
        message: 'This appointment belongs to a different account',
      });
    }
    if (appt.feedback && appt.feedback.is_reviewed) {
      return res.status(409).json({
        success: false,
        message: 'Feedback was already submitted for this appointment',
        feedback: appt.feedback,
      });
    }

    appt.feedback = {
      rating,
      tags,
      comment,
      is_reviewed: true,
      submitted_at: new Date(),
    };
    await appt.save();

    res.json({
      success: true,
      message: 'Thanks for the feedback!',
      appointment: appt.toJSON(),
    });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

module.exports = router;
