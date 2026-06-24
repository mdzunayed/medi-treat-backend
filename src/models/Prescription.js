const mongoose = require('mongoose');

// One prescription = one digital script issued by a doctor at the
// end of a visit. Contains N medication line items + structural
// timing metadata so the patient-side medication timeline can render
// per-slot reminders. `appointment_id` ties it back to the
// CareRequest the script came out of.

const FrequencySlotSchema = new mongoose.Schema(
  {
    morning: { type: Boolean, default: false },
    afternoon: { type: Boolean, default: false },
    night: { type: Boolean, default: false },
  },
  { _id: false }
);

const PrescriptionItemSchema = new mongoose.Schema(
  {
    drug_name: { type: String, required: true, trim: true, maxlength: 200 },
    dosage: { type: String, required: true, trim: true, maxlength: 120 },
    // Bilingual UX maps to a single canonical enum so the timeline
    // can group by slot.
    frequency: { type: FrequencySlotSchema, default: () => ({}) },
    // Meal context — one of 'before' | 'after' | 'either'.
    meal_context: {
      type: String,
      enum: ['before', 'after', 'either'],
      default: 'either',
    },
    duration_days: { type: Number, min: 1, max: 365, default: 7 },
    notes: { type: String, default: '', trim: true, maxlength: 500 },
  },
  { _id: true }
);

const PrescriptionSchema = new mongoose.Schema(
  {
    appointment_id: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'CareRequest',
      required: true,
      index: true,
    },
    patient_account_id: {
      type: String,
      required: true,
      index: true,
    },
    doctor_account_id: {
      type: String,
      default: '',
    },
    doctor_name: { type: String, default: '', trim: true },
    diagnosis: { type: String, default: '', trim: true, maxlength: 600 },
    items: {
      type: [PrescriptionItemSchema],
      validate: [(v) => v.length >= 1, 'At least one medication is required'],
      default: [],
    },
    issued_at: { type: Date, default: Date.now, index: true },
    // Patient-side adherence tracking. Each `dose_log` entry is one
    // "Mark as Taken" tap. `prescription_item_id` references a row
    // inside `items`; `slot` is one of 'morning' | 'afternoon' |
    // 'night'; `taken_at` is the local timestamp.
    dose_log: {
      type: [
        new mongoose.Schema(
          {
            prescription_item_id: { type: mongoose.Schema.Types.ObjectId },
            slot: {
              type: String,
              enum: ['morning', 'afternoon', 'night'],
            },
            taken_at: { type: Date, default: Date.now },
            // YYYY-MM-DD bucket the dose belongs to. Stored
            // explicitly so the timeline can summarise per day
            // without re-deriving from `taken_at`.
            day_key: { type: String },
          },
          { _id: true }
        ),
      ],
      default: [],
    },
  },
  { timestamps: { createdAt: 'created_at', updatedAt: 'updated_at' } }
);

PrescriptionSchema.set('toJSON', {
  virtuals: true,
  versionKey: false,
  transform: (_doc, ret) => {
    ret.id = ret._id?.toString();
    ret.appointmentId = ret.appointment_id?.toString();
    ret.patientAccountId = ret.patient_account_id;
    delete ret._id;
    delete ret.appointment_id;
    delete ret.patient_account_id;
    return ret;
  },
});

module.exports = mongoose.model('Prescription', PrescriptionSchema);
