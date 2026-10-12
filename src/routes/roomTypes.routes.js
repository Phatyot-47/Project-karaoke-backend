// API ประเภทห้องแบบสาธารณะ (/api/room-types) — ใช้ทำแท็บกรองประเภทในหน้าเลือกห้องของลูกค้า
// (การเพิ่ม/แก้ไขประเภทอยู่ที่ /api/admin/room-types)
const router = require('express').Router();
const { pool } = require('../db');
const { route } = require('../utils/http');

// GET /api/room-types -- ทุกประเภท + จำนวนห้องที่เปิดให้บริการ + ราคาเริ่มต้นจริงของห้องในประเภทนั้น
router.get(
  '/',
  route(async (req, res) => {
    const types = await pool.query(
      `SELECT t.*,
              COUNT(r.room_id)::int AS room_count,
              COUNT(r.room_id) FILTER (WHERE r.theme IS NOT NULL)::int AS theme_room_count,
              MIN(r.price_per_hour) AS min_price_per_hour
       FROM room_type t
       LEFT JOIN room r ON r.type_id = t.type_id AND r.is_active = true
       GROUP BY t.type_id
       ORDER BY t.capacity_min, t.code`,
    );
    res.json(types.rows);
  }),
);

module.exports = router;
