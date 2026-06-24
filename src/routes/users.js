const express = require('express');
const mongoose = require('mongoose');
const Account = require('../models/Account');
const Provider = require('../models/Provider');
const { upload, storeImage, removeImage } = require('../middleware/upload');

const router = express.Router();

// POST /api/users/:id/upload-avatar  multipart/form-data
//   field: `avatar` — the image file (jpg/png/webp, ≤ 8 MB)
//
// Writes the bytes to UPLOAD_DIR as `<id>_avatar.jpg`, exposes it
// publicly via the existing `/uploads` static mount, and writes the
// URL into both Account.profile_picture AND Provider.profile_picture
// (whichever row matches the id). The Flutter session id might be
// either collection's _id depending on how the doctor signed in, so
// the parallel update is the safest contract.
//
// `upload.single('avatar')` runs first — it parses the multipart body
// and lands the buffer on `req.file.buffer`. The Multer fileFilter in
// middleware/upload.js already rejects non-images with a clear error
// before we ever reach this handler.
router.post('/:id/upload-avatar', upload.single('avatar'), async (req, res) => {
  try {
    const { id } = req.params;
    if (!mongoose.isValidObjectId(id)) {
      return res.status(400).json({
        success: false,
        message: 'Invalid user id',
      });
    }
    if (!req.file || !req.file.buffer) {
      return res.status(400).json({
        success: false,
        message: 'No image uploaded. Use form field "avatar".',
      });
    }

    // Public id derived from the account id so a re-upload overwrites the
    // old image (no orphan growth). `storeImage` returns a Cloudinary
    // https URL in prod, or a bare `<id>_avatar.jpg` filename in local
    // dev. We append a cache-bust query string so the Flutter image cache
    // fetches the fresh bytes on the very next paint.
    const stored = await storeImage(req.file.buffer, `${id}_avatar`);

    // Disk fallback returns a bare filename → expose it via the /uploads
    // mount + PUBLIC_BASE_URL. Cloudinary returns a full https URL → use
    // it verbatim. Either way the stored value never bakes `localhost`
    // into the DB when PUBLIC_BASE_URL is set.
    const isFullUrl = /^https?:\/\//i.test(stored);
    const baseUrl =
      process.env.PUBLIC_BASE_URL || `http://localhost:${process.env.PORT || 4000}`;
    const publicUrl = isFullUrl
      ? `${stored}?v=${Date.now()}`
      : `${baseUrl}/uploads/${stored}?v=${Date.now()}`;

    // Parallel update — whichever collection has the matching _id gets
    // the write. updateOne with non-matching _id is a no-op (matchedCount
    // 0) so this is safe even when the id only exists in one place.
    const [acctRes, provRes] = await Promise.all([
      Account.updateOne({ _id: id }, { $set: { profile_picture: publicUrl } }),
      Provider.updateOne({ _id: id }, { $set: { profile_picture: publicUrl } })
        .catch(() => ({ matchedCount: 0 })),
    ]);

    const matched =
      (acctRes.matchedCount || 0) + (provRes.matchedCount || 0);
    if (matched === 0) {
      // Image was saved but no DB row owns this id — clean up the
      // orphan (Cloudinary or disk) so we don't leak storage.
      await removeImage(`${id}_avatar`);
      return res.status(404).json({
        success: false,
        message: 'User not found for that id',
      });
    }

    return res.json({
      success: true,
      message: 'Avatar uploaded',
      profile_picture: publicUrl,
      updated_collections: {
        accounts: (acctRes.matchedCount || 0) > 0,
        providers: (provRes.matchedCount || 0) > 0,
      },
    });
  } catch (err) {
    console.error('[upload-avatar]', err);
    res.status(500).json({ success: false, message: err.message });
  }
});

// PUT /api/users/:id/profile
//
// One-stop profile update. Accepts identity fields (full_name, phone,
// address, email) AND professional fields (specialty, specialization,
// years_experience, fee, bio, hospital_affiliation, service_radius_km,
// is_verified_doctor). Writes identity to Account and professional to
// Provider — whichever row matches the id gets the corresponding fields.
//
// Wire format: accepts both camelCase (per the production spec) and
// snake_case (per the codebase convention) for every key. Responses
// stay snake_case so they line up with every other endpoint's shape.

// Map of camelCase wire keys → snake_case schema keys. Used by
// `coerceKeys()` to normalise the incoming body in one pass.
const FIELD_ALIASES = Object.freeze({
  fullName: 'full_name',
  hospitalAffiliation: 'hospital_affiliation',
  experienceYears: 'years_experience',
  yearsExperience: 'years_experience',
  consultationFee: 'fee',
  serviceRadiusKm: 'service_radius_km',
  photoUrl: 'profile_picture',
  profilePicture: 'profile_picture',
  isVerifiedDoctor: 'is_verified_doctor',
  bmdcLicense: 'bmdc_license',
});

// Whitelists. Identity fields write to Account; professional fields
// write to Provider. Email is intentionally NOT identity-writable
// here — that's a separate flow (auth/profile changes) with extra
// validation rules.
const ACCOUNT_EDITABLE = new Set([
  'full_name',
  'phone',
  'address',
  'profile_picture',
]);
const PROVIDER_EDITABLE = new Set([
  'full_name',
  'specialty',
  'specialization',
  'years_experience',
  'fee',
  'service_radius_km',
  'bio',
  'hospital_affiliation',
  'is_verified_doctor',
  'profile_picture',
  // BMDC license can also be saved through the generic PUT endpoint
  // (in addition to the dedicated paths) so the Edit Profile sheet can
  // update it alongside other fields in one round trip. `experience`
  // and `payout_details` are intentionally NOT here — those have
  // their own validated endpoints (`/doctor/work-experience` etc.).
  'bmdc_license',
]);

function coerceKeys(raw) {
  const out = {};
  for (const [k, v] of Object.entries(raw || {})) {
    if (v === undefined || v === null) continue;
    const key = FIELD_ALIASES[k] || k;
    out[key] = typeof v === 'string' ? v.trim() : v;
  }
  return out;
}

function pick(fields, allow) {
  const out = {};
  for (const k of Object.keys(fields)) {
    if (allow.has(k)) out[k] = fields[k];
  }
  return out;
}

router.put('/:id/profile', async (req, res) => {
  try {
    const { id } = req.params;
    if (!mongoose.isValidObjectId(id)) {
      return res.status(400).json({
        success: false,
        message: 'Invalid user id',
      });
    }
    const fields = coerceKeys(req.body || {});
    if (Object.keys(fields).length === 0) {
      return res.status(400).json({
        success: false,
        message: 'No editable fields supplied',
      });
    }

    const accountUpdate = pick(fields, ACCOUNT_EDITABLE);
    const providerUpdate = pick(fields, PROVIDER_EDITABLE);

    // Parallel update — same trick we use for /doctor/location and
    // /api/users/:id/upload-avatar. updateOne on a non-matching _id
    // is a clean no-op (matchedCount=0).
    const [account, provider] = await Promise.all([
      Object.keys(accountUpdate).length
        ? Account.findByIdAndUpdate(id, { $set: accountUpdate }, { new: true })
        : Account.findById(id),
      Object.keys(providerUpdate).length
        ? Provider.findByIdAndUpdate(id, { $set: providerUpdate }, { new: true })
        : Provider.findById(id),
    ]);

    if (!account && !provider) {
      return res.status(404).json({
        success: false,
        message: 'No account or provider matched that id',
      });
    }

    res.json({
      success: true,
      user: account ? account.toJSON() : null,
      provider: provider ? provider.toJSON() : null,
    });
  } catch (err) {
    console.error('[user-profile]', err);
    res.status(500).json({ success: false, message: err.message });
  }
});

module.exports = router;
