// API แจ้งเตือนของลูกค้า (/api/notifications) — ไอคอนกระดิ่งบนเมนูลูกค้า
// ดู/กดอ่านได้เฉพาะแจ้งเตือนของตัวเอง (แจ้งเตือนถูกสร้างตอนร้าน/ระบบเปลี่ยนสถานะการจอง ดู utils/notify.js)
const router = require('express').Router();
const { pool } = require('../db');
const { HttpError, route } = require('../utils/http');
const { requireCustomer } = require('../utils/auth');

router.use(requireCustomer);

const LIST_LIMIT = 30;

// GET /api/notifications -- แจ้งเตือนล่าสุด 30 รายการ + จำนวนที่ยังไม่อ่าน
router.get(
  '/',
  route(async (req, res) => {
    const [items, unread] = await Promise.all([
      pool.query(
        `SELECT * FROM notification WHERE user_id = $1
         ORDER BY created_at DESC, notification_id DESC LIMIT ${LIST_LIMIT}`,
        [req.user.id],
      ),
      pool.query('SELECT COUNT(*)::int AS n FROM notification WHERE user_id = $1 AND is_read = false', [req.user.id]),
    ]);
    res.json({ unreadCount: unread.rows[0].n, items: items.rows });
  }),
);

// PATCH /api/notifications/read-all -- กด "อ่านทั้งหมด"
router.patch(
  '/read-all',
  route(async (req, res) => {
    const result = await pool.query('UPDATE notification SET is_read = true WHERE user_id = $1 AND is_read = false', [
      req.user.id,
    ]);
    res.json({ updated: result.rowCount });
  }),
);

// PATCH /api/notifications/:id/read -- กดแจ้งเตือนรายการเดียว (ของคนอื่นตอบเหมือนไม่มีรายการ)
router.patch(
  '/:id/read',
  route(async (req, res) => {
    const item = (
      await pool.query(
        'UPDATE notification SET is_read = true WHERE notification_id = $1 AND user_id = $2 RETURNING *',
        [req.params.id, req.user.id],
      )
    ).rows[0];
    if (!item) throw new HttpError(404, 'ไม่พบแจ้งเตือนนี้');
    res.json(item);
  }),
);

module.exports = router;
