const router = require('express').Router();
const { pool } = require('../db');
const { HttpError, route } = require('../utils/http');
const { getShop, getCurrentPolicy } = require('../utils/shop');

// GET /api/shop -- ข้อมูลร้านแบบสาธารณะ (ชื่อร้าน, บัญชีรับโอน, เวลาเปิด-ปิด, นโยบายมัดจำ/ยกเลิก)
// ใช้ทั้งหน้าลูกค้า (ชำระมัดจำ, จองห้อง) และหน้าตั้งค่าร้านฝั่งแอดมิน — การแก้ไขยังต้องผ่าน /api/admin เท่านั้น
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
