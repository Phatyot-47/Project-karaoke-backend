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

const app = express();
app.use(cors());
app.use(express.json());

app.get('/api/health', (req, res) => res.json({ ok: true }));

// ไฟล์ที่อัปโหลด (สลิปโอนเงิน, รูปห้อง) — serve เป็น static ตรงๆ จาก /uploads/<filename>
// nosniff + CSP กันไม่ให้ไฟล์ถูกตีความเป็นหน้าเว็บ/สคริปต์ (แม้จะหลุดมาเป็นไฟล์ที่ไม่ใช่รูป)
app.use(
  '/uploads',
  express.static(path.join(__dirname, '..', 'uploads'), {
    setHeaders: (res) => {
      res.set('X-Content-Type-Options', 'nosniff');
      res.set('Content-Security-Policy', "default-src 'none'; img-src 'self'; style-src 'unsafe-inline'; sandbox");
    },
  }),
);

app.use('/api/auth', authRoutes);
app.use('/api/rooms', roomsRoutes);
app.use('/api/bookings', bookingsRoutes);
app.use('/api/payments', paymentsRoutes);
app.use('/api/admin', adminRoutes);
app.use('/api/uploads', uploadsRoutes);
app.use('/api/users', usersRoutes);
app.use('/api/shop', shopRoutes);

app.use((req, res) => {
  res.status(404).json({ error: 'ไม่พบ endpoint นี้' });
});

// error code ของ PostgreSQL ที่เกิดจาก "ข้อมูลที่ส่งมาผิดรูปแบบ" ไม่ใช่ระบบพัง → ควรตอบ 400 ไม่ใช่ 500
// 22P02 = แปลงชนิดข้อมูลไม่ได้ (เช่น /api/rooms/abc), 22007/22008 = วันที่-เวลาผิดรูปแบบ/เกินช่วง,
// 22003 = ตัวเลขเกินขนาดคอลัมน์, 23514 = ผิด CHECK constraint (เช่น size ห้องไม่ใช่ S/M/L/XL)
const PG_BAD_INPUT_CODES = ['22P02', '22007', '22008', '22003', '23514'];

// error handler กลาง: HttpError ตอบตาม status ของมัน / JSON body ผิดรูปแบบตอบ 400 / อื่นๆ log แล้วตอบ 500
// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  if (err instanceof HttpError)
    return res.status(err.status).json({ error: err.message, ...(err.code && { code: err.code }) });
  if (err.type === 'entity.parse.failed')
    return res.status(400).json({ error: 'ข้อมูลที่ส่งมาไม่ใช่ JSON ที่ถูกต้อง' });
  if (PG_BAD_INPUT_CODES.includes(err.code))
    return res.status(400).json({ error: 'ข้อมูลที่ส่งมาไม่ถูกต้อง กรุณาตรวจสอบอีกครั้ง' });
  console.error(err);
  res.status(500).json({ error: 'เกิดข้อผิดพลาดในระบบ กรุณาลองใหม่อีกครั้ง' });
});

module.exports = app;
