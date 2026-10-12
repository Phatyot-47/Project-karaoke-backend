// คิดราคา + มัดจำของการจอง และหาห้องที่จะจอง
// ใช้ร่วมกัน 3 ที่: ลูกค้าจองออนไลน์, ลูกค้าแก้ไขการจอง, แอดมินจองวอล์คอิน (ราคาจะได้คิดแบบเดียวกันทุกที่)
const { pool } = require('../db');
const { calculateBookingPrice } = require('./pricing');
const { getCurrentPolicy } = require('./shop');
const { getRatesForDate } = require('./rates');
const { makeCode } = require('./codes');
const { HttpError } = require('./http');

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
 */
async function quoteBooking(room, startDatetime, endDatetime, db = pool) {
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
