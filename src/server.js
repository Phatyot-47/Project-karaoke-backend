// ไฟล์เริ่มต้นของ backend (คำสั่ง npm run dev / npm start จะรันไฟล์นี้)
// หน้าที่: เปิดเซิร์ฟเวอร์ตามเลข PORT ใน .env และตั้งให้ระบบเคลียร์การจองที่ไม่จ่ายมัดจำทุก 1 นาที
require('dotenv').config();
const app = require('./app');
const { expireStalePendingBookings } = require('./utils/expireBookings');

const PORT = process.env.PORT || 4000;

app.listen(PORT, () => {
  console.log(`Gens Karaoke API running on http://localhost:${PORT}`);
});

// ทุก 1 นาที: ยกเลิกการจองที่ลูกค้าไม่แนบสลิปภายในเวลาที่กำหนด
// (ปกติระบบก็เช็คอยู่แล้วทุกครั้งที่มีคนเปิดหน้าห้อง/หน้าจอง ตัวนี้เป็นตัวสำรอง เผื่อช่วงที่ไม่มีใครเข้าเว็บเลย)
setInterval(() => {
  expireStalePendingBookings().catch((err) => console.error('expireStalePendingBookings error:', err.message));
}, 60 * 1000);
