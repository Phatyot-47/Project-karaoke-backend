const pool = require('../db');
const { calculateBookingPrice } = require('./pricing');

class QuoteError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

/**
 * คำนวณราคา + มัดจำของการจองหนึ่งรายการ (ใช้ร่วมกันทั้งลูกค้าจองออนไลน์และแอดมินจองวอล์คอิน)
 * โยน QuoteError (มี .status) เมื่อร้าน/นโยบายยังไม่ได้ตั้งค่า หรือช่วงเวลาไม่ถูกต้อง
 */
async function quoteBooking(room, startDatetime, endDatetime) {
  const shop = (await pool.query('SELECT * FROM shop ORDER BY shop_id LIMIT 1')).rows[0];
  if (!shop) throw new QuoteError(500, 'ยังไม่ได้ตั้งค่าร้าน');

  const policy = (await pool.query('SELECT * FROM shop_policy ORDER BY effective_from DESC LIMIT 1')).rows[0];
  if (!policy) throw new QuoteError(500, 'ยังไม่ได้ตั้งค่านโยบายมัดจำ');

  let price;
  try {
    price = calculateBookingPrice({
      pricePerHour: Number(room.price_per_hour),
      peakStartTime: shop.peak_start_time,
      peakSurcharge: Number(shop.peak_surcharge || 0),
      startDatetime,
      endDatetime,
    });
  } catch (err) {
    throw new QuoteError(400, err.message);
  }

  return {
    ...price,
    policyId: policy.policy_id,
    depositRequired: Math.round((price.priceTotal * Number(policy.deposit_percent)) / 100),
    bookingDate: startDatetime.slice(0, 10),
    bookingCode: 'BK-' + Date.now(),
  };
}

module.exports = { quoteBooking, QuoteError };
