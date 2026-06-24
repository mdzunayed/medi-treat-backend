const express = require('express');
const mongoose = require('mongoose');
const Prescription = require('../models/Prescription');
const CareRequest = require('../models/CareRequest');
const { requireAccountId } = require('../middleware/auth');
const { safeEmitNotification } = require('../services/notificationService');
const { sendHighPriorityPush } = require('../services/fcmService');
const { loadProviderPair } = require('../utils/doctorView');

const router = express.Router();

const MEAL_CONTEXT = new Set(['before', 'after', 'either']);

// Statuses during which a doctor may issue a prescription: the visit is
// either still actively in care, or the nurse has handed off and the
// doctor owes the finalize step (`nurse_completed`). Terminal states
// (`completed`, `cancelled`, `rejected`) are rejected with a 409 so the
// doctor's screen can surface a clear status-lock message instead of
// silently appending a script to a closed visit.
const PRESCRIBABLE_STATUSES = new Set([
  'assigned',
  'enroute',
  'arrived',
  'in_service',
  'nurse_completed',
]);

/**
 * Normalise + validate a medication line item before it lands in
 * Mongo. Throws an Error with a 400-friendly message on the first
 * problem so the route's try/catch can surface it.
 */
function normaliseItem(raw, idx) {
  const out = {};
  const drug = (raw?.drug_name ?? raw?.drugName ?? '').toString().trim();
  if (!drug) throw new Error(`items[${idx}].drug_name is required`);
  out.drug_name = drug;
  const dosage = (raw?.dosage ?? '').toString().trim();
  if (!dosage) throw new Error(`items[${idx}].dosage is required`);
  out.dosage = dosage;
  const freq = raw?.frequency ?? {};
  const morning = !!(freq.morning ?? raw?.morning);
  const afternoon = !!(freq.afternoon ?? raw?.afternoon);
  const night = !!(freq.night ?? raw?.night);
  if (!morning && !afternoon && !night) {
    throw new Error(`items[${idx}] must select at least one time slot`);
  }
  out.frequency = { morning, afternoon, night };
  const meal = (raw?.meal_context ?? raw?.mealContext ?? 'either')
    .toString()
    .toLowerCase();
  if (!MEAL_CONTEXT.has(meal)) {
    throw new Error(
      `items[${idx}].meal_context must be one of: before, after, either`,
    );
  }
  out.meal_context = meal;
  const dur = Number(raw?.duration_days ?? raw?.durationDays ?? 7);
  if (!Number.isFinite(dur) || dur < 1 || dur > 365) {
    throw new Error(`items[${idx}].duration_days must be 1..365`);
  }
  out.duration_days = Math.floor(dur);
  out.notes = (raw?.notes ?? '').toString().trim().slice(0, 500);
  return out;
}

// POST /api/prescriptions
//   { appointmentId, patientAccountId?, diagnosis?, items: [{...}] }
//
// Doctor flow: at "Care Completed" the doctor's prescription form
// fires this with the medication list. The route validates each
// line item, links the script to the originating CareRequest, and
// fans out the in-app + FCM push so the patient sees the new
// prescription on the medication timeline.
router.post('/', requireAccountId, async (req, res) => {
  try {
    const body = req.body || {};
    const appointmentId = body.appointmentId || body.appointment_id;
    if (!appointmentId || !mongoose.isValidObjectId(appointmentId)) {
      return res
        .status(400)
        .json({ success: false, message: 'Valid appointmentId is required' });
    }
    // Validate the medication payload BEFORE we touch the visit's
    // state. Running validation up-front guarantees a malformed request
    // can never win the finalize race and strand the visit in
    // `completed` with no script attached.
    //
    // Role guard is intentionally light here — production should enforce
    // `assigned_doctor_id` ⇔ requireAccountId match; for this route the
    // doctor is identified by their account id.
    const items = Array.isArray(body.items) ? body.items : [];
    if (items.length === 0) {
      return res.status(400).json({
        success: false,
        message: 'At least one medication line item is required',
      });
    }
    const normalised = [];
    for (let i = 0; i < items.length; i++) {
      normalised.push(normaliseItem(items[i], i));
    }

    // Atomic finalize gate — issuing the prescription IS the doctor's
    // "Finalize and Issue Prescription" action, which flips the visit to
    // its terminal `completed` state. We collapse the old
    // read-then-write (which let two simultaneous taps both pass the
    // status check and both issue a script) into a single isolated
    // transition: only a visit still in a prescribable state can be
    // claimed, and the matched document flips to `completed` in the same
    // round-trip — so exactly one concurrent request can ever win.
    // `released_at` settles the revenue log; we don't touch the fee
    // fields, so `payment.total` is unaffected (the pre-save hook only
    // recomputes the total from those fees, and findOneAndUpdate skips
    // it regardless).
    const now = new Date();
    const claimed = await CareRequest.findOneAndUpdate(
      { _id: appointmentId, status: { $in: [...PRESCRIBABLE_STATUSES] } },
      {
        $set: {
          status: 'completed',
          completed_at: now,
          'payment.released_at': now,
        },
      },
      { new: true, runValidators: true },
    );

    // A null result means we either targeted a non-existent visit or
    // lost the race / collided with a duplicate finalize. Disambiguate
    // with a cheap existence probe so the client still gets 404 vs 409.
    if (!claimed) {
      const exists = await CareRequest.exists({ _id: appointmentId });
      if (!exists) {
        return res
          .status(404)
          .json({ success: false, message: 'Appointment not found' });
      }
      return res.status(409).json({
        success: false,
        error: 'CONFLICT',
        message: 'This care prescription has already been finalized.',
      });
    }

    // Past this point we are the sole winner of the finalize transition,
    // so the script creation and every downstream side effect below run
    // exactly once for this visit.
    const patientAccountId =
      body.patientAccountId ||
      body.patient_account_id ||
      claimed.patient_account_id ||
      '';

    const doc = await Prescription.create({
      appointment_id: appointmentId,
      patient_account_id: patientAccountId,
      doctor_account_id: req.accountId,
      doctor_name:
        body.doctorName ||
        body.doctor_name ||
        claimed.assigned_doctor_name ||
        '',
      diagnosis: (body.diagnosis || '').toString().trim().slice(0, 600),
      items: normalised,
    });

    const ioFinalize = req.app.get('io');
    if (ioFinalize) {
      ioFinalize.to(appointmentId.toString()).emit('appointment_status_change', {
        appointmentId: appointmentId.toString(),
        status: 'completed',
        dbStatus: 'completed',
        updatedBy: req.accountId,
        updatedRole: 'doctor',
        timestamp: new Date().toISOString(),
      });
    }

    // Patient fan-out — bell badge + OS-level push so the medication
    // timeline lights up immediately. Best-effort: a failed push
    // doesn't tank the issuance.
    if (patientAccountId) {
      const io = req.app.get('io');
      const title = 'New prescription issued';
      const body2 =
        `Your doctor has issued ${normalised.length} medication` +
        (normalised.length === 1 ? '' : 's') +
        '. Open Activities → Medications to review.';
      try {
        await safeEmitNotification(io, {
          recipientId: patientAccountId,
          senderId: req.accountId,
          title,
          body: body2,
          type: 'system_broadcast',
          payload: {
            prescriptionId: doc._id.toString(),
            appointmentId: appointmentId.toString(),
            deepLink: 'medication_timeline',
          },
        });
      } catch (_) {
        /* in-app fan-out failure is non-fatal */
      }
      // eslint-disable-next-line no-floating-promises
      sendHighPriorityPush(patientAccountId, title, body2, {
        click_action: 'FLUTTER_NOTIFICATION_CLICK',
        prescriptionId: doc._id.toString(),
        appointmentId: appointmentId.toString(),
        deepLink: 'medication_timeline',
      });
    }

    return res.status(201).json({
      success: true,
      prescription: doc.toJSON(),
      appointmentStatus: claimed.status,
    });
  } catch (err) {
    const msg = err.message || 'Server error';
    const isValidation =
      msg.includes('required') ||
      msg.includes('must be') ||
      msg.includes('select at least');
    return res
      .status(isValidation ? 400 : 500)
      .json({ success: false, message: msg });
  }
});

// GET /api/prescriptions/my-active
//
// Lists every prescription whose calendar window (`issued_at` +
// `max(duration_days)` across items) overlaps the current day. The
// patient's medication timeline reads off this surface. Bearer or
// `?account_id=` identity required.
router.get('/my-active', requireAccountId, async (req, res) => {
  try {
    const all = await Prescription.find({
      patient_account_id: req.accountId,
    }).sort({ issued_at: -1 });

    const now = Date.now();
    const active = all.filter((p) => {
      const maxDays = p.items.reduce(
        (m, it) => Math.max(m, Number(it.duration_days) || 0),
        0,
      );
      if (maxDays <= 0) return true; // be permissive
      const endAt =
        new Date(p.issued_at).getTime() + maxDays * 24 * 60 * 60 * 1000;
      return endAt >= now;
    });
    res.json({
      success: true,
      prescriptions: active.map((p) => p.toJSON()),
    });
  } catch (err) {
    res
      .status(500)
      .json({ success: false, message: err.message || 'Server error' });
  }
});

// GET /api/prescriptions/by-patient/:accountId
//
// Every prescription issued to a given patient, newest-first. Backs the
// Doctor Operations Hub's Patient Records detail and the Active Care
// Console's "past prescription history" disclosure. Registered before
// the `/:id` route so the literal `by-patient` segment wins. Auth
// required (any signed-in provider/patient); a treating doctor must be
// able to read the script history they're reviewing.
router.get('/by-patient/:accountId', requireAccountId, async (req, res) => {
  try {
    const { accountId } = req.params;
    if (!accountId) {
      return res
        .status(400)
        .json({ success: false, message: 'accountId is required' });
    }
    const rows = await Prescription.find({
      patient_account_id: accountId,
    }).sort({ issued_at: -1 });
    res.json({
      success: true,
      prescriptions: rows.map((p) => p.toJSON()),
    });
  } catch (err) {
    res
      .status(500)
      .json({ success: false, message: err.message || 'Server error' });
  }
});

// GET /api/prescriptions/:id  — single prescription read.
router.get('/:id', requireAccountId, async (req, res) => {
  try {
    const { id } = req.params;
    if (!mongoose.isValidObjectId(id)) {
      return res
        .status(400)
        .json({ success: false, message: 'Invalid prescription id' });
    }
    const doc = await Prescription.findById(id);
    if (!doc) {
      return res
        .status(404)
        .json({ success: false, message: 'Prescription not found' });
    }
    // Ownership check — patient OR issuing doctor.
    if (
      doc.patient_account_id !== req.accountId &&
      doc.doctor_account_id !== req.accountId
    ) {
      return res
        .status(403)
        .json({ success: false, message: 'Forbidden' });
    }

    // Enrich for the patient's prescription vault: resolve the issuing
    // doctor's verified credentials (BMDC reg + specialty) and surface the
    // originating visit's reported condition as "symptoms". Best-effort —
    // the script still returns even if the joins miss.
    const out = doc.toJSON();
    try {
      if (doc.doctor_account_id) {
        const { provider } = await loadProviderPair(
          doc.doctor_account_id,
          'doctor',
        );
        if (provider) {
          out.doctor = {
            full_name: provider.full_name || doc.doctor_name || '',
            bmdc_license: provider.bmdc_license || '',
            specialization: provider.specialization || '',
            is_verified_doctor:
              provider.is_verified_doctor === true ||
              provider.verification_status === 'verified',
          };
        }
      }
    } catch (_) {
      /* credential join is non-fatal */
    }
    try {
      if (doc.appointment_id) {
        const appt = await CareRequest.findById(doc.appointment_id).lean();
        if (appt) out.symptoms = appt.condition_note || '';
      }
    } catch (_) {
      /* symptoms join is non-fatal */
    }

    res.json({ success: true, prescription: out });
  } catch (err) {
    res
      .status(500)
      .json({ success: false, message: err.message || 'Server error' });
  }
});

// PATCH /api/prescriptions/:id/dose
//   { itemId, slot, dayKey?, taken: bool }
//
// Toggles the "Mark as Taken" state for one (item, slot, day)
// triple. Idempotent — appending the same triple twice on the same
// day collapses to a single log row; `taken: false` removes the
// most recent matching row.
router.patch('/:id/dose', requireAccountId, async (req, res) => {
  try {
    const { id } = req.params;
    if (!mongoose.isValidObjectId(id)) {
      return res
        .status(400)
        .json({ success: false, message: 'Invalid prescription id' });
    }
    const { itemId, slot, dayKey, taken } = req.body || {};
    if (!itemId || !mongoose.isValidObjectId(itemId)) {
      return res
        .status(400)
        .json({ success: false, message: 'Valid itemId is required' });
    }
    if (!['morning', 'afternoon', 'night'].includes(slot)) {
      return res
        .status(400)
        .json({ success: false, message: "slot must be morning|afternoon|night" });
    }
    const today = new Date();
    const day = (dayKey || today.toISOString().slice(0, 10)).toString();

    const doc = await Prescription.findById(id);
    if (!doc) {
      return res
        .status(404)
        .json({ success: false, message: 'Prescription not found' });
    }
    if (doc.patient_account_id !== req.accountId) {
      return res.status(403).json({ success: false, message: 'Forbidden' });
    }
    const item = doc.items.id(itemId);
    if (!item) {
      return res
        .status(404)
        .json({ success: false, message: 'Medication item not found' });
    }
    const matches = doc.dose_log.filter(
      (d) =>
        d.prescription_item_id?.toString() === itemId &&
        d.slot === slot &&
        d.day_key === day,
    );
    if (taken === false) {
      // Remove the most recent matching dose.
      if (matches.length > 0) {
        const target = matches[matches.length - 1];
        doc.dose_log = doc.dose_log.filter(
          (d) => d._id.toString() !== target._id.toString(),
        );
      }
    } else {
      // Default `taken: true` — only append if not already logged today.
      if (matches.length === 0) {
        doc.dose_log.push({
          prescription_item_id: itemId,
          slot,
          day_key: day,
          taken_at: new Date(),
        });
      }
    }
    await doc.save();
    res.json({ success: true, prescription: doc.toJSON() });
  } catch (err) {
    res
      .status(500)
      .json({ success: false, message: err.message || 'Server error' });
  }
});

module.exports = router;
