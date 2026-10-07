const router = require('express').Router();
const rateLimit = require('express-rate-limit');
const { pool } = require('../db');
const { HttpError, route } = require('../utils/http');

// จำกัดจำนวนครั้ง login/register ต่อ IP กัน brute-force เดารหัส admin หรือเบอร์โทรลูกค้า
// (login ลูกค้าใช้แค่เบอร์โทรไม่มีรหัสผ่าน จึงยิ่งต้องกันการเดาเบอร์รัวๆ)
router.use(rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'พยายามเข้าสู่ระบบบ่อยเกินไป กรุณาลองใหม่ภายหลัง' },
}));

// เบอร์โทรต้องเป็นข้อความ (ถ้าส่งมาเป็นตัวเลข .trim() จะ throw) และยาวอย่างน้อย 9 หลัก
const isPhone = (phone) => typeof phone === 'string' && phone.trim().length >= 9;

// POST /api/auth/register  { name, phone }  -- สมัครสมาชิกลูกค้า
router.post('/register', route(async (req, res) => {
  const { name, phone } = req.body;
  if (typeof name !== 'string' || !name.trim() || !isPhone(phone)) {
    throw new HttpError(400, 'กรุณากรอกชื่อและเบอร์โทรศัพท์ให้ครบถ้วน');
  }
  const result = await pool.query(
    `INSERT INTO users (name, phone, role) VALUES ($1, $2, 'customer')
     RETURNING user_id, name, phone, avatar_url`,
    [name.trim(), phone.trim()]
  );
  res.status(201).json(result.rows[0]);
}, { '23505': [409, 'เบอร์นี้สมัครสมาชิกไปแล้ว'] }));

// POST /api/auth/login  { phone }  -- ลูกค้าเข้าสู่ระบบด้วยเบอร์โทร
router.post('/login', route(async (req, res) => {
  const { phone } = req.body;
  if (!isPhone(phone)) throw new HttpError(400, 'กรุณากรอกเบอร์โทรศัพท์ให้ถูกต้อง');
  const user = (await pool.query(
    `SELECT user_id, name, phone, avatar_url FROM users WHERE phone = $1 AND role = 'customer'`,
    [phone.trim()]
  )).rows[0];
  if (!user) throw new HttpError(404, 'ไม่พบบัญชีนี้ กรุณาสมัครสมาชิกก่อน');
  res.json(user);
}));

// POST /api/auth/admin-login  { username, password }  -- แอดมินเข้าสู่ระบบ
router.post('/admin-login', route(async (req, res) => {
  const { username, password } = req.body;
  if (!username || !password) throw new HttpError(400, 'กรุณากรอก username และ password');
  const admin = (await pool.query(
    `SELECT user_id, name, username FROM users
     WHERE username = $1 AND role = 'admin' AND password_hash = crypt($2, password_hash)`,
    [username, password]
  )).rows[0];
  if (!admin) throw new HttpError(401, 'username หรือ password ไม่ถูกต้อง');
  res.json(admin);
}));

module.exports = router;
