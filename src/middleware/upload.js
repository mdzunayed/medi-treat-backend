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

module.exports = { upload, writeImageToDisk, deleteImageFromDisk, UPLOAD_DIR };
