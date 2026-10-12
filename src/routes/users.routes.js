// API ข้อมูลส่วนตัวลูกค้า (/api/users/...) — แก้ชื่อ/เบอร์/รูปโปรไฟล์ และเปลี่ยนรหัสผ่าน
const router = require('express').Router();
const { pool } = require('../db');
const { HttpError, route } = require('../utils/http');
const { requireCustomer } = require('../utils/auth');
const { normalizePhone, checkName, checkPassword } = require('../utils/validate');

// ทุก route ในไฟล์นี้: ต้องล็อกอินเป็นลูกค้า และแก้ได้เฉพาะบัญชีของตัวเอง
router.use(requireCustomer);
const ownAccountOnly = (req) => {
  if (Number(req.params.id) !== req.user.id) throw new HttpError(403, 'แก้ไขได้เฉพาะข้อมูลของตัวเอง');
};

// avatarUrl ที่ยอมรับ: null / '' (ลบรูป) หรือลิงก์ http(s) / path ที่ได้จาก POST /api/uploads
const isAvatarUrl = (url) =>
  url === null || url === '' || (typeof url === 'string' && url.length <= 500 && /^(https?:\/\/|\/)/.test(url));

// PATCH /api/users/:id  { name, phone, avatarUrl? }  -- ลูกค้าแก้ไขข้อมูลส่วนตัวขั้นพื้นฐาน (หน้า "ข้อมูลส่วนตัว")
// avatarUrl: ไม่ส่งมา = รูปเดิม / '' = ลบรูป / ลิงก์ที่ได้จาก POST /api/uploads = เปลี่ยนรูป
router.patch(
  '/:id',
  route(
    async (req, res) => {
      ownAccountOnly(req);
      const { avatarUrl } = req.body;
      const name = checkName(req.body.name);
      const phone = normalizePhone(req.body.phone);
      const changeAvatar = avatarUrl !== undefined;
      if (changeAvatar && !isAvatarUrl(avatarUrl)) throw new HttpError(400, 'ลิงก์รูปโปรไฟล์ไม่ถูกต้อง');
      const user = (
        await pool.query(
          `UPDATE users SET name = $2, phone = $3,
       avatar_url = CASE WHEN $4::boolean THEN NULLIF($5::text, '') ELSE avatar_url END
     WHERE user_id = $1 AND role = 'customer'
     RETURNING user_id, name, phone, avatar_url`,
          [req.user.id, name, phone, changeAvatar, avatarUrl || ''],
        )
      ).rows[0];
      if (!user) throw new HttpError(404, 'ไม่พบบัญชีผู้ใช้นี้ กรุณาเข้าสู่ระบบใหม่');
      res.json(user);
    },
    { 23505: [409, 'เบอร์นี้ถูกใช้กับบัญชีอื่นแล้ว'] },
  ),
);

// PATCH /api/users/:id/password  { currentPassword, newPassword }  -- เปลี่ยนรหัสผ่าน (ต้องยืนยันรหัสเดิม)
router.patch(
  '/:id/password',
  route(async (req, res) => {
    ownAccountOnly(req);
    const { currentPassword, newPassword } = req.body;
    checkPassword(newPassword, 'รหัสผ่านใหม่');
    const updated = (
      await pool.query(
        `UPDATE users SET password_hash = crypt($3, gen_salt('bf'))
     WHERE user_id = $1 AND role = 'customer' AND password_hash = crypt($2, password_hash)
     RETURNING user_id`,
        [req.user.id, typeof currentPassword === 'string' ? currentPassword : '', newPassword],
      )
    ).rows[0];
    if (!updated) throw new HttpError(400, 'รหัสผ่านเดิมไม่ถูกต้อง');
    res.json({ ok: true });
  }),
);

module.exports = router;
