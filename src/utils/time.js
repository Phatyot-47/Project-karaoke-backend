// ฟังก์ชันเกี่ยวกับเวลาไทย (UTC+7) — ใช้เช็คว่าเวลาที่จองผ่านไปแล้วหรือยัง
const BANGKOK_OFFSET_MS = 7 * 60 * 60 * 1000;
const PAST_SLOT_GRACE_MINUTES = 15;

// เวลา "ปัจจุบันตามเวลาไทย" แบบไม่พึ่ง timezone ที่ตั้งไว้บนเซิร์ฟเวอร์ — อ่านผ่าน getUTC*
// เท่านั้น (Date.now() เป็น UTC epoch เสมอ บวก 7 ชม. คงที่ แล้วอ่านค่ากลับด้วย getUTC*
// จะได้ตัวเลขเวลาไทยตรงๆ ไม่ว่าเซิร์ฟเวอร์จะตั้ง timezone อะไรไว้)
function bangkokNowParts() {
  const d = new Date(Date.now() + BANGKOK_OFFSET_MS);
  return {
    dateISO: `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')}`,
    minutesOfDay: d.getUTCHours() * 60 + d.getUTCMinutes(),
  };
}

const NAIVE_DATETIME_RE = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2}))?$/;

// startDatetime เป็นสตริง "YYYY-MM-DDTHH:MM:SS" (naive) ที่หมายถึงเวลาไทยตามธรรมเนียม
// ของแอปนี้ (คอลัมน์ booking.start_datetime เป็น TIMESTAMP ไม่มี time zone) — ต้อง parse
// ด้วย regex/split เอง ห้ามใช้ new Date(str) เพราะ Node จะตีความ timezone ตามเครื่องเซิร์ฟเวอร์
//
// Fail-closed: รูปแบบไม่ตรง หรือ ชม./นาทีนอกช่วงที่เป็นไปได้ ถือว่า "ผ่านไปแล้ว/ไม่ถูกต้อง"
// (return true -> ให้ route ปฏิเสธ) แทนที่จะปล่อยผ่านเงียบๆ
function isStartInPast(startDatetime) {
  if (typeof startDatetime !== 'string') return true;
  const match = startDatetime.match(NAIVE_DATETIME_RE);
  if (!match) return true;
  const [, , , , hStr, mStr] = match;
  const h = Number(hStr);
  const m = Number(mStr);
  if (h > 23 || m > 59) return true;
  const dateISO = startDatetime.slice(0, 10);
  const startMinutesOfDay = h * 60 + m;

  const now = bangkokNowParts();
  if (dateISO < now.dateISO) return true;
  if (dateISO > now.dateISO) return false;
  return startMinutesOfDay + PAST_SLOT_GRACE_MINUTES <= now.minutesOfDay;
}

module.exports = { NAIVE_DATETIME_RE, isStartInPast };
