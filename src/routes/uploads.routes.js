const router = require('express').Router();
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const { requireLogin } = require('../utils/auth');

// เก็บไฟล์ที่อัปโหลด (สลิปโอนเงิน, รูปห้อง, รูปโปรไฟล์) ไว้ที่ gens-karaoke-backend/uploads
// แล้ว serve เป็น static path /uploads/<filename> (ดู app.js)
const uploadDir = path.join(__dirname, '..', '..', 'uploads');
fs.mkdirSync(uploadDir, { recursive: true });

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024, files: 1 }, // 5MB
});

// ตรวจชนิดไฟล์จากเนื้อไฟล์จริง (magic bytes) ไม่เชื่อนามสกุล/mimetype ที่ browser ส่งมา
// รับเฉพาะรูป JPEG / PNG / GIF / WEBP — ไม่รับ SVG เพราะฝังสคริปต์ได้
function detectImageExt(buf) {
  if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return '.jpg';
  if (buf.length >= 8 && buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])))
    return '.png';
  if (buf.length >= 6 && /^GIF8[79]a$/.test(buf.subarray(0, 6).toString('latin1'))) return '.gif';
  if (
    buf.length >= 12 &&
    buf.subarray(0, 4).toString('latin1') === 'RIFF' &&
    buf.subarray(8, 12).toString('latin1') === 'WEBP'
  )
    return '.webp';
  return null;
}

// POST /api/uploads  (multipart/form-data, field name "file") -- ต้องล็อกอิน (ลูกค้าหรือแอดมิน)
// -- ใช้ร่วมกันทั้งสลิปโอนเงิน (หน้าชำระเงิน), รูปโปรไฟล์ และรูปห้อง (หน้าตั้งค่าห้องฝั่งแอดมิน)
router.post('/', requireLogin, (req, res, next) => {
  upload.single('file')(req, res, async (err) => {
    if (err) {
      const message = err.code === 'LIMIT_FILE_SIZE' ? 'ไฟล์ต้องมีขนาดไม่เกิน 5MB' : 'อัปโหลดไฟล์ไม่สำเร็จ';
      return res.status(400).json({ error: message });
    }
    if (!req.file) return res.status(400).json({ error: 'ไม่พบไฟล์ที่อัปโหลด' });
    const ext = detectImageExt(req.file.buffer);
    if (!ext) return res.status(400).json({ error: 'รองรับเฉพาะไฟล์รูปภาพ JPG, PNG, GIF หรือ WEBP' });
    const filename = `${Date.now()}-${crypto.randomBytes(8).toString('hex')}${ext}`;
    try {
      await fs.promises.writeFile(path.join(uploadDir, filename), req.file.buffer);
    } catch (e) {
      return next(e);
    }
    res.status(201).json({ url: `${req.protocol}://${req.get('host')}/uploads/${filename}` });
  });
});

module.exports = router;
