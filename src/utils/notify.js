// สร้างแจ้งเตือนให้ลูกค้า (ไอคอนกระดิ่งในหน้าลูกค้า) เมื่อร้านหรือระบบเปลี่ยนสถานะการจอง
// ควรเรียกพร้อมกับตอนเปลี่ยนสถานะ (ใน withTransaction เดียวกัน) — ถ้าบันทึกแจ้งเตือนไม่สำเร็จ สถานะก็จะไม่เปลี่ยนด้วย

// หัวข้อแจ้งเตือนของแต่ละเหตุการณ์ (ชื่อ type ต้องตรงกับที่อนุญาตในตาราง notification — ดู migration 0008)
const TITLES = {
  booking_confirmed: 'ร้านยืนยันการจองของคุณแล้ว',
  booking_cancelled: 'ร้านยกเลิกการจองของคุณ',
  slip_rejected: 'สลิปมัดจำไม่ผ่านการตรวจสอบ',
  room_changed: 'ร้านย้ายห้องให้คุณ',
  no_show: 'บันทึกว่าไม่มาใช้บริการ',
  payment_expired: 'การจองถูกยกเลิก เพราะหมดเวลาชำระมัดจำ',
};

// ข้อความรายละเอียดการจอง เช่น "One Piece วันที่ 08/10/2026 เวลา 20:00–21:00 น." (ให้ฐานข้อมูลประกอบข้อความให้)
const DETAIL_SQL = `r.room_name || ' วันที่ ' || to_char(b.start_datetime, 'DD/MM/YYYY')
  || ' เวลา ' || to_char(b.start_datetime, 'HH24:MI') || '–' || to_char(b.end_datetime, 'HH24:MI') || ' น.'`;

/**
 * ส่งแจ้งเตือนให้ลูกค้าเจ้าของการจองนี้ (การจองวอล์คอินไม่มีบัญชีลูกค้า → ไม่สร้างอะไร)
 * @param db      ตัวเชื่อมฐานข้อมูล (client ใน withTransaction หรือ pool)
 * @param type    ชนิดเหตุการณ์ (ชื่อใน TITLES)
 * @param extra   ข้อความต่อท้าย เช่น เหตุผลที่ยกเลิก (ไม่ใส่ก็ได้)
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
