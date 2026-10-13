// API เข้าสู่ระบบ (/api/auth/...)
// มี 4 อย่าง: ลูกค้าสมัครสมาชิก, ลูกค้าล็อกอิน, ลูกค้าเก่าตั้งรหัสผ่านครั้งแรก, แอดมินล็อกอิน
// ทุกแบบถ้าสำเร็จจะได้ token กลับไป (ดู utils/auth.js)
// (SQL ในไฟล์นี้: $1, JOIN, COALESCE, RETURNING ฯลฯ ดูคำอธิบายพื้นฐานที่ routes/bookings.routes.js)
const router = require('express').Router();
const rateLimit = require('express-rate-limit');
const { pool } = require('../db');
const { HttpError, route } = require('../utils/http');
const { signToken } = require('../utils/auth');
const { normalizePhone, checkName, checkPassword } = require('../utils/validate');

// กันคนสุ่มเดารหัสผ่าน: กรอกผิดได้ไม่เกิน 10 ครั้งใน 15 นาที (นับต่อเครื่อง/IP)
// นับเฉพาะครั้งที่ผิด — ลูกค้าหลายคนใช้ wifi ร้านเดียวกัน ถ้าล็อกอินถูกก็ไม่โดนนับ
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

// ผลลัพธ์ตอนล็อกอินสำเร็จ = ข้อมูลผู้ใช้ + token (หน้าเว็บเก็บ token ไว้แนบไปกับทุกคำขอที่ต้องล็อกอิน)
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

// POST /api/auth/login  { phone, password }  -- ลูกค้าเข้าสู่ระบบด้วยเบอร์โทร + รหัสผ่าน
// บัญชีเก่าที่ยังไม่เคยตั้งรหัสผ่าน → ตอบ 409 พร้อม code PASSWORD_NOT_SET ให้หน้าเว็บพาไปตั้งรหัสผ่านก่อน
// (ฐานข้อมูลเทียบรหัสผ่านให้เองด้วย crypt() เราไม่เคยเห็นรหัสผ่านจริงที่เก็บไว้)
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

// POST /api/auth/set-password  { phone, name, password }  -- ตั้งรหัสผ่านครั้งแรก (เฉพาะบัญชีเก่าที่ยังไม่มีรหัสผ่าน)
// ต้องกรอกชื่อให้ตรงกับที่ลงทะเบียนไว้ด้วย (ไม่สนช่องว่าง/ตัวพิมพ์เล็กใหญ่) กันคนที่รู้แค่เบอร์มาตั้งรหัสแทนเจ้าของ
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
