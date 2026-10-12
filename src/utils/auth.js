// ระบบล็อกอินด้วย token (JWT)
// ล็อกอินสำเร็จ → ระบบออก "token" (เหมือนบัตรผ่าน) ให้หน้าเว็บเก็บไว้ แล้วแนบมากับทุกคำขอที่ต้องล็อกอิน
// ไฟล์นี้มี 2 อย่าง: สร้าง token และ ตัวตรวจบัตรผ่าน (requireCustomer / requireAdmin / requireLogin)
require('dotenv').config();
const jwt = require('jsonwebtoken');
const { HttpError } = require('./http');

// รหัสลับที่ใช้เซ็น token — ถ้าลืมตั้งใน .env จะไม่ยอมเปิดเซิร์ฟเวอร์ (กันใช้รหัสที่คนอื่นเดาได้)
const SECRET = process.env.JWT_SECRET;
if (!SECRET) throw new Error('ยังไม่ได้ตั้งค่า JWT_SECRET ใน .env (ดูตัวอย่างใน .env.example)');
const TOKEN_TTL = '12h'; // token ใช้ได้ 12 ชั่วโมง หลังจากนั้นต้องล็อกอินใหม่

/** สร้าง token: ข้างในมีแค่รหัสผู้ใช้ + บทบาท (ลูกค้า/แอดมิน) และเซ็นด้วยรหัสลับ คนอื่นแก้หรือปลอมไม่ได้ */
const signToken = (userId, role) => jwt.sign({ sub: String(userId), role }, SECRET, { expiresIn: TOKEN_TTL });

/**
 * ตัวตรวจบัตรผ่าน — วางไว้หน้า route ที่ต้องล็อกอิน
 * อ่าน header "Authorization: Bearer <token>" แล้วเก็บผู้ใช้ไว้ที่ req.user = { id, role }
 * roles = บทบาทที่อนุญาต (ไม่ใส่ = ล็อกอินแล้วใครก็ได้)
 * ไม่มี token / หมดอายุ / ปลอม → 401 (ให้ล็อกอินใหม่) · บทบาทไม่ตรง → 403 (ไม่มีสิทธิ์)
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
  requireCustomer: authenticate('customer'), // ลูกค้าเท่านั้น
  requireAdmin: authenticate('admin'), // แอดมินเท่านั้น
  requireLogin: authenticate('customer', 'admin'), // ลูกค้าหรือแอดมินก็ได้
};
