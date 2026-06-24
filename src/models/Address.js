const mongoose = require('mongoose');

// `addresses` collection — a patient's reusable saved-address ledger. Linked
// to the owning account by `account_id` (a String, matching the snake_case
// id convention used across the app, e.g. CareRequest.patient_account_id).
// At most one row per account carries `is_default: true`; the routes enforce
// this on create / set-default. `toJSON` flattens `_id` -> `id` like the rest
// of the models.
const AddressSchema = new mongoose.Schema(
  {
    account_id: { type: String, required: true, index: true },
    label: { type: String, default: 'Home', trim: true, maxlength: 60 },
    full_address_text: { type: String, default: '', trim: true },
    flat_floor_holding: { type: String, default: '', trim: true },
    landmark_instructions: { type: String, default: '', trim: true, maxlength: 500 },
    latitude: { type: Number, default: null },
    longitude: { type: Number, default: null },
    is_default: { type: Boolean, default: false },
  },
  { timestamps: { createdAt: 'created_at', updatedAt: 'updated_at' } }
);

AddressSchema.set('toJSON', {
  virtuals: true,
  versionKey: false,
  transform: (_doc, ret) => {
    ret.id = ret._id.toString();
    delete ret._id;
    return ret;
  },
});

module.exports = mongoose.model('Address', AddressSchema);
