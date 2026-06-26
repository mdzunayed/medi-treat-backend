const express = require('express');
const mongoose = require('mongoose');
const CareRequest = require('../models/CareRequest');
const Account = require('../models/Account');
const { attachDoctorToRequest } = require('../utils/doctorView');
const { safeEmitNotification } = require('../services/notificationService');

const router = express.Router();

// Fields the patient profile screen is allowed to mutate. Anything else in
// the PATCH body (role, status, password_hash, etc.) is dropped before we
// hit Mongoose so a malicious or buggy client can't escalate privileges.
const PATIENT_EDITABLE_FIELDS = ['full_name', 'email', 'phone'];

function pickPatientFields(body) {
  const out = {};
  for (const k of PATIENT_EDITABLE_FIELDS) {
    if (body[k] !== undefined && body[k] !== null) {
      out[k] = typeof body[k] === 'string' ? body[k].trim() : body[k];
    }
  }
  return out;
}

const TERMINAL = ['completed', 'cancelled', 'rejected'];

// Derive a coarse area from free-text location ("House 42, Dhanmondi" -> "Dhanmondi").
function areaFromLocation(location) {
  if (!location) return '';
  const parts = String(location).split(',');
  return parts[parts.length - 1].trim();
}

// Coerce an incoming coordinate to a finite Number, or null. Guards against
// an explicit `null` / '' becoming a bogus 0,0 (Gulf-of-Guinea) fix.
function coordOrNull(v) {
  if (v === undefined || v === null || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

// Normalise the optional care-recipient (dependent) block on a booking.
// Returns null for a self-booking; otherwise a clean snapshot the provider
// surfaces. A missing name collapses the whole block to null.
function pickCareRecipient(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const name = (raw.name ?? '').toString().trim();
  if (!name) return null;
  const str = (v) => {
    const s = (v ?? '').toString().trim();
    return s || null;
  };
  return {
    name,
    relationship: str(raw.relationship),
    medical_notes: str(raw.medical_notes),
  };
}

// POST /patient/requests — create a care request. Returns 201 + the row.
router.post('/requests', async (req, res) => {
  try {
    const b = req.body || {};
    if (!b.patient_name || !String(b.patient_name).trim()) {
      return res.status(400).json({ message: 'patient_name is required' });
    }
    if (!b.care_type || !String(b.care_type).trim()) {
      return res.status(400).json({ message: 'care_type is required' });
    }

    const doc = await CareRequest.create({
      patient_name: String(b.patient_name).trim(),
      patient_account_id: b.patient_account_id || '',
      patient_phone: b.patient_phone || '',
      care_type: String(b.care_type).trim(),
      offered_budget: Number(b.offered_budget) || 0,
      preferred_time: b.preferred_time || null,
      duration_hours: Number(b.duration_hours) || 1,
      condition_note: b.condition_note || '',
      location_text: b.location_text || '',
      area: b.area || areaFromLocation(b.location_text),
      latitude: coordOrNull(b.latitude),
      longitude: coordOrNull(b.longitude),
      care_recipient: pickCareRecipient(b.care_recipient),
      status: 'submitted',
      urgency_level: b.urgency_level || (b.preferred_time ? 'medium' : 'high'),
    });

    // Fan-out to every admin. Booking volume is low and admins are
    // few — a per-admin write keeps the inbox model uniform across
    // roles (one row per delivery, no shared mutable state).
    const io = req.app.get('io');
    try {
      const admins = await Account.find({ role: 'admin' }, '_id').lean();
      const title = 'New booking submitted';
      const body =
        `${doc.patient_name} requested ${doc.care_type}` +
        (doc.location_text ? ` in ${doc.location_text}` : '') +
        '.';
      const payload = {
        requestId: doc._id.toString(),
        patientName: doc.patient_name,
        careType: doc.care_type,
      };
      await Promise.all(
        admins.map((a) =>
          safeEmitNotification(io, {
            recipientId: a._id,
            senderId: b.patient_account_id || null,
            title,
            body,
            type: 'system_broadcast',
            payload,
          })
        )
      );
    } catch (e) {
      // Notification fan-out is best-effort — log and move on.
      console.warn('[notifications] admin fan-out skipped:', e.message);
    }

    res.status(201).json(doc.toJSON());
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// POST /patient/requests/:id/cancel  { reason? }
//
// Patient-initiated cancellation from the "Under Review" queue. Only allowed
// BEFORE a field coordinator claims the dispatch — once it's `assigned` (or
// further), the patient can no longer pull it back unilaterally. Implemented
// as an atomic compare-and-swap guarded on the pre-assignment states so a
// cancel racing an admin assignment can't strand the request in a bad state.
router.post('/requests/:id/cancel', async (req, res) => {
  try {
    const { id } = req.params;
    if (!mongoose.isValidObjectId(id)) {
      return res.status(400).json({ message: 'Invalid request id' });
    }
    const reason =
      typeof (req.body && req.body.reason) === 'string'
        ? req.body.reason.trim()
        : '';

    const cancelled = await CareRequest.findOneAndUpdate(
      { _id: id, status: { $in: ['submitted', 'approved'] } },
      {
        $set: {
          status: 'cancelled',
          admin_note: reason
            ? `Cancelled by patient: ${reason}`
            : 'Cancelled by patient',
        },
      },
      { new: true },
    );

    if (!cancelled) {
      // Distinguish "gone" from "too late to cancel" so the UI can explain.
      const exists = await CareRequest.exists({ _id: id });
      return res.status(exists ? 409 : 404).json({
        message: exists
          ? 'This request can no longer be cancelled — a coordinator has already started working on it.'
          : 'Request not found',
      });
    }

    res.json(cancelled.toJSON());
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// GET /patient/requests/active?account_id=  — newest non-terminal request.
router.get('/requests/active', async (req, res) => {
  try {
    const { account_id } = req.query;
    const filter = { status: { $nin: TERMINAL } };
    if (account_id) filter.patient_account_id = account_id;
    const doc = await CareRequest.findOne(filter).sort({ created_at: -1 });
    if (!doc) return res.status(404).json({ message: 'No active request' });
    const body = await attachDoctorToRequest(doc.toJSON());
    res.json(body);
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// GET /patient/home?account_id=  — minimal home-feed shape.
router.get('/home', async (req, res) => {
  try {
    const { account_id } = req.query;
    const filter = { status: { $nin: TERMINAL } };
    if (account_id) filter.patient_account_id = account_id;
    const active = await CareRequest.findOne(filter).sort({ created_at: -1 });
    const activeJson = active
      ? await attachDoctorToRequest(active.toJSON())
      : null;
    res.json({
      active_request: activeJson,
      recent_providers: [],
      unread_notification_count: 0,
      fetched_at: new Date().toISOString(),
    });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// GET /patient/profile?account_id=
// Returns the Account document for the signed-in patient. Passwords are
// stripped automatically by the Account model's toJSON transform.
router.get('/profile', async (req, res) => {
  try {
    const { account_id } = req.query;
    if (!account_id) {
      return res.status(400).json({ message: 'account_id is required' });
    }
    const acct = await Account.findById(account_id);
    if (!acct) return res.status(404).json({ message: 'Account not found' });
    res.json(acct.toJSON());
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// PATCH /patient/profile  { account_id, full_name?, email?, phone? }
// Partial update via findByIdAndUpdate so a save touching only `phone`
// does not wipe `email` or `full_name`. Returns the updated document.
router.patch('/profile', async (req, res) => {
  try {
    const body = req.body || {};
    const accountId = body.account_id;
    if (!accountId) {
      return res.status(400).json({ message: 'account_id is required' });
    }
    const updates = pickPatientFields(body);
    if (Object.keys(updates).length === 0) {
      return res.status(400).json({ message: 'No editable fields supplied' });
    }
    const acct = await Account.findByIdAndUpdate(
      accountId,
      { $set: updates },
      { new: true, runValidators: true }
    );
    if (!acct) return res.status(404).json({ message: 'Account not found' });
    res.json(acct.toJSON());
  } catch (err) {
    // Duplicate email surfaces as a Mongo 11000 — translate to 409 so the
    // Flutter side can show a friendly "Email already in use" SnackBar.
    if (err && err.code === 11000) {
      return res.status(409).json({ message: 'Email is already in use' });
    }
    res.status(500).json({ message: err.message });
  }
});

// GET /patient/requests/history?account_id=
// Closed (terminal) requests, newest first — powers the "View past requests"
// row on the Patient Profile screen.
router.get('/requests/history', async (req, res) => {
  try {
    const { account_id } = req.query;
    const filter = { status: { $in: TERMINAL } };
    if (account_id) filter.patient_account_id = account_id;
    const rows = await CareRequest.find(filter).sort({ created_at: -1 }).limit(50);
    res.json(rows.map((d) => d.toJSON()));
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

module.exports = router;
