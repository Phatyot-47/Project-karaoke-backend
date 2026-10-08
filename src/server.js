// จุดเริ่มรัน backend — เปิด server ตาม PORT ใน .env และตั้งเวลาเคลียร์การจองที่ค้างชำระทุก 1 นาที
require('dotenv').config();
const app = require('./app');
const { expireStalePendingBookings } = require('./utils/expireBookings');

const PORT = process.env.PORT || 4000;

app.listen(PORT, () => {
  console.log(`Gens Karaoke API running on http://localhost:${PORT}`);
});

// สวีปคาบเวลา เผื่อไม่มีใครเรียก endpoint ที่ trigger การเช็คหมดเวลาไว้พักใหญ่
// (ตัวหลักที่ทำให้ระบบถูกต้องจริงคือการเรียกใน route ตอนอ่าน/เขียนข้อมูลห้อง-เวลาว่าง)
setInterval(() => {
  expireStalePendingBookings().catch((err) => console.error('expireStalePendingBookings error:', err.message));
}, 60 * 1000);
