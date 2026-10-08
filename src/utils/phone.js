// ตรวจและจัดรูปแบบเบอร์โทรศัพท์ให้เป็นตัวเลขล้วน
const { HttpError } = require('./http');

/**
 * เบอร์โทรเก็บเป็นตัวเลขล้วน 9-10 หลัก (เช่น 0812345678) — ตัดขีด/ช่องว่างที่พิมพ์มาออกก่อนตรวจ
 * รูปแบบไม่ถูกต้องโยน HttpError 400
 */
function normalizePhone(value) {
  const digits = typeof value === 'string' ? value.replace(/\D/g, '') : '';
  if (!/^\d{9,10}$/.test(digits)) throw new HttpError(400, 'เบอร์โทรศัพท์ต้องเป็นตัวเลข 9-10 หลัก');
  return digits;
}

module.exports = { normalizePhone };
