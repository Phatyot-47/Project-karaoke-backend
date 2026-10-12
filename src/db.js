// การเชื่อมต่อฐานข้อมูล PostgreSQL — ไฟล์อื่นใช้ pool.query(...) ส่งคำสั่ง SQL ผ่านตัวนี้
// pool = "กลุ่มการเชื่อมต่อ" ที่เปิดค้างไว้ใช้ซ้ำ ไม่ต้องเปิด-ปิดใหม่ทุกครั้ง (เร็วกว่า)
require('dotenv').config();
const { Pool, types } = require('pg');

// วันที่ (DATE) และวันเวลา (TIMESTAMP) ในระบบนี้เก็บเป็น "เวลาไทย" อยู่แล้ว
// ถ้าปล่อยให้ไลบรารีแปลงเป็น Date ของ JavaScript เวลาจะเพี้ยนตาม timezone ของเครื่องที่รัน
// จึงให้คืนค่าเป็นข้อความตรงๆ เช่น "2026-10-12" และ "2026-10-12T20:00:00" (เปลี่ยนช่องว่างเป็นตัว T)
types.setTypeParser(types.builtins.DATE, (val) => val);
types.setTypeParser(types.builtins.TIMESTAMP, (val) => (val ? val.replace(' ', 'T') : val));

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
});

pool.on('error', (err) => {
  console.error('Unexpected PG pool error', err);
});

/**
 * รันหลายคำสั่ง SQL แบบ "ทั้งหมดหรือไม่เลย" (transaction)
 * เช่น ยืนยันการจอง + สร้างแจ้งเตือน: ถ้าอันไหนพัง ระบบจะย้อนคืนทุกอย่าง ไม่มีข้อมูลค้างครึ่งๆ กลางๆ
 * วิธีใช้: withTransaction(async (client) => { await client.query(...); ... })
 * - ทำครบไม่มี error → บันทึกจริง (COMMIT)
 * - มี error ตรงไหน → ยกเลิกทั้งหมด (ROLLBACK) แล้วส่ง error ต่อ
 */
async function withTransaction(fn) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release(); // คืนการเชื่อมต่อให้ pool ทุกครั้ง ไม่ว่าสำเร็จหรือไม่
  }
}

module.exports = { pool, withTransaction };
