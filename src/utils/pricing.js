/**
 * คำนวณราคาการจอง โดยแบ่งเป็นช่วงละ 30 นาที
 * ช่วงไหนที่เวลาเริ่มของ half-slot ตกอยู่หลัง (หรือเท่ากับ) peakStartTime ถือว่าเป็นพีคไทม์
 *   totalPrice = price * normalHalfSlots * 0.5 + (price + surcharge) * peakHalfSlots * 0.5
 */
function calculateBookingPrice({ pricePerHour, peakStartTime, peakSurcharge, startDatetime, endDatetime }) {
  const start = new Date(startDatetime);
  const end = new Date(endDatetime);
  const totalMinutes = (end - start) / 60000;

  if (!Number.isFinite(totalMinutes) || totalMinutes <= 0) {
    throw new Error('เวลาสิ้นสุดต้องอยู่หลังเวลาเริ่ม');
  }
  if (totalMinutes % 30 !== 0) {
    throw new Error('ช่วงเวลาต้องเป็นทวีคูณของ 30 นาที');
  }

  const totalHalfSlots = totalMinutes / 30;
  const totalHours = totalMinutes / 60;

  const [peakH, peakM] = (peakStartTime || '24:00').split(':').map(Number);
  const peakStartMinutesOfDay = peakH * 60 + (peakM || 0);

  let peakHalfSlots = 0;
  const cursor = new Date(start);
  for (let i = 0; i < totalHalfSlots; i++) {
    const minutesOfDay = cursor.getHours() * 60 + cursor.getMinutes();
    if (minutesOfDay >= peakStartMinutesOfDay) peakHalfSlots++;
    cursor.setMinutes(cursor.getMinutes() + 30);
  }

  const basePrice = Math.round(pricePerHour * totalHours);
  const peakSurchargeTotal = Math.round((peakSurcharge || 0) * 0.5 * peakHalfSlots);
  const priceTotal = basePrice + peakSurchargeTotal;

  return { basePrice, peakSurchargeTotal, priceTotal };
}

module.exports = { calculateBookingPrice };
