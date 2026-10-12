// ตรวจข้อมูลที่ลูกค้ากรอก (ชื่อ / เบอร์โทร / รหัสผ่าน) — ใช้ร่วมกันทั้งสมัครสมาชิก, ล็อกอิน และแก้ไขข้อมูลส่วนตัว
// ข้อมูลไม่ถูกต้องโยน HttpError 400 พร้อมข้อความภาษาไทยให้หน้าเว็บแสดงได้เลย
const { HttpError } = require('./http');

/**
 * เบอร์โทรเก็บเป็นตัวเลขล้วน 9-10 หลัก (เช่น 0812345678) — ตัดขีด/ช่องว่างที่พิมพ์มาออกก่อนตรวจ
 */
function normalizePhone(value) {
  const digits = typeof value === 'string' ? value.replace(/\D/g, '') : '';
  if (!/^\d{9,10}$/.test(digits)) throw new HttpError(400, 'เบอร์โทรศัพท์ต้องเป็นตัวเลข 9-10 หลัก');
  return digits;
}

/** ชื่อลูกค้า: ห้ามว่าง ไม่เกิน 100 ตัวอักษร (คืนค่าที่ตัดช่องว่างหัวท้ายแล้ว) */
function checkName(name) {
  if (typeof name !== 'string' || !name.trim()) throw new HttpError(400, 'กรุณากรอกชื่อ');
  if (name.trim().length > 100) throw new HttpError(400, 'ชื่อต้องไม่เกิน 100 ตัวอักษร');
  return name.trim();
}

/**
 * รหัสผ่าน: 6-72 ตัวอักษร (bcrypt ใช้ได้สูงสุด 72 ไบต์) — เก็บเป็น hash ด้วย crypt() + gen_salt('bf') ของ pgcrypto
 * label = คำที่ใช้ในข้อความ error เช่น 'รหัสผ่านใหม่'
 */
function checkPassword(password, label = 'รหัสผ่าน') {
  if (typeof password !== 'string' || password.length < 6 || password.length > 72) {
    throw new HttpError(400, `${label}ต้องมี 6-72 ตัวอักษร`);
  }
  return password;
}

module.exports = { normalizePhone, checkName, checkPassword };
