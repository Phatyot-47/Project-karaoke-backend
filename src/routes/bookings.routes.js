const router = require('express').Router();
const { pool, withTransaction } = require('../db');
const { HttpError, route } = require('../utils/http');
const { quoteBooking } = require('../utils/quoteBooking');
const { expireStalePendingBookings } = require('../utils/expireBookings');
const { isStartInPast } = require('../utils/time');

const NOTE_MAX_LENGTH = 300;

// POST /api/bookings  { customerId, roomId, startDatetime, endDatetime, guestCount, note }
// -- ลูกค้ายืนยันช่วงเวลาจอง (ก่อนไปหน้าชำระมัดจำ)
router.post('/', route(async (req, res) => {
  const { customerId, roomId, startDatetime, endDatetime, guestCount } = req.body;
  if (!roomId || !startDatetime || !endDatetime) {
    throw new HttpError(400, 'ข้อมูลไม่ครบ (roomId, startDatetime, endDatetime)');
  }
  const note = typeof req.body.note === 'string' ? req.body.note.trim() : '';
  if (note.length > NOTE_MAX_LENGTH) throw new HttpError(400, `หมายเหตุต้องไม่เกิน ${NOTE_MAX_LENGTH} ตัวอักษร`);
  // endpoint นี้ใช้เฉพาะ flow ลูกค้า login แล้วจอง (ไม่มี walkin_name ให้ fallback แบบฝั่งแอดมิน)
  // ต้องมี customerId เป็นเลขจำนวนเต็มบวกเสมอ ไม่งั้นจะไปชน CHECK/FK constraint ที่ DB แล้วหลุดเป็น 500
  if (!Number.isInteger(Number(customerId)) || Number(customerId) <= 0) {
    throw new HttpError(400, 'ต้องระบุ customerId ที่ถูกต้อง กรุณาเข้าสู่ระบบใหม่');
  }
  if (isStartInPast(startDatetime)) throw new HttpError(400, 'เวลาที่เลือกผ่านไปแล้ว กรุณาเลือกเวลาอื่น');

  await expireStalePendingBookings();
  const room = (await pool.query('SELECT * FROM room WHERE room_id = $1 AND is_active = true', [roomId])).rows[0];
  if (!room) throw new HttpError(404, 'ไม่พบห้อง หรือห้องปิดให้บริการ');
  const q = await quoteBooking(room, startDatetime, endDatetime);

  const booking = (await pool.query(
    `INSERT INTO booking (
       booking_code, customer_id, room_id, policy_id, booking_source,
       booking_date, start_datetime, end_datetime, guest_count, booking_status,
       base_price, peak_surcharge_total, price_total, deposit_required, deposit_status, note
     ) VALUES ($1,$2,$3,$4,'customer_online',$5,$6,$7,$8,'pending',$9,$10,$11,$12,'unpaid',$13)
     RETURNING *`,
    [q.bookingCode, Number(customerId), roomId, q.policyId, q.bookingDate, startDatetime, endDatetime,
      guestCount || null, q.basePrice, q.peakSurchargeTotal, q.priceTotal, q.depositRequired, note || null]
  )).rows[0];
  res.status(201).json(booking);
}, {
  '23P01': [409, 'ช่วงเวลานี้ถูกจองไปแล้ว กรุณาเลือกเวลาอื่น'],
  '23503': [404, 'ไม่พบบัญชีผู้ใช้นี้ กรุณาเข้าสู่ระบบใหม่'],
}));

// GET /api/bookings/customer/:customerId -- หน้า "ประวัติการจอง" ของลูกค้า
router.get('/customer/:customerId', route(async (req, res) => {
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
}));

// GET /api/bookings/:id -- รายการจองเดียว (หน้าชำระมัดจำโหลดใหม่ได้เมื่อรีเฟรช / กดชำระต่อจากหน้าประวัติ)
router.get('/:id', route(async (req, res) => {
  if (!/^\d+$/.test(req.params.id)) throw new HttpError(400, 'รหัสการจองไม่ถูกต้อง');
  await expireStalePendingBookings();
  const booking = (await pool.query(
    `SELECT b.*, r.room_name, r.image_url, r.size, r.capacity
     FROM booking b JOIN room r ON r.room_id = b.room_id
     WHERE b.booking_id = $1`,
    [req.params.id]
  )).rows[0];
  if (!booking) throw new HttpError(404, 'ไม่พบรายการจอง');
  res.json(booking);
}));

// PATCH /api/bookings/:id/cancel  { reason } -- ลูกค้ายกเลิกการจองของตัวเอง
// ยกเลิกได้เฉพาะก่อนเวลาเริ่มอย่างน้อย shop_policy.cancel_hours_before ชั่วโมง (ใช้นโยบายที่ผูกกับ booking นั้น
// ถ้าไม่มีให้ใช้นโยบายล่าสุด) — เทียบกับ LOCALTIMESTAMP ของ DB ซึ่งตั้ง timezone เป็น Asia/Bangkok ไว้แล้ว
router.patch('/:id/cancel', route(async (req, res) => {
  const booking = await withTransaction(async (client) => {
    const found = (await client.query(
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
    )).rows[0];
    if (!found || !['pending', 'confirmed'].includes(found.booking_status)) {
      throw new HttpError(404, 'ไม่พบรายการ หรือยกเลิกไม่ได้แล้ว');
    }
    if (!found.within_window) {
      throw new HttpError(409, `ยกเลิกได้ล่วงหน้าก่อนเวลาเริ่มอย่างน้อย ${found.cancel_hours_before} ชั่วโมงเท่านั้น กรุณาติดต่อร้าน`);
    }
    return (await client.query(
      `UPDATE booking SET booking_status = 'cancelled', cancel_reason = $2, updated_at = now()
       WHERE booking_id = $1
       RETURNING *`,
      [req.params.id, req.body.reason || 'ลูกค้ายกเลิกเอง']
    )).rows[0];
  });
  res.json(booking);
}));

module.exports = router;
