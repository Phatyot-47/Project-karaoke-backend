// สร้างรหัสอ้างอิงที่ไม่ซ้ำกัน (รหัสการจอง / รหัสห้อง)
const crypto = require('crypto');

/**
 * สร้างรหัสอ้างอิง เช่น BK-1791213676683-k3f9 (booking_code) / R-1791213676683-x0a2 (room_code)
 * เดิมใช้แค่ prefix + Date.now() ถ้ามี 2 request ในมิลลิวินาทีเดียวกันจะได้รหัสซ้ำ แล้วชน UNIQUE
 * constraint กลายเป็น 500 — ต่อท้ายด้วยสุ่ม 4 ตัว (base36) กันชน ความยาวรวมไม่เกิน varchar(20) ของ room_code
 */
function makeCode(prefix) {
  const random = crypto
    .randomInt(36 ** 4)
    .toString(36)
    .padStart(4, '0');
  return `${prefix}-${Date.now()}-${random}`;
}

module.exports = { makeCode };
