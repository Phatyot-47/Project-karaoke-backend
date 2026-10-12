// อ่านข้อมูลร้าน และนโยบายมัดจำ/ยกเลิกฉบับล่าสุด
const { pool } = require('../db');

// ระบบนี้มีร้านเดียว → ใช้แถวแรกของตาราง shop เสมอ
async function getShop(db = pool) {
  return (await db.query('SELECT * FROM shop ORDER BY shop_id LIMIT 1')).rows[0] || null;
}

// นโยบายฉบับล่าสุด (เก็บเป็นข้อความ SQL เพื่อเอาไปต่อในคำสั่งอื่นได้ เช่น ตอนการจองเก่าไม่มีนโยบายผูกไว้)
// ทุกครั้งที่แอดมินแก้นโยบาย ระบบสร้างฉบับใหม่ ไม่ได้แก้ฉบับเดิม → ฉบับล่าสุด = effective_from ใหม่สุด
const LATEST_POLICY_SQL = 'SELECT * FROM shop_policy ORDER BY effective_from DESC, policy_id DESC LIMIT 1';

async function getCurrentPolicy(db = pool) {
  return (await db.query(LATEST_POLICY_SQL)).rows[0] || null;
}

module.exports = { getShop, getCurrentPolicy, LATEST_POLICY_SQL };
