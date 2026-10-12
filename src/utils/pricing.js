// คำนวณราคาการจอง โดยแบ่งเป็นช่วงละ 30 นาที (สูตรเดียวกับ src/utils/pricing.js ฝั่งหน้าเว็บ ที่ใช้พรีวิวราคา)
// ช่วงพีค = ราคาห้อง + ค่าบริการเพิ่ม / ช่วงออฟพีค = ราคาห้อง - ส่วนลด / นอกนั้น = ราคาห้อง
// ดูว่าช่วง 30 นาทีไหนอยู่พีค/ออฟพีค จาก "เวลาเริ่ม" ของช่วงนั้น

/** "HH:MM" หรือ "HH:MM:SS" → นาทีนับจากเที่ยงคืน (ไม่มีค่า = null) */
function toMinutes(time) {
  if (!time) return null;
  const [h, m] = String(time).split(':').map(Number);
  return h * 60 + (m || 0);
}

/** ช่วง [start, end) ในหน่วยนาที — ไม่มีเวลาเริ่ม = ไม่มีช่วงนี้ / ไม่มีเวลาสิ้นสุด = ถึงเที่ยงคืน (ร้านปิด) */
function toRange(start, end) {
  const s = toMinutes(start);
  if (s === null) return null;
  return [s, toMinutes(end) ?? 24 * 60];
}

/**
 * @param {object} rates { peakStart, peakEnd, peakSurcharge, offPeakStart, offPeakEnd, offPeakDiscount } (ดู utils/rates.js)
 * @returns {{ basePrice, peakSurchargeTotal, offPeakDiscountTotal, priceTotal }}
 */
function calculateBookingPrice({ pricePerHour, rates, startDatetime, endDatetime }) {
  const start = new Date(startDatetime);
  const end = new Date(endDatetime);
  const totalMinutes = (end - start) / 60000;

  if (!Number.isFinite(totalMinutes) || totalMinutes <= 0) {
    throw new Error('เวลาสิ้นสุดต้องอยู่หลังเวลาเริ่ม');
  }
  if (totalMinutes % 30 !== 0) {
    throw new Error('ช่วงเวลาต้องเป็นทวีคูณของ 30 นาที');
  }

  const peak = toRange(rates?.peakStart, rates?.peakEnd);
  const offPeak = toRange(rates?.offPeakStart, rates?.offPeakEnd);
  const inRange = (range, minutes) => range && minutes >= range[0] && minutes < range[1];

  let peakHalfSlots = 0;
  let offPeakHalfSlots = 0;
  const cursor = new Date(start);
  for (let i = 0; i < totalMinutes / 30; i++) {
    const minutesOfDay = cursor.getHours() * 60 + cursor.getMinutes();
    if (inRange(peak, minutesOfDay)) peakHalfSlots++;
    else if (inRange(offPeak, minutesOfDay)) offPeakHalfSlots++;
    cursor.setMinutes(cursor.getMinutes() + 30);
  }

  // ส่วนลดไม่เกินราคาห้อง (กันราคาช่วงออฟพีคติดลบ)
  const discountPerHour = Math.min(Number(rates?.offPeakDiscount || 0), pricePerHour);
  const basePrice = Math.round((pricePerHour * totalMinutes) / 60);
  const peakSurchargeTotal = Math.round(Number(rates?.peakSurcharge || 0) * 0.5 * peakHalfSlots);
  const offPeakDiscountTotal = Math.round(discountPerHour * 0.5 * offPeakHalfSlots);
  const priceTotal = basePrice + peakSurchargeTotal - offPeakDiscountTotal;

  return { basePrice, peakSurchargeTotal, offPeakDiscountTotal, priceTotal };
}

module.exports = { calculateBookingPrice, toMinutes, toRange };
