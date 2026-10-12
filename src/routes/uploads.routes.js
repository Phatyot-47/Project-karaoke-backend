// API อัปโหลดรูป (/api/uploads) — ใช้กับสลิปโอนเงิน, รูปห้อง, รูปโปรไฟล์, QR และแผนผังร้าน
const router = require('express').Router();
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const { requireLogin } = require('../utils/auth');

// ไฟล์ที่อัปโหลดเก็บไว้ในโฟลเดอร์ uploads/ ของ backend (ไม่ได้เก็บในฐานข้อมูล ฐานข้อมูลเก็บแค่ลิงก์)
// แล้วเปิดดูได้ที่ /uploads/<ชื่อไฟล์> (ตั้งไว้ใน app.js)
const uploadDir = path.join(__dirname, '..', '..', 'uploads');
fs.mkdirSync(uploadDir, { recursive: true });

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024, files: 1 }, // ไฟล์ละไม่เกิน 5MB ครั้งละ 1 ไฟล์
});

// ดูว่าเป็นรูปจริงไหม จาก "ไบต์แรกๆ ของไฟล์" (ไฟล์รูปแต่ละชนิดขึ้นต้นด้วยรหัสเฉพาะตัว)
// ไม่เชื่อนามสกุลไฟล์ เพราะใครก็เปลี่ยนชื่อไฟล์อันตรายเป็น .jpg ได้
// รับแค่ JPG / PNG / GIF / WEBP — ไม่รับ SVG เพราะซ่อนสคริปต์ไว้ข้างในได้
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

// POST /api/uploads  (ส่งแบบฟอร์มไฟล์ ชื่อช่อง "file") -- ต้องล็อกอิน (ลูกค้าหรือแอดมิน)
// ตั้งชื่อไฟล์ใหม่เป็น เวลา-ตัวสุ่ม.นามสกุล (กันชื่อซ้ำ และกันชื่อไฟล์แปลกๆ จากผู้ใช้)
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
    // ตอบเป็นลิงก์แบบ /uploads/... (ไม่ใส่ชื่อเครื่อง) หน้าเว็บจะเติมที่อยู่ backend ให้เอง ย้ายเครื่องรูปก็ยังขึ้น
    res.status(201).json({ url: `/uploads/${filename}` });
  });
});

module.exports = router;
