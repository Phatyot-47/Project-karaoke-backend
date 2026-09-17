const router = require('express').Router();
const pool = require('../db');
const { expireStalePendingBookings } = require('../utils/expireBookings');

// POST /api/payments  { bookingId, amount, method, evidenceUrl }
// -- ลูกค้าแนบสลิปการโอนเงินมัดจำ (หน้า "ยืนยันและชำระมัดจำ")
router.post('/', async (req, res, next) => {
  const { bookingId, amount, method, evidenceUrl } = req.body;
  if (!bookingId || !amount) {
    return res.status(400).json({ error: 'ข้อมูลไม่ครบ (bookingId, amount)' });
  }
  const client = await pool.connect();
  try {
    await expireStalePendingBookings();
    await client.query('BEGIN');
    const bookingRow = await client.query(
      'SELECT booking_status FROM booking WHERE booking_id = $1 FOR UPDATE',
      [bookingId]
    );
    if (!bookingRow.rows.length) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'ไม่พบรายการจอง' });
    }
    if (bookingRow.rows[0].booking_status !== 'pending') {
      await client.query('ROLLBACK');
      return res.status(409).json({ error: 'หมดเวลาชำระเงินสำหรับรายการนี้แล้ว กรุณาทำการจองใหม่' });
    }
    const payment = await client.query(
      `INSERT INTO payment (booking_id, payment_type, amount, method, paid_at, payment_status, evidence_url)
       VALUES ($1, 'deposit', $2, $3, now(), 'pending', $4)
       RETURNING *`,
      [bookingId, amount, method || 'qrcode', evidenceUrl || null]
    );
    await client.query(
      `UPDATE booking SET deposit_status = 'pending_verify', updated_at = now() WHERE booking_id = $1`,
      [bookingId]
    );
    await client.query('COMMIT');
    res.status(201).json(payment.rows[0]);
  } catch (err) {
    await client.query('ROLLBACK');
    next(err);
  } finally {
    client.release();
  }
});

module.exports = router;
