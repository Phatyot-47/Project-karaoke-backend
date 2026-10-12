// "ราคาตามช่วงเวลา" (พีคไทม์ / ออฟพีคไทม์) — ค่าหลักอยู่ในตาราง shop ใช้ทุกวัน
// วันไหนตั้ง shop_hours.custom_rates = true ใช้ค่าของวันนั้นแทน (ชื่อคอลัมน์เหมือนกันทั้งสองตาราง)
const { pool } = require('../db');
const { HttpError } = require('./http');
const { toRange } = require('./pricing');

/** แถวจาก shop หรือ shop_hours → rates ที่ calculateBookingPrice ใช้ */
function ratesFromRow(row) {
  return {
    peakStart: row?.peak_start_time || null,
    peakEnd: row?.peak_end_time || null,
    peakSurcharge: Number(row?.peak_surcharge || 0),
    offPeakStart: row?.offpeak_start_time || null,
    offPeakEnd: row?.offpeak_end_time || null,
    offPeakDiscount: Number(row?.offpeak_discount || 0),
  };
}

/** ราคาตามช่วงเวลาของวันที่ dateISO ("YYYY-MM-DD") — ใช้ค่าของวันนั้นถ้ากำหนดไว้ ไม่งั้นใช้ค่าหลักของร้าน */
async function getRatesForDate(dateISO, db = pool) {
  const [y, m, d] = dateISO.split('-').map(Number);
  const dayOfWeek = new Date(Date.UTC(y, m - 1, d)).getUTCDay();
  const row = (
    await db.query(
      `SELECT s.*, h.custom_rates,
              h.peak_start_time AS h_peak_start_time, h.peak_end_time AS h_peak_end_time, h.peak_surcharge AS h_peak_surcharge,
              h.offpeak_start_time AS h_offpeak_start_time, h.offpeak_end_time AS h_offpeak_end_time,
              h.offpeak_discount AS h_offpeak_discount
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
    offpeak_start_time: row.h_offpeak_start_time,
    offpeak_end_time: row.h_offpeak_end_time,
    offpeak_discount: row.h_offpeak_discount,
  });
}

// เวลาต้องเป็นนาทีที่ 00 หรือ 30 (ระบบคิดราคาทีละช่วง 30 นาที — ตั้ง 18:15 ช่อง 18:00 จะไม่นับเป็นพีค ทำให้ราคาดูไม่ตรง)
const TIME_RE = /^([01]\d|2[0-3]):(00|30)(:00)?$/;

/**
 * ตรวจราคาตามช่วงเวลาจากฟอร์ม → ค่าที่เก็บลง DB (ชื่อคอลัมน์)
 * input: { peakStartTime, peakEndTime, peakSurcharge, offPeakStartTime, offPeakEndTime, offPeakDiscount }
 * เวลาว่าง = ไม่มี (เริ่ม) / ถึงร้านปิด (สิ้นสุด) — label = คำนำหน้าข้อความ error เช่น "วันเสาร์: "
 */
function parseRates(input, label = '') {
  const time = (v, name) => {
    if (v === undefined || v === null || v === '') return null;
    if (typeof v !== 'string' || !TIME_RE.test(v))
      throw new HttpError(400, `${label}${name}ต้องเป็นเวลาเต็มชั่วโมงหรือครึ่งชั่วโมง เช่น 18:00 หรือ 18:30`);
    return v.slice(0, 5);
  };
  const money = (v, name) => {
    const n = v === '' || v === null || v === undefined ? 0 : Number(v);
    if (!Number.isFinite(n) || n < 0 || n > 100000)
      throw new HttpError(400, `${label}${name}ต้องเป็นตัวเลข 0-100,000 บาท`);
    return n;
  };
  const r = {
    peak_start_time: time(input.peakStartTime, 'เวลาเริ่มพีค'),
    peak_end_time: time(input.peakEndTime, 'เวลาสิ้นสุดพีค'),
    peak_surcharge: money(input.peakSurcharge, 'ค่าบริการเพิ่มช่วงพีค'),
    offpeak_start_time: time(input.offPeakStartTime, 'เวลาเริ่มออฟพีค'),
    offpeak_end_time: time(input.offPeakEndTime, 'เวลาสิ้นสุดออฟพีค'),
    offpeak_discount: money(input.offPeakDiscount, 'ส่วนลดช่วงออฟพีค'),
  };
  // มีเวลาสิ้นสุดแต่ไม่มีเวลาเริ่ม = ตั้งไม่ครบ
  if (r.peak_end_time && !r.peak_start_time) throw new HttpError(400, `${label}กรุณาใส่เวลาเริ่มพีค`);
  if (r.offpeak_end_time && !r.offpeak_start_time) throw new HttpError(400, `${label}กรุณาใส่เวลาเริ่มออฟพีค`);
  const peak = toRange(r.peak_start_time, r.peak_end_time);
  const off = toRange(r.offpeak_start_time, r.offpeak_end_time);
  if (peak && peak[0] >= peak[1]) throw new HttpError(400, `${label}เวลาเริ่มพีคต้องก่อนเวลาสิ้นสุด`);
  if (off && off[0] >= off[1]) throw new HttpError(400, `${label}เวลาเริ่มออฟพีคต้องก่อนเวลาสิ้นสุด`);
  if (peak && off && peak[0] < off[1] && off[0] < peak[1]) {
    throw new HttpError(400, `${label}ช่วงพีคและออฟพีคต้องไม่ทับกัน`);
  }
  return r;
}

/**
 * ส่วนลดออฟพีคต้องน้อยกว่าราคาห้องที่ถูกที่สุดที่เปิดให้บริการ
 * (ไม่งั้นราคาช่วงออฟพีคเป็น 0 → มัดจำ 0 → ลูกค้าจ่ายมัดจำไม่ได้)
 */
async function checkDiscountBelowRoomPrices(discount, label = '', db = pool) {
  if (!discount) return;
  const min = (await db.query('SELECT MIN(price_per_hour) AS p FROM room WHERE is_active = true')).rows[0].p;
  if (min !== null && discount >= Number(min)) {
    throw new HttpError(400, `${label}ส่วนลดออฟพีคต้องน้อยกว่าราคาห้องที่ถูกที่สุด (${Number(min)} บาท/ชม.)`);
  }
}

/** ส่วนลดออฟพีคสูงสุดที่ตั้งไว้ (ค่าหลัก หรือวันที่กำหนดเอง) — ใช้กันตั้งราคาห้องต่ำกว่าส่วนลด */
async function maxOffPeakDiscount(db = pool) {
  const row = (
    await db.query(
      `SELECT GREATEST(
         (SELECT COALESCE(MAX(offpeak_discount), 0) FROM shop WHERE offpeak_start_time IS NOT NULL),
         (SELECT COALESCE(MAX(offpeak_discount), 0) FROM shop_hours WHERE custom_rates AND offpeak_start_time IS NOT NULL)
       ) AS d`,
    )
  ).rows[0];
  return Number(row.d);
}

module.exports = { ratesFromRow, getRatesForDate, parseRates, checkDiscountBelowRoomPrices, maxOffPeakDiscount };
