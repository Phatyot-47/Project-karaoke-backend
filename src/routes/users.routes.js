const router = require('express').Router();
const { pool } = require('../db');
const { HttpError, route } = require('../utils/http');

// avatarUrl ที่ยอมรับ: null / '' (ลบรูป) หรือลิงก์ http(s) / path ที่ได้จาก POST /api/uploads
const isAvatarUrl = (url) => url === null || url === ''
  || (typeof url === 'string' && url.length <= 500 && /^(https?:\/\/|\/)/.test(url));

// PATCH /api/users/:id  { name, phone, avatarUrl? }  -- ลูกค้าแก้ไขข้อมูลส่วนตัวขั้นพื้นฐาน (หน้า "ข้อมูลส่วนตัว")
// avatarUrl: ไม่ส่งมา = รูปเดิม / '' = ลบรูป / ลิงก์ที่ได้จาก POST /api/uploads = เปลี่ยนรูป
router.patch('/:id', route(async (req, res) => {
  const { name, phone, avatarUrl } = req.body;
  if (typeof name !== 'string' || !name.trim() || typeof phone !== 'string' || phone.trim().length < 9) {
    throw new HttpError(400, 'กรุณากรอกชื่อและเบอร์โทรศัพท์ให้ครบถ้วน');
  }
  const changeAvatar = avatarUrl !== undefined;
  if (changeAvatar && !isAvatarUrl(avatarUrl)) throw new HttpError(400, 'ลิงก์รูปโปรไฟล์ไม่ถูกต้อง');
  const user = (await pool.query(
    `UPDATE users SET name = $2, phone = $3,
       avatar_url = CASE WHEN $4::boolean THEN NULLIF($5::text, '') ELSE avatar_url END
     WHERE user_id = $1 AND role = 'customer'
     RETURNING user_id, name, phone, avatar_url`,
    [req.params.id, name.trim(), phone.trim(), changeAvatar, avatarUrl || '']
  )).rows[0];
  if (!user) throw new HttpError(404, 'ไม่พบบัญชีผู้ใช้นี้ กรุณาเข้าสู่ระบบใหม่');
  res.json(user);
}, { '23505': [409, 'เบอร์นี้ถูกใช้กับบัญชีอื่นแล้ว'] }));

module.exports = router;
