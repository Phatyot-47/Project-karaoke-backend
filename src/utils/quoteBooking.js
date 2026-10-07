const { pool } = require('../db');
const { calculateBookingPrice } = require('./pricing');
const { getShop, getCurrentPolicy } = require('./shop');
const { makeCode } = require('./codes');
const { HttpError } = require('./http');

// ราคาห้องช่วงหนึ่ง (รวมค่าพีคไทม์ตามการตั้งค่าร้าน) — ช่วงเวลาไม่ถูกต้องโยน HttpError 400
async function priceRange(room, startDatetime, endDatetime, db = pool) {
  const shop = await getShop(db);
  if (!shop) throw new HttpError(500, 'ยังไม่ได้ตั้งค่าร้าน');
  try {
    return calculateBookingPrice({
      pricePerHour: Number(room.price_per_hour),
      peakStartTime: shop.peak_start_time,
      peakSurcharge: Number(shop.peak_surcharge || 0),
      startDatetime,
      endDatetime,
    });
  } catch (err) {
    throw new HttpError(400, err.message);
  }
}

/**
 * คำนวณข้อมูลสำหรับสร้าง booking ใหม่ (ใช้ร่วมกันทั้งลูกค้าจองออนไลน์และแอดมินจองวอล์คอิน):
 * ราคา + มัดจำตามนโยบายล่าสุด + วันที่จอง + รหัสการจอง
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

module.exports = { priceRange, quoteBooking };
