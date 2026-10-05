const router = require('express').Router();
const pool = require('../db');
const { expireStalePendingBookings } = require('../utils/expireBookings');

const NAIVE_DATETIME_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2})?$/;

// GET /api/rooms?size=S&start=YYYY-MM-DDTHH:MM:SS&end=...  -- หน้า "เลือกห้องคาราโอเกะ"
// ถ้าส่ง start/end มาด้วย จะมีฟิลด์ is_available บอกว่าห้องว่างตลอดช่วงเวลานั้นหรือไม่ (ค้นหาห้องว่างตามเวลา/ระยะเวลา)
router.get('/', async (req, res, next) => {
  const { size, start, end } = req.query;
  const hasRange = start !== undefined || end !== undefined;
  if (hasRange && !(NAIVE_DATETIME_RE.test(start) && NAIVE_DATETIME_RE.test(end) && start < end)) {
    return res.status(400).json({ error: 'ช่วงเวลาที่ค้นหาไม่ถูกต้อง' });
  }
  try {
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
    sql += ' ORDER BY price_per_hour';
    const result = await pool.query(sql, params);
    res.json(result.rows);
  } catch (err) {
    next(err);
  }
});

// GET /api/rooms/:id  -- รายละเอียดห้องเดียว (หน้าจองห้อง)
router.get('/:id', async (req, res, next) => {
  try {
    const result = await pool.query('SELECT * FROM room WHERE room_id = $1', [req.params.id]);
    if (!result.rows.length) return res.status(404).json({ error: 'ไม่พบห้อง' });
    res.json(result.rows[0]);
  } catch (err) {
    next(err);
  }
});

// GET /api/rooms/:id/availability?date=YYYY-MM-DD -- ช่วงเวลาที่ถูกจองแล้ว (หน้าเลือกเวลา)
router.get('/:id/availability', async (req, res, next) => {
  const { date } = req.query;
  if (!date) return res.status(400).json({ error: 'ต้องระบุ date (YYYY-MM-DD)' });
  try {
    await expireStalePendingBookings();
    const result = await pool.query(
      `SELECT start_datetime, end_datetime, booking_status
       FROM booking
       WHERE room_id = $1 AND booking_date = $2 AND booking_status IN ('pending','confirmed')
       ORDER BY start_datetime`,
      [req.params.id, date]
    );
    res.json(result.rows);
  } catch (err) {
    next(err);
  }
});

module.exports = router;
