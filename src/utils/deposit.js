/**
 * ยอดมัดจำที่ลูกค้าส่งสลิปมาแล้วของ booking หนึ่ง (รอตรวจ + ตรวจผ่าน) — SQL ย่อยสำหรับใส่ใน SELECT
 * ใช้คิดส่วนต่างที่ต้องจ่ายเพิ่มหลังลูกค้าแก้ไขการจอง: ส่วนต่าง = deposit_required - ยอดนี้
 * @param {string} alias ชื่อ alias ของตาราง booking ใน query นั้น (เช่น 'b')
 */
const submittedDepositSql = (alias) => `(
  SELECT COALESCE(SUM(amount), 0) FROM payment
  WHERE payment.booking_id = ${alias}.booking_id AND payment.payment_status IN ('pending','paid')
)`;

module.exports = { submittedDepositSql };
