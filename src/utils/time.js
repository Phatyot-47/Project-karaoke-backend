// เครื่องมือเรื่องเวลาไทย — ใช้เช็คว่าเวลาที่ลูกค้าเลือกจอง "ผ่านไปแล้ว" หรือยัง
// เวลาทั้งระบบเป็นเวลาไทย (UTC+7) เสมอ ไม่ว่าเซิร์ฟเวอร์จะตั้งเวลาเป็นประเทศไหน
const BANGKOK_OFFSET_MS = 7 * 60 * 60 * 1000; // 7 ชั่วโมง (หน่วยมิลลิวินาที)
const PAST_SLOT_GRACE_MINUTES = 15; // เลยเวลาเริ่มไปไม่เกิน 15 นาทียังจองช่องนั้นได้

// วันที่และนาทีของวัน "ตอนนี้ตามเวลาไทย" เช่น { dateISO: '2026-10-12', minutesOfDay: 1230 } (= 20:30)
// วิธีคิด: เวลามาตรฐานโลก (UTC) + 7 ชั่วโมง = เวลาไทย
function bangkokNowParts() {
  const d = new Date(Date.now() + BANGKOK_OFFSET_MS);
  return {
    dateISO: `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')}`,
    minutesOfDay: d.getUTCHours() * 60 + d.getUTCMinutes(),
  };
}

// รูปแบบวันเวลาที่ระบบรับ: "YYYY-MM-DDTHH:MM" หรือ "YYYY-MM-DDTHH:MM:SS" (เช่น 2026-10-12T20:00:00)
const NAIVE_DATETIME_RE = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2}))?$/;

/**
 * เวลาเริ่มที่ส่งมา "ผ่านไปแล้ว" หรือยัง (เทียบกับเวลาไทยตอนนี้ + ผ่อนให้ 15 นาที)
 * แยกวันที่/ชั่วโมง/นาทีจากข้อความเอง ไม่ใช้ new Date() เพราะจะเพี้ยนตามเวลาของเครื่องเซิร์ฟเวอร์
 * ถ้ารูปแบบผิด หรือชั่วโมง/นาทีเป็นไปไม่ได้ ตอบ true (= ห้ามจอง) ไว้ก่อน เพื่อความปลอดภัย
 */
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
  if (dateISO < now.dateISO) return true; // วันก่อนหน้า = ผ่านไปแล้ว
  if (dateISO > now.dateISO) return false; // วันข้างหน้า = ยังไม่ถึง
  return startMinutesOfDay + PAST_SLOT_GRACE_MINUTES <= now.minutesOfDay; // วันนี้: เทียบนาที
}

module.exports = { NAIVE_DATETIME_RE, isStartInPast };
