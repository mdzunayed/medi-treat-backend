// Cloudinary image storage. Render's free filesystem is ephemeral — any
// file written to ./uploads is wiped on the next sleep/redeploy, which is
// why uploaded images "go black". Cloudinary keeps the bytes off-box so a
// stored https URL stays valid forever.
//
// Configuration (set on Render → Environment). Either form works:
//   CLOUDINARY_URL=cloudinary://<api_key>:<api_secret>@<cloud_name>
// or the three separate vars:
//   CLOUDINARY_CLOUD_NAME, CLOUDINARY_API_KEY, CLOUDINARY_API_SECRET
//
// When NONE are set (typical local dev), `isEnabled()` returns false and
// callers fall back to the existing disk writer — no behaviour change.

const { v2: cloudinary } = require('cloudinary');

const hasSeparateVars =
  !!process.env.CLOUDINARY_CLOUD_NAME &&
  !!process.env.CLOUDINARY_API_KEY &&
  !!process.env.CLOUDINARY_API_SECRET;

const enabled = !!process.env.CLOUDINARY_URL || hasSeparateVars;

if (enabled) {
  // The SDK auto-reads CLOUDINARY_URL; passing the explicit vars is a
  // no-op when only CLOUDINARY_URL is present, so this covers both forms.
  cloudinary.config({
    cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
    api_key: process.env.CLOUDINARY_API_KEY,
    api_secret: process.env.CLOUDINARY_API_SECRET,
    secure: true,
  });
}

function isEnabled() {
  return enabled;
}

// Uploads a raw image buffer and returns the permanent https URL.
// `publicId` is deterministic (derived from the owning doc id) so a
// re-upload overwrites the previous image instead of leaking copies.
function uploadBuffer(buffer, publicId) {
  return new Promise((resolve, reject) => {
    const stream = cloudinary.uploader.upload_stream(
      {
        public_id: publicId,
        folder: 'meditreat',
        overwrite: true,
        invalidate: true,
        resource_type: 'image',
      },
      (err, result) => {
        if (err) return reject(err);
        resolve(result.secure_url);
      },
    );
    stream.end(buffer);
  });
}

// Best-effort delete — never throws, so request handlers can fire-and-
// forget during a service/avatar removal without wrapping in try/catch.
async function destroy(publicId) {
  if (!enabled) return;
  try {
    await cloudinary.uploader.destroy(`meditreat/${publicId}`, {
      invalidate: true,
    });
  } catch (_) {
    /* swallow — orphan cleanup is best-effort */
  }
}

module.exports = { isEnabled, uploadBuffer, destroy };
