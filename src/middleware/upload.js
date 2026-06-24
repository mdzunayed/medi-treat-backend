const fs = require('fs');
const path = require('path');
const multer = require('multer');

const UPLOAD_DIR = process.env.UPLOAD_DIR || path.join(__dirname, '..', '..', 'uploads');

if (!fs.existsSync(UPLOAD_DIR)) {
  fs.mkdirSync(UPLOAD_DIR, { recursive: true });
}

const storage = multer.memoryStorage();

const upload = multer({
  storage,
  limits: { fileSize: 8 * 1024 * 1024 }, // 8 MB
  fileFilter: (_req, file, cb) => {
    if (!/^image\/(jpeg|jpg|png|webp)$/i.test(file.mimetype)) {
      return cb(new Error('Only JPEG / PNG / WEBP images are allowed'));
    }
    cb(null, true);
  },
});

function writeImageToDisk(buffer, serviceId) {
  const filename = `${serviceId}.jpg`;
  const fullPath = path.join(UPLOAD_DIR, filename);
  fs.writeFileSync(fullPath, buffer);
  return filename;
}

function deleteImageFromDisk(serviceId) {
  const fullPath = path.join(UPLOAD_DIR, `${serviceId}.jpg`);
  if (fs.existsSync(fullPath)) {
    fs.unlinkSync(fullPath);
  }
}

const cloudinary = require('./cloudinary');

// Unified image writer. Returns the value to store in the document's
// image field:
//   • Cloudinary on  → a full https URL (survives Render restarts).
//   • Cloudinary off → a bare filename, served via the /uploads static
//     mount + PUBLIC_BASE_URL (existing local-dev behaviour).
// Callers store whatever comes back as-is; the services `decorate()`
// helper only prepends PUBLIC_BASE_URL when the value isn't already a
// full URL, so both shapes round-trip correctly.
async function storeImage(buffer, publicId) {
  if (cloudinary.isEnabled()) {
    return cloudinary.uploadBuffer(buffer, publicId);
  }
  return writeImageToDisk(buffer, publicId);
}

// Mirror of storeImage for removal — clears whichever backend holds it.
async function removeImage(publicId) {
  await cloudinary.destroy(publicId);
  deleteImageFromDisk(publicId);
}

module.exports = {
  upload,
  writeImageToDisk,
  deleteImageFromDisk,
  storeImage,
  removeImage,
  UPLOAD_DIR,
};
