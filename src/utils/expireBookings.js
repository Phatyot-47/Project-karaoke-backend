// ยกเลิกการจองอัตโนมัติ ถ้าลูกค้าไม่แนบสลิปภายในเวลาที่กำหนด
const { pool } = require('../db');
const { TITLES, DETAIL_SQL } = require('./notify');

const HOLD_MINUTES = 5; // ต้องตรงกับ countdown ของ QR ฝั่ง frontend (PaymentPage)

/**
 * ปล่อยเวลาที่ "จองไว้ชั่วคราว" กลับมาว่าง ถ้าลูกค้าเลือกเวลาแล้วกดยืนยัน (สร้าง booking ตอน pending)
 * แต่ไม่จ่ายเงิน/แนบสลิปภายใน HOLD_MINUTES นาที — บูกกิ้งนี้ยังไม่เข้าสู่ "ขั้นตอนสุดท้าย" (ชำระเงินสำเร็จ)
 * จึงไม่ควรล็อกเวลานั้นไว้ต่อ ต้องเรียกก่อนทุกจุดที่อ่าน/เขียนสถานะห้อง-เวลาว่าง
 * (ไม่แตะ booking ของ walk-in หรือที่แนบสลิปแล้ว — deposit_status เปลี่ยนจาก unpaid ทันทีที่แนบสลิป
 *  และไม่แตะ booking ที่เคยจ่ายมัดจำมาแล้วแต่กลับเป็น unpaid เพราะลูกค้าแก้ไขการจองจนต้องจ่ายส่วนต่าง)
 * รายการที่ถูกยกเลิกจะสร้างแจ้งเตือน payment_expired ให้ลูกค้าในคำสั่งเดียวกัน (WITH ... INSERT)
 */
async function expireStalePendingBookings() {
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
