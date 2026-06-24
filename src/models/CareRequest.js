const mongoose = require('mongoose');

// `care_requests` collection. Field names are snake_case to match the
// Flutter snake_case_json parser layer exactly (no camelCase drift). The
// toJSON transform flattens `_id` -> `id` (string) and drops `__v`, mirroring
// the Service model convention.
const CareRequestSchema = new mongoose.Schema(
  {
    patient_name: { type: String, required: true, trim: true },
    patient_account_id: { type: String, default: '', index: true },
    patient_phone: { type: String, default: '' },
    care_type: { type: String, required: true }, // free-text, e.g. "Post-surgery home care"
    offered_budget: { type: Number, default: 0 },
    preferred_time: { type: String, default: null }, // ISO-8601 string or null (ASAP)
    duration_hours: { type: Number, default: 1 },
    condition_note: { type: String, default: '' },
    location_text: { type: String, default: '' },
    area: { type: String, default: '' },
    // Raw GPS coordinates captured by the patient's address manager. Null
    // when the patient only provided a free-text address. The admin live
    // monitor + the responding clinician read these to route the home
    // triage with zero location ambiguity.
    latitude: { type: Number, default: null },
    longitude: { type: Number, default: null },
    // Who the visit is actually for. Null = the booking patient themselves;
    // otherwise a saved dependent's profile snapshot, injected at booking
    // time so the responding doctor / nurse sees the recipient + their
    // critical allergies / history without a separate lookup.
    care_recipient: {
      name: { type: String, default: null },
      relationship: { type: String, default: null },
      medical_notes: { type: String, default: null },
    },
    status: {
      type: String,
      enum: [
        'submitted',
        'approved',
        'assigned',
        'enroute',
        'arrived',
        'in_service',
        // Transitional state: the nurse has finished her field checklist
        // but a doctor is assigned and still owes the prescription. The
        // visit is NOT yet terminal — the doctor's "Finalize and Issue
        // Prescription" step flips it to `completed`. Nurse-only visits
        // skip this and go straight to `completed`.
        'nurse_completed',
        'completed',
        'rejected',
        'cancelled',
      ],
      default: 'submitted',
      index: true,
    },
    final_price: { type: Number, default: null },
    admin_note: { type: String, default: null },
    assigned_doctor_id: { type: String, default: null, index: true },
    assigned_doctor_name: { type: String, default: null },
    assigned_nurse_id: { type: String, default: null, index: true },
    assigned_nurse_name: { type: String, default: null },
    assigned_helper_id: { type: String, default: null },
    assigned_helper_name: { type: String, default: null },
    urgency_level: {
      type: String,
      enum: ['low', 'medium', 'high', 'critical'],
      default: 'medium',
    },

    // Server timestamp stamped by `PATCH /api/appointments/:id/update-status`
    // when the provider flips the visit to `completed`. History card
    // timelines + the chat lockdown gate read this directly so a
    // race with `updated_at` (which moves on any save) doesn't lie
    // about the actual finish time.
    completed_at: { type: Date, default: null },

    // Free-text wrap-up the provider records on the Nurse/Doctor console's
    // "Complete Care Session" step (e.g. field anomalies observed). Written
    // by POST /api/appointments/:id/complete; surfaced to admin + future
    // doctor consults alongside the vitals snapshot below.
    completion_summary: { type: String, default: '' },

    // --- Post-visit data captured at completion ----------------------------
    // These three sub-docs are populated when the doctor flips the visit
    // to `status: 'completed'`. The patient's Rating screen renders them
    // and writes back to `feedback` via POST /api/appointments/:id/feedback.

    // Vitals dashboard — what the doctor recorded on-site. Each field is
    // a free-form string so the doctor app can write either a numeric
    // ("128/82") or a qualitative ("Clean") value depending on the metric.
    vitals: {
      blood_pressure: { type: String, default: null },   // e.g. "128/82"
      blood_pressure_unit: { type: String, default: 'mmHg' },
      temperature: { type: String, default: null },      // e.g. "99.1"
      temperature_unit: { type: String, default: '°F' },
      spo2: { type: String, default: null },             // e.g. "97"
      spo2_unit: { type: String, default: '%' },
      pulse: { type: String, default: null },            // e.g. "78"
      pulse_unit: { type: String, default: 'bpm' },
      pain_score: { type: String, default: null },       // e.g. "3/10"
      wound_status: { type: String, default: null },     // e.g. "Clean"
      recorded_by: { type: String, default: null },
      recorded_at: { type: Date, default: null },
    },

    // Final settlement structure. The Rating screen renders the line
    // items + total. Source of truth for billing / reporting too.
    // `total` is auto-recomputed by the pre('save') hook below whenever
    // any of the fee sub-fields change.
    payment: {
      doctor_fee: { type: Number, default: 0 },
      nurse_fee: { type: Number, default: 0 },
      helper_fee: { type: Number, default: 0 },
      platform_fee: { type: Number, default: 0 },
      total: { type: Number, default: 0 },
      currency: { type: String, default: 'BDT' },
      released_at: { type: Date, default: null },
    },

    // Patient feedback. `is_reviewed` is the latch the Rating screen
    // checks to avoid letting the same visit be rated twice (defensive;
    // the backend also rejects a second POST).
    feedback: {
      rating: { type: Number, min: 1, max: 5, default: null },
      tags: { type: [String], default: [] },
      comment: { type: String, default: '' },
      is_reviewed: { type: Boolean, default: false },
      submitted_at: { type: Date, default: null },
    },
  },
  { timestamps: { createdAt: 'created_at', updatedAt: 'updated_at' } }
);

// Keep `payment.total` in lockstep with the four fee sub-fields. Hook
// only fires when the payment sub-doc actually changed — untouched
// rows aren't rewritten, and an admin-overridden total stays sticky
// because manually setting `payment.total` will get re-derived on the
// next save (the assumption: the per-fee fields are the source of
// truth; if you want to override the total, write all four fee fields
// to add up the way you want).
CareRequestSchema.pre('save', function (next) {
  if (this.isModified('payment')) {
    const p = this.payment || {};
    const sum =
      (Number(p.doctor_fee) || 0) +
      (Number(p.nurse_fee) || 0) +
      (Number(p.helper_fee) || 0) +
      (Number(p.platform_fee) || 0);
    this.payment.total = sum;
  }
  next();
});

CareRequestSchema.set('toJSON', {
  virtuals: true,
  versionKey: false,
  transform: (_doc, ret) => {
    ret.id = ret._id.toString();
    delete ret._id;
    return ret;
  },
});

module.exports = mongoose.model('CareRequest', CareRequestSchema);
