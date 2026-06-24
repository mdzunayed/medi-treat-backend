const mongoose = require('mongoose');

// `dependents` collection — the family / dependents medical-profile matrix a
// patient books care on behalf of. Linked to the owning account by
// `parent_account_id` (String, snake_case id convention). The dependent's
// critical allergies / medical history is injected into the booking's
// `care_recipient` block so the responding doctor / nurse sees it instantly.
const DependentSchema = new mongoose.Schema(
  {
    parent_account_id: { type: String, required: true, index: true },
    full_name: { type: String, required: true, trim: true, maxlength: 120 },
    // Stored as a plain ISO-ish string so the client controls formatting;
    // no enforced Date parse (a partial "1990" is acceptable input).
    date_of_birth: { type: String, default: '', trim: true },
    gender: {
      type: String,
      enum: ['male', 'female', 'other', 'unspecified'],
      default: 'unspecified',
    },
    relationship_tag: {
      type: String,
      enum: ['parent', 'child', 'spouse', 'sibling', 'other'],
      default: 'other',
    },
    critical_allergies_medical_history: {
      type: String,
      default: '',
      trim: true,
      maxlength: 2000,
    },
  },
  { timestamps: { createdAt: 'created_at', updatedAt: 'updated_at' } }
);

DependentSchema.set('toJSON', {
  virtuals: true,
  versionKey: false,
  transform: (_doc, ret) => {
    ret.id = ret._id.toString();
    delete ret._id;
    return ret;
  },
});

module.exports = mongoose.model('Dependent', DependentSchema);
