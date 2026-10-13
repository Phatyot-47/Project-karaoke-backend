// ยกเลิกการจองอัตโนมัติ เมื่อลูกค้าไม่แนบสลิปมัดจำภายในเวลาที่กำหนด
const { pool } = require('../db');
const { TITLES, DETAIL_SQL } = require('./notify');

const HOLD_MINUTES = 5; // ล็อกเวลาไว้ให้ 5 นาที — ต้องตรงกับตัวนับถอยหลังในหน้าชำระเงิน (PaymentPage)

/**
 * เมื่อลูกค้ากด "ยืนยันและชำระมัดจำ" ระบบจะสร้างการจอง (สถานะ pending) และกันเวลานั้นไว้ให้ชั่วคราว
 * ถ้าผ่านไป 5 นาทีแล้วยังไม่แนบสลิป → ยกเลิกการจองนั้น ให้เวลากลับมาว่างให้คนอื่นจองได้
 * พร้อมสร้างแจ้งเตือน "หมดเวลาชำระมัดจำ" ให้ลูกค้าในคำสั่งเดียวกัน
 *
 * ไม่ยกเลิก: การจองวอล์คอิน / รายการที่แนบสลิปแล้ว / รายการที่เคยจ่ายแล้วแต่ลูกค้าแก้ไขจนต้องจ่ายส่วนต่าง
 * ต้องเรียกก่อนทุกจุดที่ดูว่าห้องว่างไหม (ไม่งั้นเวลาที่หมดอายุแล้วจะยังดูเหมือนถูกจอง)
 */
async function expireStalePendingBookings() {
  // WITH expired AS (...) = ทำ UPDATE ก่อนแล้วตั้งชื่อผลว่า expired (เลขการจองที่เพิ่งยกเลิก)
  // จากนั้น INSERT แจ้งเตือนให้ลูกค้าของการจองเหล่านั้น — 2 ขั้นในคำสั่ง SQL เดียว
  await pool.query(
    `
    WITH expired AS (
    UPDATE booking
    SET booking_status = 'cancelled',
        cancel_reason = 'หมดเวลาชำระมัดจำ (ระบบยกเลิกอัตโนมัติ)',
        cancelled_by = 'system',
        updated_at = now()
    WHERE booking_status = 'pending'
      AND booking_source = 'customer_online'
      AND deposit_status = 'unpaid'
      AND created_at < now() - interval '${HOLD_MINUTES} minutes'
      AND NOT EXISTS (
        SELECT 1 FROM payment
        WHERE payment.booking_id = booking.booking_id AND payment.payment_status IN ('pending','paid')
      )
    RETURNING booking_id
    )
    INSERT INTO notification (user_id, booking_id, type, title, message)
    SELECT b.customer_id, b.booking_id, 'payment_expired', $1, ${DETAIL_SQL}
    FROM expired e JOIN booking b ON b.booking_id = e.booking_id JOIN room r ON r.room_id = b.room_id
    WHERE b.customer_id IS NOT NULL
  `,
    [TITLES.payment_expired],
  );
}

module.exports = { expireStalePendingBookings };
