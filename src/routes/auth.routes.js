// API เข้าสู่ระบบ (/api/auth/...) — สมัครสมาชิก/ล็อกอินลูกค้า, ตั้งรหัสผ่านครั้งแรก, ล็อกอินแอดมิน
const router = require('express').Router();
const rateLimit = require('express-rate-limit');
const { pool } = require('../db');
const { HttpError, route } = require('../utils/http');
const { signToken } = require('../utils/auth');
const { normalizePhone, checkName, checkPassword } = require('../utils/validate');

// จำกัดจำนวนครั้ง login/register ต่อ IP กัน brute-force เดารหัสผ่าน
// นับเฉพาะครั้งที่ไม่สำเร็จ — ลูกค้าหลายคนใช้ wifi ร้านเดียวกัน (IP เดียวกัน) ล็อกอินถูกต้องได้ไม่จำกัด
router.use(
  rateLimit({
    windowMs: 15 * 60 * 1000,
    limit: 10,
    skipSuccessfulRequests: true,
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: 'พยายามเข้าสู่ระบบบ่อยเกินไป กรุณาลองใหม่ภายหลัง' },
  }),
);

const CUSTOMER_FIELDS = 'user_id, name, phone, avatar_url';

// ผลลัพธ์ของการเข้าสู่ระบบลูกค้า = ข้อมูลผู้ใช้ + token (แนบไปกับทุก request ที่ต้องล็อกอิน)
const withToken = (user, role) => ({ ...user, token: signToken(user.user_id, role) });

// POST /api/auth/register  { name, phone, password }  -- สมัครสมาชิกลูกค้า
router.post(
  '/register',
  route(
    async (req, res) => {
      const name = checkName(req.body.name);
      const phone = normalizePhone(req.body.phone);
      const password = checkPassword(req.body.password);
      const user = (
        await pool.query(
          `INSERT INTO users (name, phone, role, password_hash) VALUES ($1, $2, 'customer', crypt($3, gen_salt('bf')))
     RETURNING ${CUSTOMER_FIELDS}`,
          [name, phone, password],
        )
      ).rows[0];
      res.status(201).json(withToken(user, 'customer'));
    },
    { 23505: [409, 'เบอร์นี้สมัครสมาชิกไปแล้ว'] },
  ),
);

// POST /api/auth/login  { phone, password }  -- ลูกค้าเข้าสู่ระบบ
// บัญชีเดิมที่ยังไม่เคยตั้งรหัสผ่าน → 409 code PASSWORD_NOT_SET ให้หน้าเว็บพาไปตั้งรหัสผ่านครั้งแรก
router.post(
  '/login',
  route(async (req, res) => {
    const phone = normalizePhone(req.body.phone);
    const user = (
      await pool.query(
        `SELECT ${CUSTOMER_FIELDS}, password_hash IS NULL AS no_password,
            password_hash IS NOT NULL AND password_hash = crypt($2, password_hash) AS password_ok
     FROM users WHERE phone = $1 AND role = 'customer'`,
        [phone, typeof req.body.password === 'string' ? req.body.password : ''],
      )
    ).rows[0];
    if (!user) throw new HttpError(404, 'ไม่พบบัญชีนี้ กรุณาสมัครสมาชิกก่อน');
    if (user.no_password)
      throw new HttpError(409, 'บัญชีนี้ยังไม่ได้ตั้งรหัสผ่าน กรุณาตั้งรหัสผ่านครั้งแรก', 'PASSWORD_NOT_SET');
    if (!user.password_ok) throw new HttpError(401, 'เบอร์โทรศัพท์หรือรหัสผ่านไม่ถูกต้อง');
    // ส่งกลับเฉพาะข้อมูลโปรไฟล์ (ไม่ส่งผลตรวจรหัสผ่านกลับไป)
    const profile = { user_id: user.user_id, name: user.name, phone: user.phone, avatar_url: user.avatar_url };
    res.json(withToken(profile, 'customer'));
  }),
);

// POST /api/auth/set-password  { phone, name, password }  -- ตั้งรหัสผ่านครั้งแรก (เฉพาะบัญชีเดิมที่ยังไม่มีรหัสผ่าน)
// ต้องกรอกชื่อที่ลงทะเบียนไว้ให้ตรงด้วย กันคนที่รู้แค่เบอร์มาตั้งรหัสผ่านแทนเจ้าของบัญชี
router.post(
  '/set-password',
  route(async (req, res) => {
    const phone = normalizePhone(req.body.phone);
    const name = checkName(req.body.name);
    const password = checkPassword(req.body.password);
    const user = (
      await pool.query(
        `UPDATE users SET password_hash = crypt($3, gen_salt('bf'))
     WHERE phone = $1 AND role = 'customer' AND password_hash IS NULL
       AND lower(regexp_replace(name, '\\s+', '', 'g')) = lower(regexp_replace($2, '\\s+', '', 'g'))
     RETURNING ${CUSTOMER_FIELDS}`,
        [phone, name, password],
      )
    ).rows[0];
    if (!user) throw new HttpError(401, 'ข้อมูลไม่ตรงกับบัญชี หรือบัญชีนี้ตั้งรหัสผ่านไปแล้ว');
    res.json(withToken(user, 'customer'));
  }),
);

// POST /api/auth/admin-login  { username, password }  -- แอดมินเข้าสู่ระบบ
router.post(
  '/admin-login',
  route(async (req, res) => {
    const { username, password } = req.body;
    if (typeof username !== 'string' || !username || typeof password !== 'string' || !password) {
      throw new HttpError(400, 'กรุณากรอก username และ password');
    }
    const admin = (
      await pool.query(
        `SELECT user_id, name, username FROM users
     WHERE username = $1 AND role = 'admin' AND password_hash = crypt($2, password_hash)`,
        [username, password],
      )
    ).rows[0];
    if (!admin) throw new HttpError(401, 'username หรือ password ไม่ถูกต้อง');
    res.json(withToken(admin, 'admin'));
  }),
);

module.exports = router;
