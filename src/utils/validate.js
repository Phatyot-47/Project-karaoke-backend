// ตรวจข้อมูลที่ผู้ใช้กรอก (ชื่อ / เบอร์โทร / รหัสผ่าน / ข้อความเหตุผล) — ใช้ร่วมกันหลายหน้า
// ถ้าข้อมูลผิด จะตอบ error 400 พร้อมข้อความภาษาไทย หน้าเว็บเอาไปแสดงได้เลย
const { HttpError } = require('./http');

/** เบอร์โทร: ตัดขีด/ช่องว่างออก เหลือตัวเลขล้วน 9-10 หลัก เช่น "081-234-5678" → "0812345678" */
function normalizePhone(value) {
  const digits = typeof value === 'string' ? value.replace(/\D/g, '') : '';
  if (!/^\d{9,10}$/.test(digits)) throw new HttpError(400, 'เบอร์โทรศัพท์ต้องเป็นตัวเลข 9-10 หลัก');
  return digits;
}

/** ชื่อลูกค้า: ห้ามว่าง ไม่เกิน 100 ตัวอักษร (ตัดช่องว่างหัวท้ายออกให้) */
function checkName(name) {
  if (typeof name !== 'string' || !name.trim()) throw new HttpError(400, 'กรุณากรอกชื่อ');
  if (name.trim().length > 100) throw new HttpError(400, 'ชื่อต้องไม่เกิน 100 ตัวอักษร');
  return name.trim();
}

/**
 * รหัสผ่าน: 6-72 ตัวอักษร (72 คือขีดจำกัดของวิธีเข้ารหัส bcrypt)
 * รหัสผ่านไม่ได้เก็บตรงๆ — ฐานข้อมูลเก็บเป็นรหัสที่แปลงกลับไม่ได้ (hash) ด้วย crypt() + gen_salt('bf')
 * label = คำที่ใช้ในข้อความ error เช่น 'รหัสผ่านใหม่'
 */
function checkPassword(password, label = 'รหัสผ่าน') {
  if (typeof password !== 'string' || password.length < 6 || password.length > 72) {
    throw new HttpError(400, `${label}ต้องมี 6-72 ตัวอักษร`);
  }
  return password;
}

/** ข้อความเหตุผลที่ไม่บังคับกรอก (เช่น เหตุผลที่ยกเลิก): ว่าง/ไม่ใช่ข้อความ = ใช้ fallback แทน ยาวเกินตัดเหลือ 500 ตัว */
function reasonText(value, fallback) {
  return (typeof value === 'string' && value.trim().slice(0, 500)) || fallback;
}

module.exports = { normalizePhone, checkName, checkPassword, reasonText };
