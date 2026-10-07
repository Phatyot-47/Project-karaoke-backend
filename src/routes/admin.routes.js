const router = require('express').Router();
const { pool, withTransaction } = require('../db');
const { HttpError, route } = require('../utils/http');
const { getShop } = require('../utils/shop');
const { priceRange, quoteBooking } = require('../utils/quoteBooking');
const { expireStalePendingBookings } = require('../utils/expireBookings');
const { isStartInPast } = require('../utils/time');
const { makeCode } = require('../utils/codes');
const { submittedDepositSql } = require('../utils/deposit');
const { requireAdmin } = require('../utils/auth');

// ทุก route ในไฟล์นี้ต้องล็อกอินเป็นแอดมิน — ผู้ทำรายการ (checked_in_by, verified_by ฯลฯ) = แอดมินเจ้าของ token
router.use(requireAdmin);

/* ============================================================
 * อนุมัติการจอง (หน้า "อนุมัติการจอง") + ประวัติการจอง
 * ========================================================== */

// คอลัมน์ + join ที่หน้าอนุมัติการจองและหน้าประวัติใช้ร่วมกัน: ชื่อห้อง/ลูกค้า + สลิปล่าสุด + รอบใช้บริการ
const BOOKING_LIST_COLUMNS = `
  b.*, r.room_name, r.image_url, COALESCE(u.name, b.walkin_name) AS customer_name,
  p.payment_id, p.evidence_url, p.payment_status,
  s.session_id, s.checkin_time, s.checkout_time, s.session_status, s.overtime_amount,
  ${submittedDepositSql('b')} AS paid_amount,
  (SELECT json_agg(evidence_url ORDER BY payment_id) FROM payment
   WHERE payment.booking_id = b.booking_id AND payment_status IN ('pending','paid') AND evidence_url IS NOT NULL) AS slip_urls`;
const BOOKING_LIST_JOINS = `
  FROM booking b
  JOIN room r ON r.room_id = b.room_id
  LEFT JOIN users u ON u.user_id = b.customer_id
  LEFT JOIN LATERAL (
    SELECT * FROM payment WHERE payment.booking_id = b.booking_id
    ORDER BY payment_id DESC LIMIT 1
  ) p ON true
  LEFT JOIN service_session s ON s.booking_id = b.booking_id`;

// รายได้ของ booking: ใช้บริการ/ยืนยันแล้ว = ยอดรวม, ไม่มาใช้บริการ (no-show) = มัดจำที่ร้านเก็บไว้ (ไม่คืน)
const REVENUE_STATUSES = `('confirmed','completed','no_show')`;
const REVENUE_SQL = `CASE WHEN booking_status = 'no_show' THEN deposit_required ELSE price_total END`;

// GET /api/admin/bookings/today -- การ์ดสรุป + รายการจองวันนี้
router.get('/bookings/today', route(async (req, res) => {
  await expireStalePendingBookings();
  const stats = await pool.query(`
    SELECT
      COUNT(*) FILTER (WHERE booking_status = 'pending')   AS pending_count,
      COUNT(*) FILTER (WHERE booking_status = 'confirmed') AS in_progress_count,
      COUNT(*) FILTER (WHERE booking_status = 'completed') AS completed_count,
      COALESCE(SUM(${REVENUE_SQL}) FILTER (WHERE booking_status IN ${REVENUE_STATUSES}), 0) AS revenue_today,
      (SELECT COUNT(*) FROM booking o
       WHERE o.booking_date < CURRENT_DATE AND o.booking_status IN ('pending','confirmed')
         AND NOT EXISTS (SELECT 1 FROM service_session ss WHERE ss.booking_id = o.booking_id)) AS overdue_count
    FROM booking
    WHERE booking_date = CURRENT_DATE`);
  const list = await pool.query(`
    SELECT ${BOOKING_LIST_COLUMNS},
      COALESCE(x.extend_minutes, 0) AS extended_minutes, COALESCE(x.extra_amount, 0) AS extension_amount,
      (b.booking_date < CURRENT_DATE AND s.session_id IS NULL) AS is_overdue
    ${BOOKING_LIST_JOINS}
    LEFT JOIN LATERAL (
      SELECT SUM(extend_minutes) AS extend_minutes, SUM(extra_amount) AS extra_amount
      FROM extension WHERE extension.session_id = s.session_id
    ) x ON true
    -- รอบที่ยังไม่ Check-out ให้แสดงต่อแม้เลยเที่ยงคืนไปแล้ว (เช่น ช่วง 23:30-00:00 ที่ออกช้า)
    -- และรายการที่ค้างจากวันก่อน (สลิปยังไม่ได้ตรวจ / ยืนยันแล้วแต่ไม่มา Check-in) ให้แอดมินจัดการต่อ ขึ้นก่อนเสมอ
    WHERE b.booking_date = CURRENT_DATE OR s.session_status = 'in_progress'
       OR (b.booking_date < CURRENT_DATE AND b.booking_status IN ('pending','confirmed') AND s.session_id IS NULL)
    -- ในแต่ละกลุ่ม (ค้างจากวันก่อน / วันนี้) เรียงตามเวลาที่ลูกค้ากดจอง ใหม่สุดขึ้นก่อน
    ORDER BY is_overdue DESC, b.created_at DESC, b.booking_id DESC`);
  res.json({ stats: stats.rows[0], bookings: list.rows });
}));

// GET /api/admin/bookings/history -- หน้า "ประวัติการจอง" ของแอดมิน (ทุกสถานะ)
router.get('/bookings/history', route(async (req, res) => {
  await expireStalePendingBookings();
  res.json((await pool.query(`SELECT ${BOOKING_LIST_COLUMNS} ${BOOKING_LIST_JOINS} ORDER BY b.created_at DESC`)).rows);
}));

// PATCH /api/admin/bookings/:id/confirm -- กดปุ่ม "ยืนยัน" (ยืนยันรายการที่เลยเวลาสิ้นสุดไปแล้วไม่ได้)
router.patch('/bookings/:id/confirm', route(async (req, res) => {
  const booking = (await pool.query(
    `UPDATE booking SET booking_status = 'confirmed', updated_at = now()
     WHERE booking_id = $1 AND booking_status = 'pending' AND end_datetime > LOCALTIMESTAMP
     RETURNING *`,
    [req.params.id]
  )).rows[0];
  if (!booking) throw new HttpError(404, 'ไม่พบรายการ สถานะไม่ใช่ pending หรือเลยเวลาของการจองนี้แล้ว');
  res.json(booking);
}));

// PATCH /api/admin/bookings/:id/reject  { reason } -- กดปุ่ม "ปฏิเสธ" (pending) / "ยกเลิกการจอง" (confirmed)
// ยกเลิกได้ทั้งรายการที่รอยืนยันและที่ยืนยันแล้ว แต่ต้องยังไม่ Check-in (มีรอบใช้บริการแล้วให้ Check-out แทน)
router.patch('/bookings/:id/reject', route(async (req, res) => {
  const booking = (await pool.query(
    `UPDATE booking SET booking_status = 'cancelled', cancel_reason = $2, updated_at = now()
     WHERE booking_id = $1 AND booking_status IN ('pending','confirmed')
       AND NOT EXISTS (SELECT 1 FROM service_session s WHERE s.booking_id = booking.booking_id)
     RETURNING *`,
    [req.params.id, req.body.reason || 'ไม่ระบุเหตุ']
  )).rows[0];
  if (!booking) throw new HttpError(404, 'ไม่พบรายการ หรือรายการนี้ยกเลิกไม่ได้แล้ว (Check-in แล้ว)');
  res.json(booking);
}));

// PATCH /api/admin/bookings/:id/no-show -- กดปุ่ม "ไม่มาใช้บริการ" (ขอบเขตข้อ 2.3)
// ได้เฉพาะรายการที่ยืนยันแล้ว เลยเวลาเริ่มแล้ว และยังไม่ Check-in — ปล่อยช่วงเวลาคืน มัดจำไม่คืนตามนโยบาย
router.patch('/bookings/:id/no-show', route(async (req, res) => {
  const booking = (await pool.query(
    `UPDATE booking SET booking_status = 'no_show', cancel_reason = $2, updated_at = now()
     WHERE booking_id = $1 AND booking_status = 'confirmed' AND start_datetime <= LOCALTIMESTAMP
       AND NOT EXISTS (SELECT 1 FROM service_session s WHERE s.booking_id = booking.booking_id)
     RETURNING *`,
    [req.params.id, (typeof req.body.reason === 'string' && req.body.reason.trim()) || 'ลูกค้าไม่มาใช้บริการตามเวลาที่จอง']
  )).rows[0];
  if (!booking) throw new HttpError(409, 'บันทึกไม่มาใช้บริการได้เฉพาะรายการที่ยืนยันแล้ว เลยเวลาเริ่มแล้ว และยังไม่ Check-in');
  res.json(booking);
}));

// PATCH /api/admin/bookings/:id/change-room  { roomId } -- ย้ายลูกค้าไปห้องอื่น (ช่วงเวลาเดิม ราคาเดิม)
// DB ไม่มีตารางประวัติการย้ายห้อง จึงต่อท้ายบันทึกการย้ายไว้ใน booking.note แทน
// ห้องใหม่ชนกับการจองอื่นหรือไม่ ให้ exclusion constraint (23P01) ของ booking เป็นตัวตัดสิน
router.patch('/bookings/:id/change-room', route(async (req, res) => {
  const newRoomId = Number(req.body.roomId);
  if (!Number.isInteger(newRoomId) || newRoomId <= 0) throw new HttpError(400, 'กรุณาเลือกห้องที่จะย้ายไป');
  const booking = await withTransaction(async (client) => {
    const current = (await client.query(
      `SELECT b.booking_status, b.room_id, r.room_name
       FROM booking b JOIN room r ON r.room_id = b.room_id
       WHERE b.booking_id = $1
       FOR UPDATE OF b`,
      [req.params.id]
    )).rows[0];
    if (!current || !['pending', 'confirmed'].includes(current.booking_status)) {
      throw new HttpError(404, 'ไม่พบรายการ หรือรายการนี้ย้ายห้องไม่ได้แล้ว');
    }
    if (current.room_id === newRoomId) throw new HttpError(400, 'ห้องใหม่ต้องไม่ใช่ห้องเดิม');
    const newRoom = (await client.query('SELECT room_name FROM room WHERE room_id = $1 AND is_active = true', [newRoomId])).rows[0];
    if (!newRoom) throw new HttpError(404, 'ไม่พบห้องใหม่ หรือห้องปิดให้บริการ');
    return (await client.query(
      `UPDATE booking SET
         room_id = $2,
         note = concat_ws(E'\\n', note,
           '[ย้ายห้อง ' || to_char(LOCALTIMESTAMP, 'YYYY-MM-DD HH24:MI') || '] จาก ' || $3::text || ' เป็น ' || $4::text),
         updated_at = now()
       WHERE booking_id = $1
       RETURNING *`,
      [req.params.id, newRoomId, current.room_name, newRoom.room_name]
    )).rows[0];
  });
  res.json(booking);
}, { '23P01': [409, 'ห้องใหม่ไม่ว่างในช่วงเวลานี้ กรุณาเลือกห้องอื่น'] }));

const WALKIN_MIN_MINUTES = 60; // วอล์คอินจองขั้นต่ำ 1 ชม. — ต้องตรงกับ WALKIN_MIN_SLOTS ฝั่ง frontend

// POST /api/admin/bookings/walkin -- ฟอร์ม "เพิ่มรายการจองวอล์คอิน"
router.post('/bookings/walkin', route(async (req, res) => {
  const { roomId, startDatetime, endDatetime, customerName, customerPhone } = req.body;
  if (!roomId || !startDatetime || !endDatetime) {
    throw new HttpError(400, 'ข้อมูลไม่ครบ (roomId, startDatetime, endDatetime)');
  }
  if (!((new Date(endDatetime) - new Date(startDatetime)) / 60000 >= WALKIN_MIN_MINUTES)) {
    throw new HttpError(400, 'วอล์คอินต้องจองอย่างน้อย 1 ชั่วโมง');
  }
  if (isStartInPast(startDatetime)) throw new HttpError(400, 'เวลาที่เลือกผ่านไปแล้ว กรุณาเลือกเวลาอื่น');

  await expireStalePendingBookings();
  const room = (await pool.query('SELECT * FROM room WHERE room_id = $1', [roomId])).rows[0];
  if (!room) throw new HttpError(404, 'ไม่พบห้อง');
  const q = await quoteBooking(room, startDatetime, endDatetime);

  const booking = (await pool.query(
    `INSERT INTO booking (
       booking_code, created_by, room_id, policy_id, booking_source,
       booking_date, start_datetime, end_datetime, walkin_name, walkin_phone,
       booking_status, base_price, peak_surcharge_total, price_total, deposit_required, deposit_status
     ) VALUES ($1,$2,$3,$4,'admin_walkin',$5,$6,$7,$8,$9,'confirmed',$10,$11,$12,$13,'paid')
     RETURNING *`,
    [q.bookingCode, req.user.id, roomId, q.policyId, q.bookingDate, startDatetime, endDatetime,
      customerName || 'ลูกค้าหน้าร้าน', customerPhone || null, q.basePrice, q.peakSurchargeTotal, q.priceTotal, q.depositRequired]
  )).rows[0];
  res.status(201).json(booking);
}, { '23P01': [409, 'ช่วงเวลานี้ถูกจองไปแล้ว'] }));

/* ============================================================
 * Check-in / Check-out / ต่อเวลา (ขอบเขตข้อ 2.6) — ตาราง service_session + extension
 * ========================================================== */

const CHECKIN_EARLY_MINUTES = 15;  // Check-in ได้ก่อนเวลาเริ่มไม่เกินกี่นาที
const OVERTIME_GRACE_MINUTES = 10; // ออกช้าในแต่ละช่วง 30 นาทีไม่เกินนี้ ไม่คิดเงินช่วงนั้น
const MAX_EXTEND_MINUTES = 240;

// จำนวนช่วง 30 นาทีที่ต้องคิดค่าเกินเวลา: ช่วงไหนเลยเข้าไปเกิน 10 นาทีจึงคิด
// เช่น ออกช้า 10 นาที = 0, 11 นาที = 1 ช่วง, 40 นาที = 1 ช่วง, 41 นาที = 2 ช่วง
function overtimeHalfSlots(minutesLate) {
  return minutesLate > OVERTIME_GRACE_MINUTES ? Math.ceil((minutesLate - OVERTIME_GRACE_MINUTES) / 30) : 0;
}

// เวลา + จำนวนนาที คำนวณใน DB (ได้สตริงเวลาไทย naive กลับมาตาม type parser ใน db.js)
async function addMinutes(client, timestamp, minutes) {
  return (await client.query('SELECT $1::timestamp + make_interval(mins => $2) AS t', [timestamp, minutes])).rows[0].t;
}

// ดึง booking + ห้อง + รอบใช้บริการ แล้วล็อกแถว booking ไว้ตลอด transaction
async function lockBookingWithSession(client, bookingId) {
  return (await client.query(
    `SELECT b.booking_id, b.booking_status, b.booking_date, b.start_datetime, b.end_datetime, r.price_per_hour,
            s.session_id, s.session_status,
            LOCALTIMESTAMP >= b.start_datetime - make_interval(mins => $2) AS checkin_opened,
            LOCALTIMESTAMP < b.end_datetime AS before_end,
            FLOOR(EXTRACT(EPOCH FROM (LOCALTIMESTAMP - b.end_datetime)) / 60)::int AS minutes_late
     FROM booking b
     JOIN room r ON r.room_id = b.room_id
     LEFT JOIN service_session s ON s.booking_id = b.booking_id
     WHERE b.booking_id = $1
     FOR UPDATE OF b`,
    [bookingId, CHECKIN_EARLY_MINUTES]
  )).rows[0];
}

// ล็อก booking ที่ Check-in แล้วและยังไม่ Check-out (ใช้ตอนต่อเวลา / Check-out)
async function lockActiveSession(client, bookingId, message) {
  const b = await lockBookingWithSession(client, bookingId);
  if (!b || b.session_status !== 'in_progress') throw new HttpError(409, message);
  return b;
}

// PATCH /api/admin/bookings/:id/check-in
router.patch('/bookings/:id/check-in', route(async (req, res) => {
  const session = await withTransaction(async (client) => {
    const b = await lockBookingWithSession(client, req.params.id);
    if (!b) throw new HttpError(404, 'ไม่พบรายการจอง');
    if (b.session_id) throw new HttpError(409, 'รายการนี้ Check-in ไปแล้ว');
    if (b.booking_status !== 'confirmed') throw new HttpError(409, 'ต้องยืนยันการจองก่อนจึงจะ Check-in ได้');
    if (!b.checkin_opened) throw new HttpError(409, `Check-in ได้ก่อนเวลาเริ่มไม่เกิน ${CHECKIN_EARLY_MINUTES} นาที`);
    if (!b.before_end) throw new HttpError(409, 'เลยเวลาสิ้นสุดของการจองแล้ว Check-in ไม่ได้');
    return (await client.query(
      `INSERT INTO service_session (booking_id, checkin_time, checked_in_by, session_status)
       VALUES ($1, LOCALTIMESTAMP, $2, 'in_progress')
       RETURNING *`,
      [b.booking_id, req.user.id]
    )).rows[0];
  });
  res.status(201).json(session);
}));

// PATCH /api/admin/bookings/:id/extend  { minutes } -- ต่อเวลาทีละ 30 นาที ราคาเดียวกับตอนจอง
// เลื่อน booking.end_datetime ออกไปจริง ห้องชนกับการจองถัดไปหรือไม่ให้ exclusion constraint (23P01) ตัดสิน
// และต่อได้ไม่เกินเวลาปิดร้านของวันนั้น (shop_hours.close_hour)
router.patch('/bookings/:id/extend', route(async (req, res) => {
  const minutes = Number(req.body.minutes);
  if (!Number.isInteger(minutes) || minutes <= 0 || minutes % 30 !== 0 || minutes > MAX_EXTEND_MINUTES) {
    throw new HttpError(400, `ต่อเวลาได้ทีละ 30 นาที (สูงสุด ${MAX_EXTEND_MINUTES / 60} ชม. ต่อครั้ง)`);
  }
  const extension = await withTransaction(async (client) => {
    const b = await lockActiveSession(client, req.params.id, 'ต่อเวลาได้เฉพาะรายการที่ Check-in แล้วและยังไม่ Check-out');
    const newEnd = await addMinutes(client, b.end_datetime, minutes);
    const afterClose = (await client.query(
      `SELECT $1::timestamp > ($2::date + make_interval(hours => close_hour)) AS after_close
       FROM shop_hours WHERE day_of_week = EXTRACT(DOW FROM $2::date)
       ORDER BY shop_id LIMIT 1`,
      [newEnd, b.booking_date]
    )).rows[0]?.after_close;
    if (afterClose) throw new HttpError(409, 'ต่อเวลาเกินเวลาปิดร้านไม่ได้');
    const extraAmount = (await priceRange(b, b.end_datetime, newEnd, client)).priceTotal;
    await client.query(
      `UPDATE booking SET end_datetime = $2, price_total = price_total + $3, updated_at = now()
       WHERE booking_id = $1`,
      [b.booking_id, newEnd, extraAmount]
    );
    return (await client.query(
      `INSERT INTO extension (session_id, extend_minutes, new_end_datetime, extra_amount, approved_by, created_at)
       VALUES ($1, $2, $3, $4, $5, LOCALTIMESTAMP)
       RETURNING *`,
      [b.session_id, minutes, newEnd, extraAmount, req.user.id]
    )).rows[0];
  });
  res.status(201).json(extension);
}, { '23P01': [409, 'ต่อเวลาไม่ได้ เพราะห้องนี้มีการจองถัดไปในช่วงเวลานั้นแล้ว'] }));

// PATCH /api/admin/bookings/:id/check-out
// ออกช้ากว่าเวลาสิ้นสุด คิดค่าเกินเวลาตาม overtimeHalfSlots() ด้วยราคาเดียวกับตอนจอง แล้วปิดงาน booking เป็น completed
router.patch('/bookings/:id/check-out', route(async (req, res) => {
  const result = await withTransaction(async (client) => {
    const b = await lockActiveSession(client, req.params.id, 'Check-out ได้เฉพาะรายการที่ Check-in แล้วและยังไม่ Check-out');
    const halfSlots = overtimeHalfSlots(b.minutes_late);
    const overtimeAmount = halfSlots > 0
      ? (await priceRange(b, b.end_datetime, await addMinutes(client, b.end_datetime, halfSlots * 30), client)).priceTotal
      : 0;
    const session = (await client.query(
      `UPDATE service_session SET checkout_time = LOCALTIMESTAMP, checked_out_by = $2,
         session_status = 'finished', overtime_amount = $3
       WHERE session_id = $1
       RETURNING *`,
      [b.session_id, req.user.id, overtimeAmount]
    )).rows[0];
    await client.query(
      `UPDATE booking SET booking_status = 'completed', price_total = price_total + $2, updated_at = now()
       WHERE booking_id = $1`,
      [b.booking_id, overtimeAmount]
    );
    return { ...session, minutes_late: Math.max(0, b.minutes_late) };
  });
  res.json(result);
}));

/* ============================================================
 * ตรวจสอบสลิปการชำระเงิน
 * ========================================================== */

// PATCH /api/admin/payments/:id/verify  { approve, reason }
// อนุมัติ = มัดจำ paid / ปฏิเสธ = ยกเลิกการจองทันทีพร้อมเหตุผลให้ลูกค้าเห็น และปล่อยช่วงเวลาคืน
// ตรวจได้เฉพาะสลิปที่ยังรอตรวจ กันการกดซ้ำเปลี่ยนผลที่ตัดสินไปแล้ว
router.patch('/payments/:id/verify', route(async (req, res) => {
  const { approve } = req.body;
  const reason = (typeof req.body.reason === 'string' && req.body.reason.trim()) || 'สลิปไม่ผ่านการตรวจสอบ';
  const status = approve === false ? 'rejected' : 'paid';
  const payment = await withTransaction(async (client) => {
    const verified = (await client.query(
      `UPDATE payment SET payment_status = $2::varchar, verified_by = $3, verified_at = now(),
         remark = CASE WHEN $2::varchar = 'rejected' THEN $4::text ELSE remark END
       WHERE payment_id = $1 AND payment_status = 'pending'
       RETURNING *`,
      [req.params.id, status, req.user.id, reason]
    )).rows[0];
    if (!verified) throw new HttpError(404, 'ไม่พบรายการชำระเงิน หรือสลิปนี้ตรวจไปแล้ว');
    if (status === 'paid') {
      // อนุมัติ = รับมัดจำของ booking นี้ทั้งหมด: สลิปอื่นที่ยังรอตรวจ (เช่น สลิปแรกก่อนลูกค้าแก้ไขการจอง) ผ่านไปพร้อมกัน
      await client.query(
        `UPDATE payment SET payment_status = 'paid', verified_by = $2, verified_at = now()
         WHERE booking_id = $1 AND payment_status = 'pending'`,
        [verified.booking_id, req.user.id]
      );
      // ตรวจผ่านครบยอดมัดจำแล้ว = paid / ยังมีสลิปอื่นรอตรวจ = pending_verify / ยังจ่ายไม่ครบ (แก้ไขการจองแล้วต้องจ่ายเพิ่ม) = unpaid
      await client.query(
        `UPDATE booking SET updated_at = now(), deposit_status = CASE
           WHEN (SELECT COALESCE(SUM(amount), 0) FROM payment WHERE booking_id = $1 AND payment_status = 'paid') >= deposit_required THEN 'paid'
           WHEN EXISTS (SELECT 1 FROM payment WHERE booking_id = $1 AND payment_status = 'pending') THEN 'pending_verify'
           ELSE 'unpaid' END
         WHERE booking_id = $1`,
        [verified.booking_id]
      );
    } else {
      await client.query(
        `UPDATE booking SET deposit_status = 'unpaid',
           booking_status = CASE WHEN booking_status IN ('pending','confirmed') THEN 'cancelled' ELSE booking_status END,
           cancel_reason = CASE WHEN booking_status IN ('pending','confirmed') THEN $2 ELSE cancel_reason END,
           updated_at = now()
         WHERE booking_id = $1`,
        [verified.booking_id, 'ปฏิเสธสลิป: ' + reason]
      );
    }
    return verified;
  });
  res.json(payment);
}));

/* ============================================================
 * ตั้งค่าร้าน (หน้า "ตั้งค่าร้าน")
 * ========================================================== */

// PATCH /api/admin/shop
router.patch('/shop', route(async (req, res) => {
  const { name, taxId, phone, address, bankName, bankAccountNo, bankAccountName, qrCodeUrl, peakStartTime, floorPlanUrl } = req.body;
  // ตรวจค่าพีคไทม์ก่อน — ถ้าลบช่องจนว่าง ส่ง '' ไปให้ DB แปลงเป็น time/numeric ไม่ได้ จะกลายเป็น 500
  if (peakStartTime != null && !(typeof peakStartTime === 'string' && /^([01]?\d|2[0-3]):[0-5]\d(:[0-5]\d)?$/.test(peakStartTime))) {
    throw new HttpError(400, 'เวลาเริ่มพีคไทม์ต้องเป็นรูปแบบ HH:MM เช่น 18:00');
  }
  // ช่องค่าบริการเพิ่มว่าง = ไม่คิดค่าพีค (0)
  const peakSurcharge = req.body.peakSurcharge === '' ? 0 : req.body.peakSurcharge;
  if (peakSurcharge != null && !(Number.isFinite(Number(peakSurcharge)) && Number(peakSurcharge) >= 0)) {
    throw new HttpError(400, 'ค่าบริการเพิ่มช่วงพีคต้องเป็นตัวเลขตั้งแต่ 0 ขึ้นไป');
  }
  const shop = (await pool.query(
    `UPDATE shop SET
       name = COALESCE($1, name),
       tax_id = COALESCE($2, tax_id),
       phone = COALESCE($3, phone),
       address = COALESCE($4, address),
       bank_name = COALESCE($5, bank_name),
       bank_account_no = COALESCE($6, bank_account_no),
       bank_account_name = COALESCE($7, bank_account_name),
       qr_code_url = COALESCE($8, qr_code_url),
       peak_start_time = COALESCE($9, peak_start_time),
       peak_surcharge = COALESCE($10, peak_surcharge),
       floor_plan_url = COALESCE($11, floor_plan_url),
       updated_at = now()
     WHERE shop_id = (SELECT shop_id FROM shop ORDER BY shop_id LIMIT 1)
     RETURNING *`,
    [name, taxId, phone, address, bankName, bankAccountNo, bankAccountName, qrCodeUrl, peakStartTime, peakSurcharge, floorPlanUrl]
  )).rows[0];
  if (!shop) throw new HttpError(404, 'ยังไม่ได้ตั้งค่าร้าน');
  res.json(shop);
}));

// จำนวนชั่วโมงในนโยบาย: จำนวนเต็ม 0-72 / allowBlank = ช่องว่างได้ (null)
function policyHours(value, label, allowBlank = false) {
  if (allowBlank && (value === '' || value === null || value === undefined)) return null;
  const n = Number(value);
  if (value === '' || value === null || !Number.isInteger(n) || n < 0 || n > 72) {
    throw new HttpError(400, `${label}ต้องเป็นจำนวนเต็ม 0-72 ชั่วโมง`);
  }
  return n;
}

// PATCH /api/admin/policy  { depositPercent, cancelHoursBefore, allowEditBeforeHours, refundPolicyDesc, noShowPolicyDesc }
// -- ตั้งค่านโยบายมัดจำ/ยกเลิก/แก้ไข/No-show (ขอบเขตข้อ 2.3)
// บันทึกเป็นนโยบายฉบับใหม่ (ปิดฉบับเดิมด้วย effective_to) — การจองที่ทำไปแล้วยังใช้นโยบายตอนที่จอง (booking.policy_id)
router.patch('/policy', route(async (req, res) => {
  const b = req.body;
  const depositPercent = Number(b.depositPercent);
  if (b.depositPercent === '' || !Number.isFinite(depositPercent) || depositPercent < 0 || depositPercent > 100) {
    throw new HttpError(400, 'เปอร์เซ็นต์มัดจำต้องเป็นตัวเลข 0-100');
  }
  const cancelHours = policyHours(b.cancelHoursBefore, 'ยกเลิกล่วงหน้า');
  const editHours = policyHours(b.allowEditBeforeHours, 'แก้ไขล่วงหน้า', true);
  const text = (v) => (typeof v === 'string' && v.trim() ? v.trim().slice(0, 500) : null);
  const policy = await withTransaction(async (client) => {
    await client.query('UPDATE shop_policy SET effective_to = now() WHERE effective_to IS NULL');
    return (await client.query(
      `INSERT INTO shop_policy (deposit_percent, cancel_hours_before, allow_edit_before_hours,
         refund_policy_desc, no_show_policy_desc, effective_from, updated_by)
       VALUES ($1, $2, $3, $4, $5, now(), $6)
       RETURNING *`,
      [depositPercent, cancelHours, editHours, text(b.refundPolicyDesc), text(b.noShowPolicyDesc), req.user.id]
    )).rows[0];
  });
  res.json(policy);
}));

// PATCH /api/admin/shop/hours   { hours: [{ dayOfWeek, openHour, closeHour }, ...] }
router.patch('/shop/hours', route(async (req, res) => {
  const { hours } = req.body;
  if (!Array.isArray(hours) || !hours.length) throw new HttpError(400, 'ต้องส่ง hours เป็น array');
  const saved = await withTransaction(async (client) => {
    const shop = await getShop(client);
    if (!shop) throw new HttpError(404, 'ยังไม่ได้ตั้งค่าร้าน');
    for (const h of hours) {
      await client.query(
        'UPDATE shop_hours SET open_hour = $1, close_hour = $2 WHERE shop_id = $3 AND day_of_week = $4',
        [h.openHour, h.closeHour, shop.shop_id, h.dayOfWeek]
      );
    }
    return (await client.query('SELECT * FROM shop_hours WHERE shop_id = $1 ORDER BY day_of_week', [shop.shop_id])).rows;
  });
  res.json(saved);
}));

/* ============================================================
 * ตั้งค่าห้อง (หน้า "ตั้งค่าห้อง")
 * ========================================================== */

// ตัดช่องว่างหัวท้าย + จำกัดความยาว (ข้อความที่ไม่ได้ส่งมาคงเป็น undefined → COALESCE เก็บค่าเดิม)
function trimmedText(value, maxLength, label) {
  if (typeof value !== 'string') return value;
  const text = value.trim();
  if (text.length > maxLength) throw new HttpError(400, `${label}ต้องไม่เกิน ${maxLength} ตัวอักษร`);
  return text;
}

// GET /api/admin/rooms
router.get('/rooms', route(async (req, res) => {
  res.json((await pool.query('SELECT * FROM room ORDER BY room_id')).rows);
}));

// PATCH /api/admin/rooms/:id
router.patch('/rooms/:id', route(async (req, res) => {
  const { roomName, size, capacity, pricePerHour, imageUrl, isActive } = req.body;
  const description = trimmedText(req.body.description, 300, 'หมายเหตุ');
  const theme = trimmedText(req.body.theme, 100, 'ธีมห้อง');
  const room = (await pool.query(
    `UPDATE room SET
       room_name = COALESCE($1, room_name),
       size = COALESCE($2, size),
       capacity = COALESCE($3, capacity),
       price_per_hour = COALESCE($4, price_per_hour),
       image_url = COALESCE($5, image_url),
       is_active = COALESCE($6, is_active),
       description = COALESCE($7, description),
       theme = COALESCE($8, theme)
     WHERE room_id = $9
     RETURNING *`,
    [roomName, size, capacity, pricePerHour, imageUrl, isActive, description, theme, req.params.id]
  )).rows[0];
  if (!room) throw new HttpError(404, 'ไม่พบห้อง');
  res.json(room);
}));

// POST /api/admin/rooms -- เพิ่มห้องใหม่ (ปุ่ม + ในหน้า "ตั้งค่าห้อง")
router.post('/rooms', route(async (req, res) => {
  const { roomName, size, capacity, pricePerHour, imageUrl, description, theme } = req.body;
  const shop = await getShop();
  const room = (await pool.query(
    `INSERT INTO room (shop_id, room_code, room_name, size, capacity, price_per_hour, image_url, description, theme)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
     RETURNING *`,
    [shop?.shop_id || null, makeCode('R'), roomName || 'ห้องใหม่', size || 'S', capacity || null, pricePerHour || 0,
      imageUrl || null, description || null, theme || null]
  )).rows[0];
  res.status(201).json(room);
}));

// DELETE /api/admin/rooms/:id -- ลบห้อง (ห้องที่มีประวัติการจองผูกอยู่ลบไม่ได้ ให้ปิดให้บริการแทน)
router.delete('/rooms/:id', route(async (req, res) => {
  const room = (await pool.query('DELETE FROM room WHERE room_id = $1 RETURNING *', [req.params.id])).rows[0];
  if (!room) throw new HttpError(404, 'ไม่พบห้อง');
  res.json(room);
}, { '23503': [409, 'ลบห้องนี้ไม่ได้ เนื่องจากมีประวัติการจองผูกอยู่กับห้องนี้แล้ว'] }));

/* ============================================================
 * รายงาน (หน้า "รายงาน" รายวัน/รายสัปดาห์/รายเดือน)
 * ========================================================== */

// ช่วงข้อมูลของแต่ละ period — ต้องตรงกับ RANGE_LABEL ในหน้ารายงานฝั่ง frontend (AdminReportsPage)
const REPORT_RANGE_START = {
  day: `CURRENT_DATE - 6`,                                                  // 7 วันล่าสุด (รวมวันนี้)
  week: `date_trunc('week', CURRENT_DATE)::date - 21`,                      // 4 สัปดาห์ล่าสุด (รวมสัปดาห์นี้)
  month: `(date_trunc('month', CURRENT_DATE) - interval '5 months')::date`, // 6 เดือนล่าสุด (รวมเดือนนี้)
};

// GET /api/admin/reports?period=day|week|month
router.get('/reports', route(async (req, res) => {
  const period = ['day', 'week', 'month'].includes(req.query.period) ? req.query.period : 'day';
  const inRange = `booking_status IN ${REVENUE_STATUSES} AND booking_date >= ${REPORT_RANGE_START[period]}`;
  const trend = await pool.query(
    `SELECT date_trunc($1, booking_date::timestamp) AS period, SUM(${REVENUE_SQL}) AS revenue, COUNT(*) AS bookings
     FROM booking WHERE ${inRange}
     GROUP BY 1 ORDER BY 1`,
    [period]
  );
  const byRoom = await pool.query(`
    SELECT r.room_name, SUM(${REVENUE_SQL}) AS revenue, COUNT(*) AS bookings
    FROM booking b JOIN room r ON r.room_id = b.room_id
    WHERE ${inRange}
    GROUP BY r.room_name
    ORDER BY revenue DESC`);
  const totals = await pool.query(`
    SELECT COALESCE(SUM(${REVENUE_SQL}),0) AS total_revenue,
           COUNT(*) AS total_bookings,
           COALESCE(ROUND(AVG(${REVENUE_SQL}),2),0) AS avg_ticket
    FROM booking WHERE ${inRange}`);
  res.json({ period, trend: trend.rows, byRoom: byRoom.rows, totals: totals.rows[0] });
}));

module.exports = router;
