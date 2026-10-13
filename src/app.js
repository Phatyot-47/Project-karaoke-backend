// ตั้งค่าตัวเว็บเซิร์ฟเวอร์ (Express) — รวมทุกเส้นทาง API (/api/...) ไว้ที่นี่
// ลำดับการทำงานเมื่อมีคำขอเข้ามา: อ่านข้อมูล JSON → ส่งไปไฟล์ route ที่ตรงกับ URL → ถ้ามี error ส่งไปตัวจัดการ error ด้านล่างสุด
// (แยกจาก server.js เพื่อให้ไฟล์ทดสอบเรียกใช้ app ได้โดยไม่ต้องเปิดพอร์ตจริง)
const path = require('path');
const express = require('express');
const cors = require('cors');
const { HttpError } = require('./utils/http');

const authRoutes = require('./routes/auth.routes');
const roomsRoutes = require('./routes/rooms.routes');
const bookingsRoutes = require('./routes/bookings.routes');
const paymentsRoutes = require('./routes/payments.routes');
const adminRoutes = require('./routes/admin.routes');
const uploadsRoutes = require('./routes/uploads.routes');
const usersRoutes = require('./routes/users.routes');
const shopRoutes = require('./routes/shop.routes');
const roomTypesRoutes = require('./routes/roomTypes.routes');
const notificationsRoutes = require('./routes/notifications.routes');

const app = express();
app.use(cors()); // อนุญาตให้หน้าเว็บ (คนละพอร์ต เช่น 5173) เรียก API นี้ได้
app.use(express.json()); // แปลงข้อมูล JSON ที่ส่งมาให้อ่านได้จาก req.body

app.get('/api/health', (req, res) => res.json({ ok: true }));

// รูปที่อัปโหลด (สลิป, รูปห้อง, รูปโปรไฟล์) เปิดดูได้ที่ /uploads/<ชื่อไฟล์>
// ใส่ header กันความปลอดภัย: ให้เบราว์เซอร์ถือว่าเป็น "รูป" เท่านั้น ห้ามรันเป็นหน้าเว็บหรือสคริปต์
app.use(
  '/uploads',
  express.static(path.join(__dirname, '..', 'uploads'), {
    setHeaders: (res) => {
      res.set('X-Content-Type-Options', 'nosniff');
      res.set('Content-Security-Policy', "default-src 'none'; img-src 'self'; style-src 'unsafe-inline'; sandbox");
    },
  }),
);

// จับคู่ URL กับไฟล์ route: เช่น /api/bookings/... ไปที่ routes/bookings.routes.js
app.use('/api/auth', authRoutes);
app.use('/api/rooms', roomsRoutes);
app.use('/api/bookings', bookingsRoutes);
app.use('/api/payments', paymentsRoutes);
app.use('/api/admin', adminRoutes);
app.use('/api/uploads', uploadsRoutes);
app.use('/api/users', usersRoutes);
app.use('/api/shop', shopRoutes);
app.use('/api/room-types', roomTypesRoutes);
app.use('/api/notifications', notificationsRoutes);

// URL ที่ไม่มีในระบบ → ตอบ 404
app.use((req, res) => {
  res.status(404).json({ error: 'ไม่พบ endpoint นี้' });
});

// รหัส error ของฐานข้อมูลที่แปลว่า "ข้อมูลที่ส่งมาผิดรูปแบบ" (ความผิดของผู้ส่ง ไม่ใช่ระบบพัง) → ตอบ 400
// 22P02 = ชนิดข้อมูลผิด เช่น /api/rooms/abc, 22007/22008 = วันที่-เวลาผิด,
// 22003 = ตัวเลขใหญ่เกิน, 23514 = ผิดเงื่อนไขที่ตั้งไว้ในตาราง (CHECK)
// (22001 = ข้อความยาวเกินขนาดช่องในตาราง แยกตอบข้อความเฉพาะไว้ด้านล่าง)
const PG_BAD_INPUT_CODES = ['22P02', '22007', '22008', '22003', '23514'];

// ตัวจัดการ error กลาง — ทุก error ในระบบมาจบที่นี่
// HttpError (error ที่เราโยนเองพร้อมข้อความ) ตอบตามนั้น / JSON พัง ตอบ 400 / นอกนั้นพิมพ์ลง log แล้วตอบ 500
// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  if (err instanceof HttpError)
    return res.status(err.status).json({ error: err.message, ...(err.code && { code: err.code }) });
  if (err.type === 'entity.parse.failed')
    return res.status(400).json({ error: 'ข้อมูลที่ส่งมาไม่ใช่ JSON ที่ถูกต้อง' });
  if (err.code === '22001') return res.status(400).json({ error: 'ข้อความบางช่องยาวเกินกำหนด กรุณาตรวจสอบอีกครั้ง' });
  if (PG_BAD_INPUT_CODES.includes(err.code))
    return res.status(400).json({ error: 'ข้อมูลที่ส่งมาไม่ถูกต้อง กรุณาตรวจสอบอีกครั้ง' });
  console.error(err);
  res.status(500).json({ error: 'เกิดข้อผิดพลาดในระบบ กรุณาลองใหม่อีกครั้ง' });
});

module.exports = app;
