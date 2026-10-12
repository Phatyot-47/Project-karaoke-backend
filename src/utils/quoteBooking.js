// คำนวณราคา + มัดจำของการจอง (ใช้ร่วมกันทั้งลูกค้าจองออนไลน์และแอดมินจองวอล์คอิน)
const { pool } = require('../db');
const { calculateBookingPrice } = require('./pricing');
const { getCurrentPolicy } = require('./shop');
const { getRatesForDate } = require('./rates');
const { makeCode } = require('./codes');
const { HttpError } = require('./http');

// ราคาห้องช่วงหนึ่ง (รวมค่าพีค / หักส่วนลดออฟพีค ตามราคาตามช่วงเวลาของวันนั้น) — ช่วงเวลาไม่ถูกต้องโยน HttpError 400
async function priceRange(room, startDatetime, endDatetime, db = pool) {
  const rates = await getRatesForDate(String(startDatetime).slice(0, 10), db);
  let price;
  try {
    price = calculateBookingPrice({ pricePerHour: Number(room.price_per_hour), rates, startDatetime, endDatetime });
  } catch (err) {
    throw new HttpError(400, err.message);
  }
  // กันราคา 0 บาท (มัดจำ 0 → ลูกค้าจ่ายมัดจำไม่ได้ การจองจะถูกยกเลิกเอง)
  if (price.priceTotal <= 0) throw new HttpError(400, 'ราคาหลังหักส่วนลดออฟพีคต้องมากกว่า 0 บาท กรุณาติดต่อร้าน');
  return price;
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
