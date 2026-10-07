const router = require('express').Router();
const { pool } = require('../db');
const { HttpError, route } = require('../utils/http');
const { NAIVE_DATETIME_RE } = require('../utils/time');
const { expireStalePendingBookings } = require('../utils/expireBookings');

// GET /api/rooms?size=S&start=YYYY-MM-DDTHH:MM:SS&end=...  -- หน้า "เลือกห้องคาราโอเกะ"
// ถ้าส่ง start/end มาด้วย จะมีฟิลด์ is_available บอกว่าห้องว่างตลอดช่วงเวลานั้นหรือไม่ (ค้นหาห้องว่างตามเวลา/ระยะเวลา)
router.get('/', route(async (req, res) => {
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
        WHERE b.room_id = room.room_id AND b.booking_status IN ('pending','confirmed')
          AND b.start_datetime < $2 AND b.end_datetime > $1
      ) AS is_available`;
  }
  let sql = `SELECT room_id, room_name, size, capacity, price_per_hour, image_url, is_active, description, theme${availabilitySql}
             FROM room WHERE is_active = true`;
  if (size && size !== 'all') {
    params.push(String(size).toUpperCase());
    sql += ` AND size = $${params.length}`;
  }
  res.json((await pool.query(`${sql} ORDER BY price_per_hour`, params)).rows);
}));

// GET /api/rooms/:id  -- รายละเอียดห้องเดียว (หน้าจองห้อง)
router.get('/:id', route(async (req, res) => {
  const room = (await pool.query('SELECT * FROM room WHERE room_id = $1', [req.params.id])).rows[0];
  if (!room) throw new HttpError(404, 'ไม่พบห้อง');
  res.json(room);
}));

// GET /api/rooms/:id/availability?date=YYYY-MM-DD -- ช่วงเวลาที่ถูกจองแล้ว (หน้าเลือกเวลา)
router.get('/:id/availability', route(async (req, res) => {
  const { date } = req.query;
  if (!date) throw new HttpError(400, 'ต้องระบุ date (YYYY-MM-DD)');
  await expireStalePendingBookings();
  const result = await pool.query(
    `SELECT booking_id, start_datetime, end_datetime, booking_status
     FROM booking
     WHERE room_id = $1 AND booking_date = $2 AND booking_status IN ('pending','confirmed')
     ORDER BY start_datetime`,
    [req.params.id, date]
  );
  res.json(result.rows);
}));

module.exports = router;
