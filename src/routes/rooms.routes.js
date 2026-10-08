// API ข้อมูลห้อง (/api/rooms/...) — รายการห้อง, ค้นหาห้องว่างตามเวลา, ช่วงเวลาที่ถูกจองแล้ว
// (ไม่ต้องล็อกอินก็ดูได้)
const router = require('express').Router();
const { pool } = require('../db');
const { HttpError, route } = require('../utils/http');
const { NAIVE_DATETIME_RE } = require('../utils/time');
const { expireStalePendingBookings } = require('../utils/expireBookings');
const { ROOM_TYPE_COLUMNS, joinRoomType } = require('../utils/roomType');

// GET /api/rooms?size=S&start=YYYY-MM-DDTHH:MM:SS&end=...  -- หน้า "เลือกห้องคาราโอเกะ"
// size = รหัสประเภทห้อง (room_type.code) ไม่ส่ง/all = ทุกประเภท
// ถ้าส่ง start/end มาด้วย จะมีฟิลด์ is_available บอกว่าห้องว่างตลอดช่วงเวลานั้นหรือไม่ (ค้นหาห้องว่างตามเวลา/ระยะเวลา)
router.get(
  '/',
  route(async (req, res) => {
    const { size, start, end } = req.query;
    const hasRange = start !== undefined || end !== undefined;
    if (hasRange && !(NAIVE_DATETIME_RE.test(start) && NAIVE_DATETIME_RE.test(end) && start < end)) {
      throw new HttpError(400, 'ช่วงเวลาที่ค้นหาไม่ถูกต้อง');
    }
    const params = [];
    let availabilitySql = '';
    if (hasRange) {
      await expireStalePendingBookings();
      params.push(start, end);
      availabilitySql = `, NOT EXISTS (
        SELECT 1 FROM booking b
        WHERE b.room_id = r.room_id AND b.booking_status IN ('pending','confirmed')
          AND b.start_datetime < $2 AND b.end_datetime > $1
      ) AS is_available`;
    }
    let sql = `SELECT r.room_id, r.room_name, r.type_id, r.capacity, r.price_per_hour, r.image_url, r.is_active,
                      r.description, r.theme, ${ROOM_TYPE_COLUMNS}${availabilitySql}
               FROM room r ${joinRoomType('r')}
               WHERE r.is_active = true`;
    if (size && size !== 'all') {
      params.push(String(size).toUpperCase());
      sql += ` AND t.code = $${params.length}`;
    }
    // เรียงตามประเภท (เล็ก → ใหญ่) แล้วตามราคา
    res.json((await pool.query(`${sql} ORDER BY t.capacity_min, t.code, r.price_per_hour, r.room_name`, params)).rows);
  }),
);

// GET /api/rooms/:id  -- รายละเอียดห้องเดียว (หน้าจองห้อง)
router.get(
  '/:id',
  route(async (req, res) => {
    const room = (
      await pool.query(`SELECT r.*, ${ROOM_TYPE_COLUMNS} FROM room r ${joinRoomType('r')} WHERE r.room_id = $1`, [
        req.params.id,
      ])
    ).rows[0];
    if (!room) throw new HttpError(404, 'ไม่พบห้อง');
    res.json(room);
  }),
);

// GET /api/rooms/:id/availability?date=YYYY-MM-DD -- ช่วงเวลาที่ถูกจองแล้ว (หน้าเลือกเวลา)
router.get(
  '/:id/availability',
  route(async (req, res) => {
    const { date } = req.query;
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date || '')) throw new HttpError(400, 'ต้องระบุ date (YYYY-MM-DD)');
    await expireStalePendingBookings();
    const result = await pool.query(
      `SELECT booking_id, start_datetime, end_datetime, booking_status
     FROM booking
     WHERE room_id = $1 AND booking_date = $2 AND booking_status IN ('pending','confirmed')
     ORDER BY start_datetime`,
      [req.params.id, date],
    );
    res.json(result.rows);
  }),
);

module.exports = router;
