require('dotenv').config();
const { Pool, types } = require('pg');

// DATE (1082) และ TIMESTAMP WITHOUT TIME ZONE (1114) ไม่มี timezone marker ในตัวเอง
// แต่ pg parser ค่า default จะ fallback ไปสร้าง JS Date ผ่าน constructor แบบ local time
// (new Date(year, month, day, ...)) ทำให้ผลลัพธ์ขึ้นกับ TZ ของเครื่องที่รัน Node process
// (ถูกโดยบังเอิญเมื่อรันที่ TZ Asia/Bangkok แต่จะเพี้ยนทันทีถ้า deploy ไปเครื่องที่ TZ อื่น เช่น UTC)
// ทั้งสองคอลัมน์ในระบบนี้ตั้งใจเก็บ "เวลาไทยแบบ naive" อยู่แล้ว (ดู src/utils/time.js) จึง
// return string ดิบจาก DB ตรงๆ แทน ไม่ผ่าน Date object เลย เพื่อไม่ให้ผลลัพธ์ขึ้นกับ TZ ของเครื่อง
types.setTypeParser(types.builtins.DATE, (val) => val);
types.setTypeParser(types.builtins.TIMESTAMP, (val) => (val ? val.replace(' ', 'T') : val));

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
});

pool.on('error', (err) => {
  console.error('Unexpected PG pool error', err);
});

/**
 * รัน fn(client) ใน transaction เดียว — สำเร็จ COMMIT / มี error ROLLBACK แล้วโยนต่อ
 * (fn โยน HttpError เพื่อยกเลิก transaction พร้อมตอบ error ได้เลย) และคืน connection เข้า pool เสมอ
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
    client.release();
  }
}

module.exports = { pool, withTransaction };
