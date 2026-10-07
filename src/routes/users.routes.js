const router = require('express').Router();
const pool = require('../db');

// PATCH /api/users/:id  { name, phone, avatarUrl? }  -- ลูกค้าแก้ไขข้อมูลส่วนตัวขั้นพื้นฐาน (หน้า "ข้อมูลส่วนตัว")
// avatarUrl: ไม่ส่งมา = รูปเดิม / '' = ลบรูป / ลิงก์ที่ได้จาก POST /api/uploads = เปลี่ยนรูป
router.patch('/:id', async (req, res, next) => {
  const { name, phone, avatarUrl } = req.body;
  if (typeof name !== 'string' || !name.trim() || typeof phone !== 'string' || phone.trim().length < 9) {
    return res.status(400).json({ error: 'กรุณากรอกชื่อและเบอร์โทรศัพท์ให้ครบถ้วน' });
  }
  const changeAvatar = avatarUrl !== undefined;
  if (changeAvatar && !(avatarUrl === null || avatarUrl === ''
    || (typeof avatarUrl === 'string' && avatarUrl.length <= 500 && /^(https?:\/\/|\/)/.test(avatarUrl)))) {
    return res.status(400).json({ error: 'ลิงก์รูปโปรไฟล์ไม่ถูกต้อง' });
  }
  try {
    const result = await pool.query(
      `UPDATE users SET name = $2, phone = $3,
         avatar_url = CASE WHEN $4::boolean THEN NULLIF($5::text, '') ELSE avatar_url END
       WHERE user_id = $1 AND role = 'customer'
       RETURNING user_id, name, phone, avatar_url`,
      [req.params.id, name.trim(), phone.trim(), changeAvatar, avatarUrl || '']
    );
    if (!result.rows.length) return res.status(404).json({ error: 'ไม่พบบัญชีผู้ใช้นี้ กรุณาเข้าสู่ระบบใหม่' });
    res.json(result.rows[0]);
  } catch (err) {
    if (err.code === '23505') {
      return res.status(409).json({ error: 'เบอร์นี้ถูกใช้กับบัญชีอื่นแล้ว' });
    }
    next(err);
  }
});

module.exports = router;
