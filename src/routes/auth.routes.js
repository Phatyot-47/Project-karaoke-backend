const router = require('express').Router();
const rateLimit = require('express-rate-limit');
const pool = require('../db');

// จำกัดจำนวนครั้ง login/register ต่อ IP กัน brute-force เดารหัส admin หรือเบอร์โทรลูกค้า
// (login ลูกค้าใช้แค่เบอร์โทรไม่มีรหัสผ่าน จึงยิ่งต้องกันการเดาเบอร์รัวๆ)
const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'พยายามเข้าสู่ระบบบ่อยเกินไป กรุณาลองใหม่ภายหลัง' },
});

router.use(authLimiter);

// POST /api/auth/register  { name, phone }  -- สมัครสมาชิกลูกค้า
router.post('/register', async (req, res, next) => {
  const { name, phone } = req.body;
  // เช็คชนิดก่อนเรียก .trim() — ถ้าส่งเบอร์มาเป็นตัวเลข .trim() จะ throw นอก try ทำให้ process ล่มทั้งตัว
  if (typeof name !== 'string' || !name.trim() || typeof phone !== 'string' || phone.trim().length < 9) {
    return res.status(400).json({ error: 'กรุณากรอกชื่อและเบอร์โทรศัพท์ให้ครบถ้วน' });
  }
  try {
    const existing = await pool.query('SELECT user_id FROM users WHERE phone = $1', [phone]);
    if (existing.rows.length) {
      return res.status(409).json({ error: 'เบอร์นี้สมัครสมาชิกไปแล้ว' });
    }
    const result = await pool.query(
      `INSERT INTO users (name, phone, role) VALUES ($1, $2, 'customer')
       RETURNING user_id, name, phone, avatar_url`,
      [name.trim(), phone.trim()]
    );
    res.status(201).json(result.rows[0]);
  } catch (err) {
    next(err);
  }
});

// POST /api/auth/login  { phone }  -- ลูกค้าเข้าสู่ระบบด้วยเบอร์โทร
router.post('/login', async (req, res, next) => {
  const { phone } = req.body;
  if (typeof phone !== 'string' || phone.trim().length < 9) {
    return res.status(400).json({ error: 'กรุณากรอกเบอร์โทรศัพท์ให้ถูกต้อง' });
  }
  try {
    const result = await pool.query(
      `SELECT user_id, name, phone, avatar_url FROM users WHERE phone = $1 AND role = 'customer'`,
      [phone.trim()]
    );
    if (!result.rows.length) {
      return res.status(404).json({ error: 'ไม่พบบัญชีนี้ กรุณาสมัครสมาชิกก่อน' });
    }
    res.json(result.rows[0]);
  } catch (err) {
    next(err);
  }
});

// POST /api/auth/admin-login  { username, password }  -- แอดมินเข้าสู่ระบบ
router.post('/admin-login', async (req, res, next) => {
  const { username, password } = req.body;
  if (!username || !password) {
    return res.status(400).json({ error: 'กรุณากรอก username และ password' });
  }
  try {
    const result = await pool.query(
      `SELECT user_id, name, username FROM users
       WHERE username = $1 AND role = 'admin' AND password_hash = crypt($2, password_hash)`,
      [username, password]
    );
    if (!result.rows.length) {
      return res.status(401).json({ error: 'username หรือ password ไม่ถูกต้อง' });
    }
    res.json(result.rows[0]);
  } catch (err) {
    next(err);
  }
});

module.exports = router;
