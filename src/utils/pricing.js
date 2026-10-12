// คำนวณราคาการจอง โดยแบ่งเป็นช่วงละ 30 นาที (สูตรเดียวกับ src/utils/pricing.js ฝั่งหน้าเว็บ ที่ใช้พรีวิวราคา)
// ช่วงพีค = ราคาห้อง + ค่าบริการเพิ่ม / นอกนั้น = ราคาห้อง — ดูว่าช่วง 30 นาทีไหนอยู่พีคจาก "เวลาเริ่ม" ของช่วงนั้น

/** "HH:MM" หรือ "HH:MM:SS" → นาทีนับจากเที่ยงคืน (ไม่มีค่า = null) */
function toMinutes(time) {
  if (!time) return null;
  const [h, m] = String(time).split(':').map(Number);
  return h * 60 + (m || 0);
}

/** ช่วงพีค [start, end) ในหน่วยนาที — ไม่มีเวลาเริ่ม = ไม่มีพีค / ไม่มีเวลาสิ้นสุด = ถึงเที่ยงคืน (ร้านปิด) */
function toRange(start, end) {
  const s = toMinutes(start);
  if (s === null) return null;
  return [s, toMinutes(end) ?? 24 * 60];
}

/**
 * @param {object} rates { peakStart, peakEnd, peakSurcharge } (ดู utils/rates.js)
 * @returns {{ basePrice, peakSurchargeTotal, priceTotal }}
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
  let peakHalfSlots = 0;
  const cursor = new Date(start);
  for (let i = 0; i < totalMinutes / 30; i++) {
    const minutesOfDay = cursor.getHours() * 60 + cursor.getMinutes();
    if (peak && minutesOfDay >= peak[0] && minutesOfDay < peak[1]) peakHalfSlots++;
    cursor.setMinutes(cursor.getMinutes() + 30);
  }

  const basePrice = Math.round((pricePerHour * totalMinutes) / 60);
  const peakSurchargeTotal = Math.round(Number(rates?.peakSurcharge || 0) * 0.5 * peakHalfSlots);
  return { basePrice, peakSurchargeTotal, priceTotal: basePrice + peakSurchargeTotal };
}

module.exports = { calculateBookingPrice, toMinutes, toRange };
