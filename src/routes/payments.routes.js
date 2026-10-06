const router = require('express').Router();
const pool = require('../db');
const { expireStalePendingBookings } = require('../utils/expireBookings');

// POST /api/payments  { bookingId, method, evidenceUrl }
// -- ลูกค้าแนบสลิปการโอนเงินมัดจำ (หน้า "ยืนยันและชำระมัดจำ")
// ยอดเงินใช้ deposit_required จาก DB เสมอ (ไม่เชื่อ amount จากฝั่งลูกค้า) และส่งได้ครั้งเดียวต่อการจอง
router.post('/', async (req, res, next) => {
  const { bookingId, method, evidenceUrl } = req.body;
  if (!bookingId || !evidenceUrl) {
    return res.status(400).json({ error: 'ข้อมูลไม่ครบ (bookingId, evidenceUrl)' });
  }
  const client = await pool.connect();
  try {
    await expireStalePendingBookings();
    await client.query('BEGIN');
    const bookingRow = await client.query(
      'SELECT booking_status, deposit_status, deposit_required FROM booking WHERE booking_id = $1 FOR UPDATE',
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
    if (bookingRow.rows[0].deposit_status !== 'unpaid') {
      await client.query('ROLLBACK');
      return res.status(409).json({ error: 'รายการนี้ส่งสลิปไปแล้ว กรุณารอร้านตรวจสอบ' });
    }
    const payment = await client.query(
      `INSERT INTO payment (booking_id, payment_type, amount, method, paid_at, payment_status, evidence_url)
       VALUES ($1, 'deposit', $2, $3, now(), 'pending', $4)
       RETURNING *`,
      [bookingId, bookingRow.rows[0].deposit_required, method || 'qrcode', evidenceUrl]
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
