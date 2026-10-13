// API ข้อมูลร้านแบบสาธารณะ (/api/shop)
// (SQL ในไฟล์นี้: $1, JOIN, COALESCE, RETURNING ฯลฯ ดูคำอธิบายพื้นฐานที่ routes/bookings.routes.js)
const router = require('express').Router();
const { pool } = require('../db');
const { HttpError, route } = require('../utils/http');
const { getShop, getCurrentPolicy } = require('../utils/shop');

// GET /api/shop -- ข้อมูลร้าน (ชื่อร้าน, บัญชีรับโอน, QR, เวลาเปิด-ปิด, พีคไทม์, นโยบายมัดจำ/ยกเลิก)
// ใครก็อ่านได้ (หน้าจอง/หน้าชำระเงินต้องใช้) แต่การแก้ไขต้องเป็นแอดมินผ่าน /api/admin เท่านั้น
router.get(
  '/',
  route(async (req, res) => {
    const shop = await getShop();
    if (!shop) throw new HttpError(404, 'ยังไม่ได้ตั้งค่าร้าน');
    const hours = await pool.query('SELECT * FROM shop_hours ORDER BY day_of_week');
    res.json({ ...shop, hours: hours.rows, policy: await getCurrentPolicy() });
  }),
);

module.exports = router;
