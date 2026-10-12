// สูตรคิดราคาการจอง (ต้องตรงกับไฟล์ src/utils/pricing.js ฝั่งหน้าเว็บ ที่ใช้โชว์ราคาก่อนลูกค้ากดจอง)
// แบ่งเวลาที่จองเป็นช่องละ 30 นาที แต่ละช่อง:
//   - อยู่ในพีคไทม์ = ราคาห้อง + ค่าบริการเพิ่ม
//   - นอกพีคไทม์   = ราคาห้องปกติ
// ดูว่าช่องไหนเป็นพีค จาก "เวลาเริ่ม" ของช่องนั้น เช่น พีค 19:00 → ช่อง 18:30 ไม่ใช่พีค, ช่อง 19:00 เป็นพีค

/** "HH:MM" หรือ "HH:MM:SS" → จำนวนนาทีนับจากเที่ยงคืน เช่น "19:30" → 1170 (ไม่มีค่า = null) */
function toMinutes(time) {
  if (!time) return null;
  const [h, m] = String(time).split(':').map(Number);
  return h * 60 + (m || 0);
}

/** ช่วงพีคเป็นนาที [เริ่ม, สิ้นสุด) — ไม่มีเวลาเริ่ม = ไม่มีพีค / ไม่มีเวลาสิ้นสุด = ถึงเที่ยงคืน */
function toRange(start, end) {
  const s = toMinutes(start);
  if (s === null) return null;
  return [s, toMinutes(end) ?? 24 * 60];
}

/**
 * คิดราคาการจอง
 * @param pricePerHour  ราคาห้องต่อชั่วโมง
 * @param rates         พีคไทม์ของวันนั้น { peakStart, peakEnd, peakSurcharge } (ได้จาก utils/rates.js)
 * @returns {{ basePrice, peakSurchargeTotal, priceTotal }}  ราคาปกติ, ค่าพีครวม, ราคารวม
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

  // นับว่ามีกี่ช่อง (ช่องละ 30 นาที) ที่อยู่ในพีคไทม์
  const peak = toRange(rates?.peakStart, rates?.peakEnd);
  let peakHalfSlots = 0;
  const cursor = new Date(start);
  for (let i = 0; i < totalMinutes / 30; i++) {
    const minutesOfDay = cursor.getHours() * 60 + cursor.getMinutes();
    if (peak && minutesOfDay >= peak[0] && minutesOfDay < peak[1]) peakHalfSlots++;
    cursor.setMinutes(cursor.getMinutes() + 30);
  }

  const basePrice = Math.round((pricePerHour * totalMinutes) / 60);
  // ค่าพีคตั้งเป็น "บาทต่อชั่วโมง" → ช่องครึ่งชั่วโมงคิดครึ่งเดียว
  const peakSurchargeTotal = Math.round(Number(rates?.peakSurcharge || 0) * 0.5 * peakHalfSlots);
  return { basePrice, peakSurchargeTotal, priceTotal: basePrice + peakSurchargeTotal };
}

module.exports = { calculateBookingPrice, toRange };
