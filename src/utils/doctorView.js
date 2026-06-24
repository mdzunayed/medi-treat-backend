// Builds the populated `doctor` block that the patient endpoints attach to
// a CareRequest when it has an assigned doctor. `assigned_doctor_id` is a
// free-form String (legacy schema — not an ObjectId ref), so we can't use
// Mongoose `.populate()`; this helper performs the manual join and walks
// both `providers` (the canonical doctor profile) and `accounts` (the
// signed-in identity) so the patient sees a complete profile regardless of
// which id the admin happened to assign.

const mongoose = require('mongoose');
const Provider = require('../models/Provider');
const Account = require('../models/Account');

function firstNonEmpty(...values) {
  for (const v of values) {
    if (v !== undefined && v !== null && String(v).trim() !== '') return v;
  }
  return '';
}

// Resolve a provider by id that may point at either the Provider doc or
// the signed-in Account. Mirrors the `resolveDoctor` helper in
// routes/doctor.js but is exposed for cross-route reuse AND is
// role-agnostic — the `role` arg defaults to 'doctor' for backward
// compatibility but accepts 'nurse' / 'helper' so the assign /
// populate paths can resolve any provider type uniformly.
async function loadProviderPair(providerId, role = 'doctor') {
  if (!providerId || !mongoose.isValidObjectId(providerId)) {
    return { provider: null, account: null };
  }
  let provider = await Provider.findById(providerId);
  let account = null;
  if (provider) {
    if (provider.email) {
      account = await Account.findOne({ email: provider.email });
    }
    if (!account && provider.full_name) {
      account = await Account.findOne({ full_name: provider.full_name, role });
    }
  } else {
    account = await Account.findById(providerId);
    if (account) {
      if (account.email) {
        provider = await Provider.findOne({ email: account.email, role });
      }
      if (!provider && account.full_name) {
        provider = await Provider.findOne({ full_name: account.full_name, role });
      }
    }
  }
  return { provider, account };
}

// Backward-compatible alias — every existing caller (admin assign,
// doctor profile, etc.) wants the doctor-role variant.
async function loadDoctorPair(doctorId) {
  return loadProviderPair(doctorId, 'doctor');
}

// Public read-only shape returned to patients. Snake_case on the wire to
// match the rest of the API. Phone is included so the Flutter app can do
// `tel:` deep-links. Works for both doctor and nurse roles — the caller
// decides which `assigned_*_id` to feed in, and the licence field naming
// adapts to the provider's `role`.
function buildDoctorView({ provider, account }) {
  if (!provider && !account) return null;
  const p = provider || {};
  const a = account || {};
  const role = firstNonEmpty(p.role, a.role) || 'doctor';
  const isNurse = role === 'nurse';
  return {
    id: (provider?._id || account?._id || '').toString(),
    role,
    full_name: firstNonEmpty(p.full_name, a.full_name),
    profile_picture: firstNonEmpty(
      p.profile_picture,
      a.profile_picture,
      a.photo_url,
    ),
    specialty: firstNonEmpty(p.specialty, p.specialization),
    specialization: firstNonEmpty(p.specialization, p.specialty),
    years_experience: Number(p.years_experience) || 0,
    rating: Number(p.rating) || 0,
    review_count: Number(p.review_count) || 0,
    phone: firstNonEmpty(p.phone, a.phone),
    email: firstNonEmpty(p.email, a.email),
    bmdc_license: firstNonEmpty(p.bmdc_license),
    nursing_license: firstNonEmpty(p.nursing_license),
    license:
      firstNonEmpty(
        isNurse ? p.nursing_license : p.bmdc_license,
        p.bmdc_license,
        p.nursing_license,
      ) || '',
    hospital_affiliation: firstNonEmpty(p.hospital_affiliation),
    bio: firstNonEmpty(p.bio),
    is_verified_doctor:
      p.is_verified_doctor === true ||
      (role === 'doctor' && p.verification_status === 'verified'),
    is_verified_nurse:
      p.is_verified_nurse === true ||
      (role === 'nurse' && p.verification_status === 'verified'),
    verification_status: firstNonEmpty(p.verification_status) || 'pending',
    fee: Number(p.fee) || 0,
    service_radius_km: Number(p.service_radius_km) || 0,
    experience: Array.isArray(p.experience)
      ? p.experience.map((e) => ({
          hospital_name: firstNonEmpty(e.hospital_name),
          designation: firstNonEmpty(e.designation),
          years: Number(e.years) || 0,
          started_at: e.started_at || null,
          ended_at: e.ended_at || null,
        }))
      : [],
  };
}

// Attach populated doctor + nurse blocks onto a serialized CareRequest.
// Returns the same JSON object, plus `doctor` and `nurse` fields (each
// may be `null` when no assignment exists yet). Swallows lookup
// failures so a busted provider row never breaks the patient's
// tracking screen — the response simply omits the extra block in that
// case. The two lookups run in parallel since they're independent.
async function attachDoctorToRequest(requestJson) {
  if (!requestJson) return requestJson;
  const doctorId = requestJson.assigned_doctor_id;
  const nurseId = requestJson.assigned_nurse_id;

  const [doctorPair, nursePair] = await Promise.all([
    doctorId
      ? loadProviderPair(doctorId, 'doctor').catch(() => null)
      : Promise.resolve(null),
    nurseId
      ? loadProviderPair(nurseId, 'nurse').catch(() => null)
      : Promise.resolve(null),
  ]);

  requestJson.doctor = doctorPair ? buildDoctorView(doctorPair) : null;
  requestJson.nurse = nursePair ? buildDoctorView(nursePair) : null;
  return requestJson;
}

module.exports = {
  loadDoctorPair,
  loadProviderPair,
  buildDoctorView,
  attachDoctorToRequest,
};
