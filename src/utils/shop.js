// ฟังก์ชันอ่านข้อมูลร้านและนโยบายมัดจำ/ยกเลิกล่าสุด
const { pool } = require('../db');

// ระบบนี้มีร้านเดียว — ใช้แถวแรกของตาราง shop เสมอ (db = pool หรือ client ใน transaction)
async function getShop(db = pool) {
  return (await db.query('SELECT * FROM shop ORDER BY shop_id LIMIT 1')).rows[0] || null;
}

// นโยบายมัดจำ/ยกเลิกที่มีผลล่าสุด
async function getCurrentPolicy(db = pool) {
  return (
    (await db.query('SELECT * FROM shop_policy ORDER BY effective_from DESC, policy_id DESC LIMIT 1')).rows[0] || null
  );
}

module.exports = { getShop, getCurrentPolicy };
