const router = require('express').Router();
const { withTransaction } = require('../db');
const { HttpError, route } = require('../utils/http');
const { expireStalePendingBookings } = require('../utils/expireBookings');

// POST /api/payments  { bookingId, method, evidenceUrl }
// -- ลูกค้าแนบสลิปการโอนเงินมัดจำ (หน้า "ยืนยันและชำระมัดจำ")
// ยอดเงินใช้ deposit_required จาก DB เสมอ (ไม่เชื่อ amount จากฝั่งลูกค้า) และส่งได้ครั้งเดียวต่อการจอง
router.post('/', route(async (req, res) => {
  const { bookingId, method, evidenceUrl } = req.body;
  if (!bookingId || !evidenceUrl) throw new HttpError(400, 'ข้อมูลไม่ครบ (bookingId, evidenceUrl)');
  await expireStalePendingBookings();
  const payment = await withTransaction(async (client) => {
    const booking = (await client.query(
      'SELECT booking_status, deposit_status, deposit_required FROM booking WHERE booking_id = $1 FOR UPDATE',
      [bookingId]
    )).rows[0];
    if (!booking) throw new HttpError(404, 'ไม่พบรายการจอง');
    if (booking.booking_status !== 'pending') throw new HttpError(409, 'หมดเวลาชำระเงินสำหรับรายการนี้แล้ว กรุณาทำการจองใหม่');
    if (booking.deposit_status !== 'unpaid') throw new HttpError(409, 'รายการนี้ส่งสลิปไปแล้ว กรุณารอร้านตรวจสอบ');
    const inserted = (await client.query(
      `INSERT INTO payment (booking_id, payment_type, amount, method, paid_at, payment_status, evidence_url)
       VALUES ($1, 'deposit', $2, $3, now(), 'pending', $4)
       RETURNING *`,
      [bookingId, booking.deposit_required, method || 'qrcode', evidenceUrl]
    )).rows[0];
    await client.query(
      `UPDATE booking SET deposit_status = 'pending_verify', updated_at = now() WHERE booking_id = $1`,
      [bookingId]
    );
    return inserted;
  });
  res.status(201).json(payment);
}));

module.exports = router;
