const mongoose = require('mongoose');

// `providers` collection — doctors and medical helpers the admin assigns.
// `rating` / `fee` / `specialization` / `years_experience` are match metadata
// surfaced on the Assign Team list.
const ProviderSchema = new mongoose.Schema(
  {
    full_name: { type: String, required: true, trim: true },
    email: { type: String, default: '' },
    phone: { type: String, default: '' },
    role: {
      type: String,
      enum: ['doctor', 'nurse', 'helper'],
      default: 'doctor',
      index: true,
    },
    specialization: { type: String, default: '' },
    specialty: { type: String, default: '' }, // helper-side label
    years_experience: { type: Number, default: 0 },
    rating: { type: Number, default: 0 },
    review_count: { type: Number, default: 0 },
    distance_km: { type: Number, default: 0 },
    fee: { type: Number, default: 0 },
    // Geographic radius (km) the doctor is willing to travel for a home
    // visit. Surfaced + editable from the Doctor Profile screen and used
    // by the admin's match scoring when assigning a team.
    service_radius_km: { type: Number, default: 5 },
    verification_status: {
      type: String,
      enum: ['pending', 'verified'],
      default: 'pending',
    },
    availability_status: {
      type: String,
      enum: ['online', 'offline'],
      default: 'offline',
      index: true,
    },
    // Doctor / helper avatar uploaded via the Profile screen. Public
    // URL, served by Express static `/uploads`. Same value the linked
    // Account row carries — the upload route writes both in parallel
    // because the Flutter session id might be either collection's _id.
    profile_picture: { type: String, default: '' },

    // Free-form "About me" markdown rendered on the public profile.
    // Capped to keep the doctor-side editor reasonable + the network
    // payload light. Plain string for now; rich text is a follow-up.
    bio: { type: String, default: '', trim: true, maxlength: 2000 },

    // Hospital / clinic the doctor is currently affiliated with. Free
    // text — we don't link to a separate hospitals collection yet.
    hospital_affiliation: { type: String, default: '', trim: true },

    // Distinct from `verification_status` (which is the admin-managed
    // pending|verified enum). This explicit boolean drives the small
    // blue checkmark badge on the Flutter Profile header so the UI
    // doesn't need to know about the admin workflow vocabulary. Kept
    // in lockstep with `verification_status` via a pre('save') hook
    // below — flipping the enum to 'verified' auto-flips this field.
    is_verified_doctor: {
      type: Boolean,
      default: false,
      index: true,
    },

    // BMDC (Bangladesh Medical & Dental Council) license number.
    // Empty string until the doctor fills it via the "Complete your
    // profile" sheet; one of the five completeness checklist items.
    // `sparse: true` is forward-looking — it's not currently unique,
    // but if uniqueness lands later, sparseness keeps empty strings
    // from colliding on the null branch of the index.
    bmdc_license: { type: String, default: '', trim: true, sparse: true },

    // Nursing Council license — the nurse-side equivalent of
    // `bmdc_license`. Same onboarding row, same status engine flag,
    // different free-text label. Sparse for the same reason.
    nursing_license: { type: String, default: '', trim: true, sparse: true },

    // Nurse-side mirror of `is_verified_doctor`. Lit up by the
    // pre('save') hook below when `verification_status === 'verified'`
    // AND `role === 'nurse'`.
    is_verified_nurse: {
      type: Boolean,
      default: false,
      index: true,
    },

    // Work-experience history. Capped at 20 entries to bound payload
    // size — a longer career history can layer in via a paginated
    // sub-resource later. `validate` rejects oversized arrays at save
    // time instead of letting the row grow unboundedly.
    experience: {
      type: [
        {
          hospital_name: { type: String, required: true, trim: true },
          designation: { type: String, required: true, trim: true },
          years: { type: Number, default: 0, min: 0, max: 80 },
          started_at: { type: Date, default: null },
          ended_at: { type: Date, default: null },
        },
      ],
      default: [],
      validate: {
        validator: (v) => v.length <= 20,
        message: 'Too many experience entries (max 20)',
      },
    },

    // Transient OTP gating admin edits to this provider's profile.
    // Lifecycle:
    //   1. Admin clicks Edit → `POST /admin/providers/:id/request-update-otp`
    //      generates a 6-digit code, sets the expiry to now + 5 min,
    //      and logs / mock-SMSes the code.
    //   2. Admin types the code into the verification dialog and
    //      submits the edit → `PATCH /admin/providers/:id/update-profile`
    //      checks the code + expiry, applies the changes, and clears
    //      both fields back to null.
    // Both fields are deliberately NOT included in `toJSON` (see the
    // transform at the bottom of the file) so they never leak to
    // any client — only the server compares them.
    update_authorization_otp: { type: String, default: null },
    update_authorization_otp_expires: { type: Date, default: null },

    // bKash / bank-transfer payout. `method` gates which fields the
    // UI renders. `account_number` is stored in plaintext but every
    // read path runs it through `utils/payout.js` to mask all but
    // the last 4 digits before responding.
    payout_details: {
      method: {
        type: String,
        enum: ['bKash', 'Bank', null],
        default: null,
      },
      account_number: { type: String, default: '', trim: true },
      account_name: { type: String, default: '', trim: true },
      bank_name: { type: String, default: '', trim: true },
      branch: { type: String, default: '', trim: true },
      updated_at: { type: Date, default: null },
    },
  },
  { timestamps: { createdAt: 'created_at', updatedAt: 'updated_at' } }
);

// Keep `is_verified_{doctor,nurse}` consistent with the existing
// `verification_status` enum so an admin marking a row 'verified'
// automatically lights up the badge for whichever provider role this
// row carries. Idempotent: no-op when the two are already aligned.
// Doesn't auto-clear in the other direction — explicit unverify needs
// an explicit write.
ProviderSchema.pre('save', function (next) {
  if (this.verification_status === 'verified') {
    if (this.role === 'doctor' && !this.is_verified_doctor) {
      this.is_verified_doctor = true;
    }
    if (this.role === 'nurse' && !this.is_verified_nurse) {
      this.is_verified_nurse = true;
    }
  }
  next();
});

ProviderSchema.set('toJSON', {
  virtuals: true,
  versionKey: false,
  transform: (_doc, ret) => {
    ret.id = ret._id.toString();
    delete ret._id;
    // Transient OTP material is server-only — strip from every
    // serialised response so a busted controller can't accidentally
    // ship the code to an admin or to the wire.
    delete ret.update_authorization_otp;
    delete ret.update_authorization_otp_expires;
    return ret;
  },
});

module.exports = mongoose.model('Provider', ProviderSchema);
