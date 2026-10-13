// คิดราคา + มัดจำของการจอง และหาห้องที่จะจอง
// ใช้ร่วมกัน 3 ที่: ลูกค้าจองออนไลน์, ลูกค้าแก้ไขการจอง, แอดมินจองวอล์คอิน (ราคาจะได้คิดแบบเดียวกันทุกที่)
const { pool } = require('../db');
const { calculateBookingPrice } = require('./pricing');
const { getCurrentPolicy } = require('./shop');
const { getRatesForDate } = require('./rates');
const { makeCode } = require('./codes');
const { HttpError } = require('./http');
const { bangkokTodayISO, minutesFromDayStart } = require('./time');

const pad2 = (n) => String(n).padStart(2, '0');

/**
 * ตรวจว่าการจองอยู่ในกติกาของร้าน (หน้าเว็บตรวจแล้ว แต่ต้องตรวจซ้ำที่นี่ กันคนเรียก API ตรงๆ):
 * เป็นวันนี้ตามเวลาไทย / เริ่มและจบตรงช่อง 30 นาที / อยู่ภายในเวลาเปิด-ปิดร้านของวันนั้น
 * (ยังไม่ได้ตั้งเวลาเปิด-ปิดของวันนั้น = ไม่จำกัดเวลา เหมือนหน้าเว็บที่ถือว่าเปิด 24 ชม.)
 */
async function assertWithinShopHours(startDatetime, endDatetime, db) {
  const dateISO = String(startDatetime).slice(0, 10);
  if (dateISO !== bangkokTodayISO()) throw new HttpError(400, 'จองได้เฉพาะวันนี้เท่านั้น');
  const start = minutesFromDayStart(dateISO, startDatetime);
  const end = minutesFromDayStart(dateISO, endDatetime);
  if (!Number.isFinite(start) || !Number.isFinite(end) || start % 30 !== 0 || end % 30 !== 0 || end <= start) {
    throw new HttpError(
      400,
      'เวลาเริ่ม-สิ้นสุดต้องตรงช่องละ 30 นาที (เช่น 19:00, 19:30) และเวลาสิ้นสุดต้องหลังเวลาเริ่ม',
    );
  }
  const [y, m, d] = dateISO.split('-').map(Number);
  const dayOfWeek = new Date(Date.UTC(y, m - 1, d)).getUTCDay();
  const hours = (
    await db.query('SELECT open_hour, close_hour FROM shop_hours WHERE day_of_week = $1 ORDER BY shop_id LIMIT 1', [
      dayOfWeek,
    ])
  ).rows[0];
  if (!hours) return;
  const openHour = Number(hours.open_hour);
  const closeHour = Number(hours.close_hour);
  if (openHour === closeHour) throw new HttpError(400, 'วันนี้ร้านปิดให้บริการ');
  if (start < openHour * 60 || end > closeHour * 60) {
    throw new HttpError(400, `จองได้เฉพาะเวลาเปิดร้าน ${pad2(openHour)}:00–${pad2(closeHour)}:00 น.`);
  }
}

/** ห้องที่เปิดให้บริการอยู่ (ห้องที่แอดมินปิดไว้ = จองไม่ได้) — ไม่เจอตอบ 404 */
async function findActiveRoom(roomId, db = pool) {
  const room = (await db.query('SELECT * FROM room WHERE room_id = $1 AND is_active = true', [roomId])).rows[0];
  if (!room) throw new HttpError(404, 'ไม่พบห้อง หรือห้องปิดให้บริการ');
  return room;
}

/** ราคาของห้องนี้ในช่วงเวลานี้ (รวมค่าพีคไทม์ของวันนั้น) — เวลาไม่ถูกต้องตอบ 400 */
async function priceRange(room, startDatetime, endDatetime, db = pool) {
  const rates = await getRatesForDate(String(startDatetime).slice(0, 10), db);
  try {
    return calculateBookingPrice({ pricePerHour: Number(room.price_per_hour), rates, startDatetime, endDatetime });
  } catch (err) {
    throw new HttpError(400, err.message);
  }
}

/**
 * ข้อมูลทั้งหมดที่ต้องใช้สร้างการจองใหม่:
 * ราคา (ปกติ + พีค + รวม), มัดจำตาม % ในนโยบายล่าสุด, วันที่จอง และรหัสการจอง เช่น BK-1791...-k3f9
 * ตรวจกติกาเวลาของร้านก่อนเสมอ (assertWithinShopHours) — ใช้ได้ทั้งจองใหม่, แก้ไขการจอง และวอล์คอิน
 */
async function quoteBooking(room, startDatetime, endDatetime, db = pool) {
  await assertWithinShopHours(startDatetime, endDatetime, db);
  const price = await priceRange(room, startDatetime, endDatetime, db);
  const policy = await getCurrentPolicy(db);
  if (!policy) throw new HttpError(500, 'ยังไม่ได้ตั้งค่านโยบายมัดจำ');
  return {
    ...price,
    policyId: policy.policy_id,
    depositRequired: Math.round((price.priceTotal * Number(policy.deposit_percent)) / 100),
    bookingDate: startDatetime.slice(0, 10),
    bookingCode: makeCode('BK'),
  };
}

module.exports = { findActiveRoom, priceRange, quoteBooking };
