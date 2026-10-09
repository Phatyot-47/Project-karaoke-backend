// สร้างแจ้งเตือนให้ลูกค้าเจ้าของการจอง (ตาราง notification) — แสดงที่ไอคอนกระดิ่งฝั่งลูกค้า
// ต้องเรียกใน transaction เดียวกับที่เปลี่ยนสถานะการจอง: แจ้งเตือนบันทึกไม่สำเร็จ = สถานะไม่เปลี่ยนด้วย

// ข้อความหัวข้อของแต่ละเหตุการณ์ (type ต้องตรงกับ CHECK ใน migration 0008)
const TITLES = {
  booking_confirmed: 'ร้านยืนยันการจองของคุณแล้ว',
  booking_cancelled: 'ร้านยกเลิกการจองของคุณ',
  slip_rejected: 'สลิปมัดจำไม่ผ่านการตรวจสอบ',
  room_changed: 'ร้านย้ายห้องให้คุณ',
  no_show: 'บันทึกว่าไม่มาใช้บริการ',
  payment_expired: 'การจองถูกยกเลิก เพราะหมดเวลาชำระมัดจำ',
};

// รายละเอียดการจอง เช่น "One Piece วันที่ 08/10/2026 เวลา 20:00–21:00 น." (+ ข้อความเพิ่ม ถ้ามี)
const DETAIL_SQL = `r.room_name || ' วันที่ ' || to_char(b.start_datetime, 'DD/MM/YYYY')
  || ' เวลา ' || to_char(b.start_datetime, 'HH24:MI') || '–' || to_char(b.end_datetime, 'HH24:MI') || ' น.'`;

/**
 * แจ้งเตือนลูกค้าของ booking นี้ (การจองวอล์คอินไม่มี customer_id → ไม่สร้างอะไร)
 * @param db      client ใน transaction (หรือ pool)
 * @param extra   ข้อความต่อท้าย เช่น เหตุผลที่ยกเลิก (ไม่บังคับ)
 */
async function notifyBookingCustomer(db, bookingId, type, extra = null) {
  await db.query(
    `INSERT INTO notification (user_id, booking_id, type, title, message)
     SELECT b.customer_id, b.booking_id, $2, $3, ${DETAIL_SQL} || COALESCE(' · ' || $4::text, '')
     FROM booking b JOIN room r ON r.room_id = b.room_id
     WHERE b.booking_id = $1 AND b.customer_id IS NOT NULL`,
    [bookingId, type, TITLES[type], extra],
  );
}

module.exports = { notifyBookingCustomer, TITLES, DETAIL_SQL };
