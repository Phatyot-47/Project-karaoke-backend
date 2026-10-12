// ชิ้นส่วน SQL สำหรับ "ยอดมัดจำที่ลูกค้าจ่ายมาแล้ว" ของการจองหนึ่งรายการ (ใช้ซ้ำหลายที่ จึงรวมไว้ที่นี่)
// alias = ชื่อย่อของตาราง booking ในคำสั่ง SQL นั้น เช่น 'b' หรือ 'booking'

/**
 * ยอดที่ "ส่งสลิปมาแล้ว" = สลิปรอตรวจ + สลิปที่ตรวจผ่าน
 * ใช้คิดว่าลูกค้ายังต้องจ่ายเพิ่มเท่าไร (เช่น หลังแก้ไขการจองแล้วมัดจำสูงขึ้น: ส่วนต่าง = มัดจำใหม่ - ยอดนี้)
 */
const submittedDepositSql = (alias) => `(
  SELECT COALESCE(SUM(amount), 0) FROM payment
  WHERE payment.booking_id = ${alias}.booking_id AND payment.payment_status IN ('pending','paid')
)`;

/**
 * ยอดที่ "ร้านได้รับเงินจริงแล้ว" = เฉพาะสลิปที่ตรวจผ่าน + เงินสดที่รับหน้าร้าน
 * ใช้ตัดสินว่ามัดจำครบหรือยัง และใช้คิดรายได้ในรายงาน
 */
const paidDepositSql = (alias) => `(
  SELECT COALESCE(SUM(amount), 0) FROM payment
  WHERE payment.booking_id = ${alias}.booking_id AND payment.payment_status = 'paid'
)`;

module.exports = { submittedDepositSql, paidDepositSql };
