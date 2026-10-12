// สร้างรหัสอ้างอิงที่ไม่ซ้ำกัน (รหัสการจอง / รหัสห้อง)
const crypto = require('crypto');

/**
 * สร้างรหัส เช่น BK-1791213676683-k3f9 (รหัสการจอง) หรือ R-1791213676683-x0a2 (รหัสห้อง)
 * = ตัวนำหน้า + เวลาปัจจุบัน (มิลลิวินาที) + ตัวอักษรสุ่ม 4 ตัว
 * ตัวสุ่มกันกรณีมี 2 คำขอในมิลลิวินาทีเดียวกันแล้วได้รหัสซ้ำ (ความยาวรวมไม่เกิน 20 ตัวตามที่ตาราง room กำหนด)
 */
function makeCode(prefix) {
  const random = crypto
    .randomInt(36 ** 4)
    .toString(36)
    .padStart(4, '0');
  return `${prefix}-${Date.now()}-${random}`;
}

module.exports = { makeCode };
