// พีคไทม์ (ช่วงเวลาที่คิดค่าบริการเพิ่ม)
// - ค่าหลักเก็บในตาราง shop → ใช้ทุกวัน
// - วันไหนแอดมินติ๊ก "กำหนดราคาเอง" (shop_hours.custom_rates = true) → ใช้พีคไทม์ของวันนั้นแทน
const { pool } = require('../db');
const { HttpError } = require('./http');
const { toRange } = require('./pricing');

/** แถวจากตาราง shop หรือ shop_hours → รูปแบบที่สูตรคิดราคา (utils/pricing.js) ใช้ */
function ratesFromRow(row) {
  return {
    peakStart: row?.peak_start_time || null,
    peakEnd: row?.peak_end_time || null,
    peakSurcharge: Number(row?.peak_surcharge || 0),
  };
}

/** พีคไทม์ของวันที่ dateISO (เช่น "2026-10-12") — ถ้าวันนั้นกำหนดเองใช้ค่าของวันนั้น ไม่งั้นใช้ค่าหลักของร้าน */
async function getRatesForDate(dateISO, db = pool) {
  const [y, m, d] = dateISO.split('-').map(Number);
  const dayOfWeek = new Date(Date.UTC(y, m - 1, d)).getUTCDay(); // 0 = อาทิตย์ ... 6 = เสาร์
  const row = (
    await db.query(
      `SELECT s.*, h.custom_rates,
              h.peak_start_time AS h_peak_start_time, h.peak_end_time AS h_peak_end_time, h.peak_surcharge AS h_peak_surcharge
       FROM shop s LEFT JOIN shop_hours h ON h.shop_id = s.shop_id AND h.day_of_week = $1
       ORDER BY s.shop_id LIMIT 1`,
      [dayOfWeek],
    )
  ).rows[0];
  if (!row) throw new HttpError(500, 'ยังไม่ได้ตั้งค่าร้าน');
  if (!row.custom_rates) return ratesFromRow(row);
  return ratesFromRow({
    peak_start_time: row.h_peak_start_time,
    peak_end_time: row.h_peak_end_time,
    peak_surcharge: row.h_peak_surcharge,
  });
}

// เวลาต้องลงท้ายด้วย :00 หรือ :30 เท่านั้น (ระบบคิดราคาทีละ 30 นาที ถ้าตั้ง 18:15 ราคาจะดูไม่ตรงกับที่ตั้ง)
const TIME_RE = /^([01]\d|2[0-3]):(00|30)(:00)?$/;

/**
 * ตรวจพีคไทม์ที่แอดมินกรอกในฟอร์ม → แปลงเป็นค่าที่จะบันทึกลงฐานข้อมูล
 * input: { peakStartTime, peakEndTime, peakSurcharge }
 *   เวลาเริ่มว่าง = ไม่มีพีค / เวลาสิ้นสุดว่าง = พีคถึงร้านปิด
 * label = คำนำหน้าข้อความ error เช่น "วันเสาร์: " (บอกว่าผิดที่วันไหน)
 */
function parseRates(input, label = '') {
  const time = (v, name) => {
    if (v === undefined || v === null || v === '') return null;
    if (typeof v !== 'string' || !TIME_RE.test(v))
      throw new HttpError(400, `${label}${name}ต้องเป็นเวลาเต็มชั่วโมงหรือครึ่งชั่วโมง เช่น 18:00 หรือ 18:30`);
    return v.slice(0, 5);
  };
  const surcharge = input.peakSurcharge === '' || input.peakSurcharge == null ? 0 : Number(input.peakSurcharge);
  if (!Number.isFinite(surcharge) || surcharge < 0 || surcharge > 100000) {
    throw new HttpError(400, `${label}ค่าบริการเพิ่มช่วงพีคต้องเป็นตัวเลข 0-100,000 บาท`);
  }
  const r = {
    peak_start_time: time(input.peakStartTime, 'เวลาเริ่มพีค'),
    peak_end_time: time(input.peakEndTime, 'เวลาสิ้นสุดพีค'),
    peak_surcharge: surcharge,
  };
  if (r.peak_end_time && !r.peak_start_time) throw new HttpError(400, `${label}กรุณาใส่เวลาเริ่มพีค`);
  const peak = toRange(r.peak_start_time, r.peak_end_time);
  if (peak && peak[0] >= peak[1]) throw new HttpError(400, `${label}เวลาเริ่มพีคต้องก่อนเวลาสิ้นสุด`);
  return r;
}

module.exports = { getRatesForDate, parseRates };
