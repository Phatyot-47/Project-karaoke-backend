const router = require('express').Router();
const pool = require('../db');
const { calculateBookingPrice } = require('../utils/pricing');
const { expireStalePendingBookings } = require('../utils/expireBookings');
const { isStartInPast } = require('../utils/time');

const NOTE_MAX_LENGTH = 300;

// POST /api/bookings  { customerId, roomId, startDatetime, endDatetime, guestCount, note }
// -- ลูกค้ายืนยันช่วงเวลาจอง (ก่อนไปหน้าชำระมัดจำ)
router.post('/', async (req, res) => {
  const { customerId, roomId, startDatetime, endDatetime, guestCount } = req.body;
  if (!roomId || !startDatetime || !endDatetime) {
    return res.status(400).json({ error: 'ข้อมูลไม่ครบ (roomId, startDatetime, endDatetime)' });
  }
  const note = typeof req.body.note === 'string' ? req.body.note.trim() : '';
  if (note.length > NOTE_MAX_LENGTH) {
    return res.status(400).json({ error: `หมายเหตุต้องไม่เกิน ${NOTE_MAX_LENGTH} ตัวอักษร` });
  }
  // endpoint นี้ใช้เฉพาะ flow ลูกค้า login แล้วจอง (ไม่มี walkin_name ให้ fallback แบบฝั่งแอดมิน)
  // ต้องมี customerId เป็นเลขจำนวนเต็มบวกเสมอ ไม่งั้นจะไปชน CHECK/FK constraint ที่ DB แล้วหลุดเป็น 500
  if (!Number.isInteger(Number(customerId)) || Number(customerId) <= 0) {
    return res.status(400).json({ error: 'ต้องระบุ customerId ที่ถูกต้อง กรุณาเข้าสู่ระบบใหม่' });
  }
  if (isStartInPast(startDatetime)) {
    return res.status(400).json({ error: 'เวลาที่เลือกผ่านไปแล้ว กรุณาเลือกเวลาอื่น' });
  }
  try {
    await expireStalePendingBookings();
    const roomResult = await pool.query('SELECT * FROM room WHERE room_id = $1 AND is_active = true', [roomId]);
    if (!roomResult.rows.length) return res.status(404).json({ error: 'ไม่พบห้อง หรือห้องปิดให้บริการ' });
    const room = roomResult.rows[0];

    const shop = (await pool.query('SELECT * FROM shop ORDER BY shop_id LIMIT 1')).rows[0];
    if (!shop) return res.status(500).json({ error: 'ยังไม่ได้ตั้งค่าร้าน' });

    const policy = (await pool.query('SELECT * FROM shop_policy ORDER BY effective_from DESC LIMIT 1')).rows[0];
    if (!policy) return res.status(500).json({ error: 'ยังไม่ได้ตั้งค่านโยบายมัดจำ' });

    const { basePrice, peakSurchargeTotal, priceTotal } = calculateBookingPrice({
      pricePerHour: Number(room.price_per_hour),
      peakStartTime: shop.peak_start_time,
      peakSurcharge: Number(shop.peak_surcharge || 0),
      startDatetime,
      endDatetime,
    });
    const depositRequired = Math.round((priceTotal * Number(policy.deposit_percent)) / 100);
    const bookingDate = startDatetime.slice(0, 10);
    const bookingCode = 'BK-' + Date.now();

    const insertResult = await pool.query(
      `INSERT INTO booking (
         booking_code, customer_id, room_id, policy_id, booking_source,
         booking_date, start_datetime, end_datetime, guest_count, booking_status,
         base_price, peak_surcharge_total, price_total, deposit_required, deposit_status, note
       ) VALUES ($1,$2,$3,$4,'customer_online',$5,$6,$7,$8,'pending',$9,$10,$11,$12,'unpaid',$13)
       RETURNING *`,
      [bookingCode, Number(customerId), roomId, policy.policy_id, bookingDate, startDatetime, endDatetime,
        guestCount || null, basePrice, peakSurchargeTotal, priceTotal, depositRequired, note || null]
    );
    res.status(201).json(insertResult.rows[0]);
  } catch (err) {
    if (err.code === '23P01') {
      return res.status(409).json({ error: 'ช่วงเวลานี้ถูกจองไปแล้ว กรุณาเลือกเวลาอื่น' });
    }
    if (err.code === '23503') {
      return res.status(404).json({ error: 'ไม่พบบัญชีผู้ใช้นี้ กรุณาเข้าสู่ระบบใหม่' });
    }
    console.error('POST /api/bookings error:', err);
    res.status(500).json({ error: 'เกิดข้อผิดพลาดในระบบ กรุณาลองใหม่อีกครั้ง' });
  }
});

// GET /api/bookings/customer/:customerId -- หน้า "ประวัติการจอง" ของลูกค้า
router.get('/customer/:customerId', async (req, res, next) => {
  try {
    await expireStalePendingBookings();
    const result = await pool.query(
      `SELECT b.*, r.room_name, r.image_url, r.capacity,
              s.session_status, s.checkin_time, s.checkout_time
       FROM booking b JOIN room r ON r.room_id = b.room_id
       LEFT JOIN service_session s ON s.booking_id = b.booking_id
       WHERE b.customer_id = $1
       ORDER BY b.created_at DESC`,
      [req.params.customerId]
    );
    res.json(result.rows);
  } catch (err) {
    next(err);
  }
});

// PATCH /api/bookings/:id/cancel  { reason } -- ลูกค้ายกเลิกการจองของตัวเอง
// ยกเลิกได้เฉพาะก่อนเวลาเริ่มอย่างน้อย shop_policy.cancel_hours_before ชั่วโมง (ใช้นโยบายที่ผูกกับ booking นั้น
// ถ้าไม่มีให้ใช้นโยบายล่าสุด) — เทียบกับ LOCALTIMESTAMP ของ DB ซึ่งตั้ง timezone เป็น Asia/Bangkok ไว้แล้ว
router.patch('/:id/cancel', async (req, res, next) => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const found = await client.query(
      `SELECT b.booking_status,
              COALESCE(p.cancel_hours_before, latest.cancel_hours_before, 0) AS cancel_hours_before,
              b.start_datetime > LOCALTIMESTAMP
                + make_interval(hours => COALESCE(p.cancel_hours_before, latest.cancel_hours_before, 0)) AS within_window
       FROM booking b
       LEFT JOIN shop_policy p ON p.policy_id = b.policy_id
       LEFT JOIN LATERAL (
         SELECT cancel_hours_before FROM shop_policy ORDER BY effective_from DESC LIMIT 1
       ) latest ON true
       WHERE b.booking_id = $1
       FOR UPDATE OF b`,
      [req.params.id]
    );
    const booking = found.rows[0];
    if (!booking || !['pending', 'confirmed'].includes(booking.booking_status)) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'ไม่พบรายการ หรือยกเลิกไม่ได้แล้ว' });
    }
    if (!booking.within_window) {
      await client.query('ROLLBACK');
      return res.status(409).json({
        error: `ยกเลิกได้ล่วงหน้าก่อนเวลาเริ่มอย่างน้อย ${booking.cancel_hours_before} ชั่วโมงเท่านั้น กรุณาติดต่อร้าน`,
      });
    }
    const result = await client.query(
      `UPDATE booking SET booking_status = 'cancelled', cancel_reason = $2, updated_at = now()
       WHERE booking_id = $1
       RETURNING *`,
      [req.params.id, req.body.reason || 'ลูกค้ายกเลิกเอง']
    );
    await client.query('COMMIT');
    res.json(result.rows[0]);
  } catch (err) {
    await client.query('ROLLBACK');
    next(err);
  } finally {
    client.release();
  }
});

module.exports = router;
