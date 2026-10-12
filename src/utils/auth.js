// ระบบ token (JWT) — สร้าง token ตอนล็อกอิน และ middleware ตรวจสิทธิ์ลูกค้า/แอดมิน
require('dotenv').config();
const jwt = require('jsonwebtoken');
const { HttpError } = require('./http');

// รหัสลับสำหรับเซ็น token — ไม่มีไม่ให้ server เริ่มทำงาน (กันลืมตั้งค่าแล้วใช้ค่าที่เดาได้)
const SECRET = process.env.JWT_SECRET;
if (!SECRET) throw new Error('ยังไม่ได้ตั้งค่า JWT_SECRET ใน .env (ดูตัวอย่างใน .env.example)');
const TOKEN_TTL = '12h';

/** token เข้าสู่ระบบ: ข้างในมีแค่ user_id + role เซ็นด้วย JWT_SECRET (แก้ไข/ปลอมไม่ได้ถ้าไม่มีรหัสลับ) */
const signToken = (userId, role) => jwt.sign({ sub: String(userId), role }, SECRET, { expiresIn: TOKEN_TTL });

/**
 * middleware ตรวจ header "Authorization: Bearer <token>" แล้วใส่ req.user = { id, role }
 * roles: role ที่อนุญาต (ไม่ระบุ = ล็อกอินแล้วเป็นใครก็ได้)
 * ไม่มี/หมดอายุ/ปลอม token → 401 / role ไม่ตรง → 403
 */
function authenticate(...roles) {
  return (req, res, next) => {
    const match = /^Bearer (.+)$/.exec(req.get('authorization') || '');
    if (!match) return next(new HttpError(401, 'กรุณาเข้าสู่ระบบ'));
    let payload;
    try {
      payload = jwt.verify(match[1], SECRET);
    } catch {
      return next(new HttpError(401, 'เซสชันหมดอายุ กรุณาเข้าสู่ระบบใหม่'));
    }
    if (roles.length && !roles.includes(payload.role)) return next(new HttpError(403, 'ไม่มีสิทธิ์ใช้งานส่วนนี้'));
    req.user = { id: Number(payload.sub), role: payload.role };
    next();
  };
}

module.exports = {
  signToken,
  requireCustomer: authenticate('customer'),
  requireAdmin: authenticate('admin'),
  requireLogin: authenticate('customer', 'admin'),
};
