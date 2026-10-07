const router = require('express').Router();
const pool = require('../db');
const { calculateBookingPrice } = require('../utils/pricing');
const { expireStalePendingBookings } = require('../utils/expireBookings');
const { isStartInPast } = require('../utils/time');
const { makeCode } = require('../utils/codes');

/* ============================================================
 * อนุมัติการจอง (หน้า "อนุมัติการจอง")
 * ========================================================== */

// GET /api/admin/bookings/today -- การ์ดสรุป + รายการจองวันนี้
router.get('/bookings/today', async (req, res, next) => {
  try {
    await expireStalePendingBookings();
    const stats = await pool.query(`
      SELECT
        COUNT(*) FILTER (WHERE booking_status = 'pending')   AS pending_count,
        COUNT(*) FILTER (WHERE booking_status = 'confirmed') AS in_progress_count,
        COUNT(*) FILTER (WHERE booking_status = 'completed') AS completed_count,
        COALESCE(SUM(price_total) FILTER (WHERE booking_status IN ('confirmed','completed')), 0) AS revenue_today,
        (SELECT COUNT(*) FROM booking o
         WHERE o.booking_date < CURRENT_DATE AND o.booking_status IN ('pending','confirmed')
           AND NOT EXISTS (SELECT 1 FROM service_session ss WHERE ss.booking_id = o.booking_id)) AS overdue_count
      FROM booking
      WHERE booking_date = CURRENT_DATE`);
    const list = await pool.query(`
      SELECT b.*, r.room_name, r.image_url, COALESCE(u.name, b.walkin_name) AS customer_name,
        p.payment_id, p.evidence_url, p.payment_status,
        s.session_id, s.checkin_time, s.checkout_time, s.session_status, s.overtime_amount,
        COALESCE(x.extend_minutes, 0) AS extended_minutes, COALESCE(x.extra_amount, 0) AS extension_amount,
        (b.booking_date < CURRENT_DATE AND s.session_id IS NULL) AS is_overdue
      FROM booking b
      JOIN room r ON r.room_id = b.room_id
      LEFT JOIN users u ON u.user_id = b.customer_id
      LEFT JOIN LATERAL (
        SELECT * FROM payment WHERE payment.booking_id = b.booking_id
        ORDER BY payment_id DESC LIMIT 1
      ) p ON true
      LEFT JOIN service_session s ON s.booking_id = b.booking_id
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
  } catch (err) {
    next(err);
  }
});

// PATCH /api/admin/bookings/:id/confirm -- กดปุ่ม "ยืนยัน" (ยืนยันรายการที่เลยเวลาสิ้นสุดไปแล้วไม่ได้)
router.patch('/bookings/:id/confirm', async (req, res, next) => {
  try {
    const result = await pool.query(
      `UPDATE booking SET booking_status = 'confirmed', updated_at = now()
       WHERE booking_id = $1 AND booking_status = 'pending' AND end_datetime > LOCALTIMESTAMP
       RETURNING *`,
      [req.params.id]
    );
    if (!result.rows.length) return res.status(404).json({ error: 'ไม่พบรายการ สถานะไม่ใช่ pending หรือเลยเวลาของการจองนี้แล้ว' });
    res.json(result.rows[0]);
  } catch (err) {
    next(err);
  }
});

// PATCH /api/admin/bookings/:id/reject  { reason } -- กดปุ่ม "ปฏิเสธ" (pending) / "ยกเลิกการจอง" (confirmed)
// ยกเลิกได้ทั้งรายการที่รอยืนยันและที่ยืนยันแล้ว แต่ต้องยังไม่ Check-in (มีรอบใช้บริการแล้วให้ Check-out แทน)
router.patch('/bookings/:id/reject', async (req, res, next) => {
  try {
    const result = await pool.query(
      `UPDATE booking SET booking_status = 'cancelled', cancel_reason = $2, updated_at = now()
       WHERE booking_id = $1 AND booking_status IN ('pending','confirmed')
         AND NOT EXISTS (SELECT 1 FROM service_session s WHERE s.booking_id = booking.booking_id)
       RETURNING *`,
      [req.params.id, req.body.reason || 'ไม่ระบุเหตุ']
    );
    if (!result.rows.length) return res.status(404).json({ error: 'ไม่พบรายการ หรือรายการนี้ยกเลิกไม่ได้แล้ว (Check-in แล้ว)' });
    res.json(result.rows[0]);
  } catch (err) {
    next(err);
  }
});

// PATCH /api/admin/bookings/:id/change-room  { roomId } -- ย้ายลูกค้าไปห้องอื่น (ช่วงเวลาเดิม ราคาเดิม)
// DB ไม่มีตารางประวัติการย้ายห้อง จึงต่อท้ายบันทึกการย้ายไว้ใน booking.note แทน
// ห้องใหม่ชนกับการจองอื่นหรือไม่ ให้ exclusion constraint (23P01) ของ booking เป็นตัวตัดสิน
router.patch('/bookings/:id/change-room', async (req, res, next) => {
  const newRoomId = Number(req.body.roomId);
  if (!Number.isInteger(newRoomId) || newRoomId <= 0) {
    return res.status(400).json({ error: 'กรุณาเลือกห้องที่จะย้ายไป' });
  }
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const found = await client.query(
      `SELECT b.booking_status, b.room_id, r.room_name
       FROM booking b JOIN room r ON r.room_id = b.room_id
       WHERE b.booking_id = $1
       FOR UPDATE OF b`,
      [req.params.id]
    );
    const booking = found.rows[0];
    if (!booking || !['pending', 'confirmed'].includes(booking.booking_status)) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'ไม่พบรายการ หรือรายการนี้ย้ายห้องไม่ได้แล้ว' });
    }
    if (booking.room_id === newRoomId) {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: 'ห้องใหม่ต้องไม่ใช่ห้องเดิม' });
    }
    const newRoom = (await client.query('SELECT room_name FROM room WHERE room_id = $1 AND is_active = true', [newRoomId])).rows[0];
    if (!newRoom) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'ไม่พบห้องใหม่ หรือห้องปิดให้บริการ' });
    }
    const result = await client.query(
      `UPDATE booking SET
         room_id = $2,
         note = concat_ws(E'\\n', note,
           '[ย้ายห้อง ' || to_char(LOCALTIMESTAMP, 'YYYY-MM-DD HH24:MI') || '] จาก ' || $3::text || ' เป็น ' || $4::text),
         updated_at = now()
       WHERE booking_id = $1
       RETURNING *`,
      [req.params.id, newRoomId, booking.room_name, newRoom.room_name]
    );
    await client.query('COMMIT');
    res.json(result.rows[0]);
  } catch (err) {
    await client.query('ROLLBACK');
    if (err.code === '23P01') {
      return res.status(409).json({ error: 'ห้องใหม่ไม่ว่างในช่วงเวลานี้ กรุณาเลือกห้องอื่น' });
    }
    next(err);
  } finally {
    client.release();
  }
});

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

// ราคาของช่วงเวลาเพิ่ม (ต่อเวลา/เกินเวลา) — สูตรเดียวกับตอนจอง รวมค่าพีคไทม์
async function priceForRange(client, pricePerHour, startDatetime, endDatetime) {
  const shop = (await client.query('SELECT peak_start_time, peak_surcharge FROM shop ORDER BY shop_id LIMIT 1')).rows[0];
  return calculateBookingPrice({
    pricePerHour: Number(pricePerHour),
    peakStartTime: shop?.peak_start_time,
    peakSurcharge: Number(shop?.peak_surcharge || 0),
    startDatetime,
    endDatetime,
  }).priceTotal;
}

// ดึง booking + ห้อง + รอบใช้บริการ แล้วล็อกแถว booking ไว้ตลอด transaction
async function lockBookingWithSession(client, bookingId) {
  const result = await client.query(
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
  );
  return result.rows[0];
}

// PATCH /api/admin/bookings/:id/check-in  { adminUserId }
router.patch('/bookings/:id/check-in', async (req, res, next) => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const b = await lockBookingWithSession(client, req.params.id);
    let error = null;
    if (!b) error = [404, 'ไม่พบรายการจอง'];
    else if (b.session_id) error = [409, 'รายการนี้ Check-in ไปแล้ว'];
    else if (b.booking_status !== 'confirmed') error = [409, 'ต้องยืนยันการจองก่อนจึงจะ Check-in ได้'];
    else if (!b.checkin_opened) error = [409, `Check-in ได้ก่อนเวลาเริ่มไม่เกิน ${CHECKIN_EARLY_MINUTES} นาที`];
    else if (!b.before_end) error = [409, 'เลยเวลาสิ้นสุดของการจองแล้ว Check-in ไม่ได้'];
    if (error) {
      await client.query('ROLLBACK');
      return res.status(error[0]).json({ error: error[1] });
    }
    const session = await client.query(
      `INSERT INTO service_session (booking_id, checkin_time, checked_in_by, session_status)
       VALUES ($1, LOCALTIMESTAMP, $2, 'in_progress')
       RETURNING *`,
      [b.booking_id, req.body.adminUserId || null]
    );
    await client.query('COMMIT');
    res.status(201).json(session.rows[0]);
  } catch (err) {
    await client.query('ROLLBACK');
    next(err);
  } finally {
    client.release();
  }
});

// PATCH /api/admin/bookings/:id/extend  { minutes, adminUserId } -- ต่อเวลาทีละ 30 นาที ราคาเดียวกับตอนจอง
// เลื่อน booking.end_datetime ออกไปจริง ห้องชนกับการจองถัดไปหรือไม่ให้ exclusion constraint (23P01) ตัดสิน
// และต่อได้ไม่เกินเวลาปิดร้านของวันนั้น (shop_hours.close_hour)
router.patch('/bookings/:id/extend', async (req, res, next) => {
  const minutes = Number(req.body.minutes);
  if (!Number.isInteger(minutes) || minutes <= 0 || minutes % 30 !== 0 || minutes > MAX_EXTEND_MINUTES) {
    return res.status(400).json({ error: `ต่อเวลาได้ทีละ 30 นาที (สูงสุด ${MAX_EXTEND_MINUTES / 60} ชม. ต่อครั้ง)` });
  }
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const b = await lockBookingWithSession(client, req.params.id);
    if (!b || b.session_status !== 'in_progress') {
      await client.query('ROLLBACK');
      return res.status(409).json({ error: 'ต่อเวลาได้เฉพาะรายการที่ Check-in แล้วและยังไม่ Check-out' });
    }
    const limits = (await client.query(
      `SELECT ($1::timestamp + make_interval(mins => $2)) AS new_end,
              ($1::timestamp + make_interval(mins => $2)) > ($3::date + make_interval(hours => h.close_hour)) AS after_close
       FROM shop_hours h
       WHERE h.day_of_week = EXTRACT(DOW FROM $3::date)
       ORDER BY h.shop_id LIMIT 1`,
      [b.end_datetime, minutes, b.booking_date]
    )).rows[0];
    if (limits && limits.after_close) {
      await client.query('ROLLBACK');
      return res.status(409).json({ error: 'ต่อเวลาเกินเวลาปิดร้านไม่ได้' });
    }
    const newEnd = limits ? limits.new_end
      : (await client.query('SELECT $1::timestamp + make_interval(mins => $2) AS t', [b.end_datetime, minutes])).rows[0].t;
    const extraAmount = await priceForRange(client, b.price_per_hour, b.end_datetime, newEnd);
    await client.query(
      `UPDATE booking SET end_datetime = $2, price_total = price_total + $3, updated_at = now()
       WHERE booking_id = $1`,
      [b.booking_id, newEnd, extraAmount]
    );
    const ext = await client.query(
      `INSERT INTO extension (session_id, extend_minutes, new_end_datetime, extra_amount, approved_by, created_at)
       VALUES ($1, $2, $3, $4, $5, LOCALTIMESTAMP)
       RETURNING *`,
      [b.session_id, minutes, newEnd, extraAmount, req.body.adminUserId || null]
    );
    await client.query('COMMIT');
    res.status(201).json(ext.rows[0]);
  } catch (err) {
    await client.query('ROLLBACK');
    if (err.code === '23P01') {
      return res.status(409).json({ error: 'ต่อเวลาไม่ได้ เพราะห้องนี้มีการจองถัดไปในช่วงเวลานั้นแล้ว' });
    }
    next(err);
  } finally {
    client.release();
  }
});

// PATCH /api/admin/bookings/:id/check-out  { adminUserId }
// ออกช้ากว่าเวลาสิ้นสุด คิดค่าเกินเวลาตาม overtimeHalfSlots() ด้วยราคาเดียวกับตอนจอง แล้วปิดงาน booking เป็น completed
router.patch('/bookings/:id/check-out', async (req, res, next) => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const b = await lockBookingWithSession(client, req.params.id);
    if (!b || b.session_status !== 'in_progress') {
      await client.query('ROLLBACK');
      return res.status(409).json({ error: 'Check-out ได้เฉพาะรายการที่ Check-in แล้วและยังไม่ Check-out' });
    }
    const halfSlots = overtimeHalfSlots(b.minutes_late);
    let overtimeAmount = 0;
    if (halfSlots > 0) {
      const overtimeEnd = (await client.query(
        'SELECT $1::timestamp + make_interval(mins => $2) AS t', [b.end_datetime, halfSlots * 30]
      )).rows[0].t;
      overtimeAmount = await priceForRange(client, b.price_per_hour, b.end_datetime, overtimeEnd);
    }
    const session = await client.query(
      `UPDATE service_session SET checkout_time = LOCALTIMESTAMP, checked_out_by = $2,
         session_status = 'finished', overtime_amount = $3
       WHERE session_id = $1
       RETURNING *`,
      [b.session_id, req.body.adminUserId || null, overtimeAmount]
    );
    await client.query(
      `UPDATE booking SET booking_status = 'completed', price_total = price_total + $2, updated_at = now()
       WHERE booking_id = $1`,
      [b.booking_id, overtimeAmount]
    );
    await client.query('COMMIT');
    res.json({ ...session.rows[0], minutes_late: Math.max(0, b.minutes_late) });
  } catch (err) {
    await client.query('ROLLBACK');
    next(err);
  } finally {
    client.release();
  }
});

const WALKIN_MIN_MINUTES = 60; // วอล์คอินจองขั้นต่ำ 1 ชม. — ต้องตรงกับ WALKIN_MIN_SLOTS ฝั่ง frontend

// POST /api/admin/bookings/walkin -- ฟอร์ม "เพิ่มรายการจองวอล์คอิน"
router.post('/bookings/walkin', async (req, res, next) => {
  const { roomId, startDatetime, endDatetime, customerName, customerPhone, adminUserId } = req.body;
  if (!roomId || !startDatetime || !endDatetime) {
    return res.status(400).json({ error: 'ข้อมูลไม่ครบ (roomId, startDatetime, endDatetime)' });
  }
  if (!((new Date(endDatetime) - new Date(startDatetime)) / 60000 >= WALKIN_MIN_MINUTES)) {
    return res.status(400).json({ error: 'วอล์คอินต้องจองอย่างน้อย 1 ชั่วโมง' });
  }
  if (isStartInPast(startDatetime)) {
    return res.status(400).json({ error: 'เวลาที่เลือกผ่านไปแล้ว กรุณาเลือกเวลาอื่น' });
  }
  try {
    await expireStalePendingBookings();
    const roomResult = await pool.query('SELECT * FROM room WHERE room_id = $1', [roomId]);
    if (!roomResult.rows.length) return res.status(404).json({ error: 'ไม่พบห้อง' });
    const room = roomResult.rows[0];

    const shop = (await pool.query('SELECT * FROM shop ORDER BY shop_id LIMIT 1')).rows[0];
    const policy = (await pool.query('SELECT * FROM shop_policy ORDER BY effective_from DESC LIMIT 1')).rows[0];

    const { basePrice, peakSurchargeTotal, priceTotal } = calculateBookingPrice({
      pricePerHour: Number(room.price_per_hour),
      peakStartTime: shop.peak_start_time,
      peakSurcharge: Number(shop.peak_surcharge || 0),
      startDatetime,
      endDatetime,
    });
    const depositRequired = Math.round((priceTotal * Number(policy.deposit_percent)) / 100);
    const bookingDate = startDatetime.slice(0, 10);
    const bookingCode = makeCode('BK');

    const result = await pool.query(
      `INSERT INTO booking (
         booking_code, created_by, room_id, policy_id, booking_source,
         booking_date, start_datetime, end_datetime, walkin_name, walkin_phone,
         booking_status, base_price, peak_surcharge_total, price_total, deposit_required, deposit_status
       ) VALUES ($1,$2,$3,$4,'admin_walkin',$5,$6,$7,$8,$9,'confirmed',$10,$11,$12,$13,'paid')
       RETURNING *`,
      [bookingCode, adminUserId || null, roomId, policy.policy_id, bookingDate, startDatetime, endDatetime,
        customerName || 'ลูกค้าหน้าร้าน', customerPhone || null, basePrice, peakSurchargeTotal, priceTotal, depositRequired]
    );
    res.status(201).json(result.rows[0]);
  } catch (err) {
    if (err.code === '23P01') {
      return res.status(409).json({ error: 'ช่วงเวลานี้ถูกจองไปแล้ว' });
    }
    next(err);
  }
});

// GET /api/admin/bookings/history -- หน้า "ประวัติการจอง" ของแอดมิน (ทุกสถานะ)
router.get('/bookings/history', async (req, res, next) => {
  try {
    await expireStalePendingBookings();
    const result = await pool.query(`
      SELECT b.*, r.room_name, r.image_url, COALESCE(u.name, b.walkin_name) AS customer_name,
        p.payment_id, p.evidence_url, p.payment_status,
        s.session_status, s.checkin_time, s.checkout_time
      FROM booking b
      JOIN room r ON r.room_id = b.room_id
      LEFT JOIN users u ON u.user_id = b.customer_id
      LEFT JOIN LATERAL (
        SELECT * FROM payment WHERE payment.booking_id = b.booking_id
        ORDER BY payment_id DESC LIMIT 1
      ) p ON true
      LEFT JOIN service_session s ON s.booking_id = b.booking_id
      ORDER BY b.created_at DESC`);
    res.json(result.rows);
  } catch (err) {
    next(err);
  }
});

/* ============================================================
 * ตรวจสอบสลิปการชำระเงิน
 * ========================================================== */

// PATCH /api/admin/payments/:id/verify  { adminUserId, approve, reason }
// อนุมัติ = มัดจำ paid / ปฏิเสธ = ยกเลิกการจองทันทีพร้อมเหตุผลให้ลูกค้าเห็น และปล่อยช่วงเวลาคืน
// (เดิมปฏิเสธแล้วแค่ตั้ง deposit เป็น unpaid ทำให้ระบบหมดเวลาชำระยกเลิกให้เองแบบเงียบๆ และลูกค้าแนบสลิปใหม่ไม่ได้อยู่แล้ว)
// ตรวจได้เฉพาะสลิปที่ยังรอตรวจ กันการกดซ้ำเปลี่ยนผลที่ตัดสินไปแล้ว
router.patch('/payments/:id/verify', async (req, res, next) => {
  const { adminUserId, approve } = req.body;
  const reason = (typeof req.body.reason === 'string' && req.body.reason.trim()) || 'สลิปไม่ผ่านการตรวจสอบ';
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const status = approve === false ? 'rejected' : 'paid';
    const payResult = await client.query(
      `UPDATE payment SET payment_status = $2::varchar, verified_by = $3, verified_at = now(),
         remark = CASE WHEN $2::varchar = 'rejected' THEN $4::text ELSE remark END
       WHERE payment_id = $1 AND payment_status = 'pending'
       RETURNING *`,
      [req.params.id, status, adminUserId || null, reason]
    );
    if (!payResult.rows.length) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'ไม่พบรายการชำระเงิน หรือสลิปนี้ตรวจไปแล้ว' });
    }
    const bookingId = payResult.rows[0].booking_id;
    if (status === 'paid') {
      await client.query(
        `UPDATE booking SET deposit_status = 'paid', updated_at = now() WHERE booking_id = $1`,
        [bookingId]
      );
    } else {
      await client.query(
        `UPDATE booking SET deposit_status = 'unpaid',
           booking_status = CASE WHEN booking_status IN ('pending','confirmed') THEN 'cancelled' ELSE booking_status END,
           cancel_reason = CASE WHEN booking_status IN ('pending','confirmed') THEN $2 ELSE cancel_reason END,
           updated_at = now()
         WHERE booking_id = $1`,
        [bookingId, 'ปฏิเสธสลิป: ' + reason]
      );
    }
    await client.query('COMMIT');
    res.json(payResult.rows[0]);
  } catch (err) {
    await client.query('ROLLBACK');
    next(err);
  } finally {
    client.release();
  }
});

/* ============================================================
 * ตั้งค่าร้าน (หน้า "ตั้งค่าร้าน")
 * ========================================================== */

// GET /api/admin/shop
router.get('/shop', async (req, res, next) => {
  try {
    const shop = await pool.query('SELECT * FROM shop ORDER BY shop_id LIMIT 1');
    const hours = await pool.query('SELECT * FROM shop_hours ORDER BY day_of_week');
    if (!shop.rows.length) return res.status(404).json({ error: 'ยังไม่ได้ตั้งค่าร้าน' });
    res.json({ ...shop.rows[0], hours: hours.rows });
  } catch (err) {
    next(err);
  }
});

// PATCH /api/admin/shop
router.patch('/shop', async (req, res, next) => {
  const { name, taxId, phone, address, bankName, bankAccountNo, bankAccountName, qrCodeUrl, peakStartTime, floorPlanUrl } = req.body;
  // ตรวจค่าพีคไทม์ก่อน — เดิมถ้าลบช่องจนว่าง ส่ง '' ไปให้ DB แปลงเป็น time/numeric ไม่ได้ กลายเป็น 500
  if (peakStartTime != null && !(typeof peakStartTime === 'string' && /^([01]?\d|2[0-3]):[0-5]\d(:[0-5]\d)?$/.test(peakStartTime))) {
    return res.status(400).json({ error: 'เวลาเริ่มพีคไทม์ต้องเป็นรูปแบบ HH:MM เช่น 18:00' });
  }
  // ช่องค่าบริการเพิ่มว่าง = ไม่คิดค่าพีค (0)
  const peakSurcharge = req.body.peakSurcharge === '' ? 0 : req.body.peakSurcharge;
  if (peakSurcharge != null && !(Number.isFinite(Number(peakSurcharge)) && Number(peakSurcharge) >= 0)) {
    return res.status(400).json({ error: 'ค่าบริการเพิ่มช่วงพีคต้องเป็นตัวเลขตั้งแต่ 0 ขึ้นไป' });
  }
  try {
    const result = await pool.query(
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
    );
    if (!result.rows.length) return res.status(404).json({ error: 'ยังไม่ได้ตั้งค่าร้าน' });
    res.json(result.rows[0]);
  } catch (err) {
    next(err);
  }
});

// PATCH /api/admin/shop/hours   { hours: [{ dayOfWeek, openHour, closeHour }, ...] }
router.patch('/shop/hours', async (req, res, next) => {
  const { hours } = req.body;
  if (!Array.isArray(hours) || !hours.length) {
    return res.status(400).json({ error: 'ต้องส่ง hours เป็น array' });
  }
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const shopRow = await client.query('SELECT shop_id FROM shop ORDER BY shop_id LIMIT 1');
    if (!shopRow.rows.length) throw new Error('ยังไม่ได้ตั้งค่าร้าน');
    const shopId = shopRow.rows[0].shop_id;
    for (const h of hours) {
      await client.query(
        `UPDATE shop_hours SET open_hour = $1, close_hour = $2
         WHERE shop_id = $3 AND day_of_week = $4`,
        [h.openHour, h.closeHour, shopId, h.dayOfWeek]
      );
    }
    const result = await client.query('SELECT * FROM shop_hours WHERE shop_id = $1 ORDER BY day_of_week', [shopId]);
    await client.query('COMMIT');
    res.json(result.rows);
  } catch (err) {
    await client.query('ROLLBACK');
    next(err);
  } finally {
    client.release();
  }
});

/* ============================================================
 * ตั้งค่าห้อง (หน้า "ตั้งค่าห้อง")
 * ========================================================== */

// GET /api/admin/rooms
router.get('/rooms', async (req, res, next) => {
  try {
    const result = await pool.query('SELECT * FROM room ORDER BY room_id');
    res.json(result.rows);
  } catch (err) {
    next(err);
  }
});

// PATCH /api/admin/rooms/:id
router.patch('/rooms/:id', async (req, res, next) => {
  const { roomName, size, capacity, pricePerHour, imageUrl, isActive } = req.body;
  let { description, theme } = req.body;
  if (typeof description === 'string') {
    description = description.trim();
    if (description.length > 300) {
      return res.status(400).json({ error: 'หมายเหตุต้องไม่เกิน 300 ตัวอักษร' });
    }
  }
  if (typeof theme === 'string') {
    theme = theme.trim();
    if (theme.length > 100) {
      return res.status(400).json({ error: 'ธีมห้องต้องไม่เกิน 100 ตัวอักษร' });
    }
  }
  try {
    const result = await pool.query(
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
    );
    if (!result.rows.length) return res.status(404).json({ error: 'ไม่พบห้อง' });
    res.json(result.rows[0]);
  } catch (err) {
    next(err);
  }
});

// POST /api/admin/rooms -- เพิ่มห้องใหม่ (ปุ่ม + ในหน้า "ตั้งค่าห้อง")
router.post('/rooms', async (req, res, next) => {
  const { roomName, size, capacity, pricePerHour, imageUrl, description, theme } = req.body;
  try {
    const shop = (await pool.query('SELECT shop_id FROM shop ORDER BY shop_id LIMIT 1')).rows[0];
    const roomCode = makeCode('R');
    const result = await pool.query(
      `INSERT INTO room (shop_id, room_code, room_name, size, capacity, price_per_hour, image_url, description, theme)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
       RETURNING *`,
      [shop?.shop_id || null, roomCode, roomName || 'ห้องใหม่', size || 'S', capacity || null, pricePerHour || 0, imageUrl || null, description || null, theme || null]
    );
    res.status(201).json(result.rows[0]);
  } catch (err) {
    next(err);
  }
});

// DELETE /api/admin/rooms/:id -- ลบห้อง (แทนที่การปิดใช้งานห้องในหน้า "ตั้งค่าห้อง")
router.delete('/rooms/:id', async (req, res, next) => {
  try {
    const result = await pool.query('DELETE FROM room WHERE room_id = $1 RETURNING *', [req.params.id]);
    if (!result.rows.length) return res.status(404).json({ error: 'ไม่พบห้อง' });
    res.json(result.rows[0]);
  } catch (err) {
    if (err.code === '23503') {
      return res.status(409).json({ error: 'ลบห้องนี้ไม่ได้ เนื่องจากมีประวัติการจองผูกอยู่กับห้องนี้แล้ว' });
    }
    next(err);
  }
});

/* ============================================================
 * รายงาน (หน้า "รายงาน" รายวัน/รายสัปดาห์/รายเดือน)
 * ========================================================== */

// ช่วงข้อมูลของแต่ละ period — ต้องตรงกับ RANGE_LABEL ในหน้ารายงานฝั่ง frontend (AdminReportsPage)
const REPORT_RANGE_START = {
  day: `CURRENT_DATE - 6`,                                             // 7 วันล่าสุด (รวมวันนี้)
  week: `date_trunc('week', CURRENT_DATE)::date - 21`,                 // 4 สัปดาห์ล่าสุด (รวมสัปดาห์นี้)
  month: `(date_trunc('month', CURRENT_DATE) - interval '5 months')::date`, // 6 เดือนล่าสุด (รวมเดือนนี้)
};

// GET /api/admin/reports?period=day|week|month
router.get('/reports', async (req, res, next) => {
  const period = ['day', 'week', 'month'].includes(req.query.period) ? req.query.period : 'day';
  const inRange = `booking_status IN ('confirmed','completed') AND booking_date >= ${REPORT_RANGE_START[period]}`;
  try {
    const trend = await pool.query(
      `SELECT date_trunc($1, booking_date::timestamp) AS period, SUM(price_total) AS revenue, COUNT(*) AS bookings
       FROM booking
       WHERE ${inRange}
       GROUP BY 1 ORDER BY 1`,
      [period]
    );
    const byRoom = await pool.query(`
      SELECT r.room_name, SUM(b.price_total) AS revenue, COUNT(*) AS bookings
      FROM booking b JOIN room r ON r.room_id = b.room_id
      WHERE ${inRange}
      GROUP BY r.room_name
      ORDER BY revenue DESC`);
    const totals = await pool.query(`
      SELECT COALESCE(SUM(price_total),0) AS total_revenue,
             COUNT(*) AS total_bookings,
             COALESCE(ROUND(AVG(price_total),2),0) AS avg_ticket
      FROM booking
      WHERE ${inRange}`);
    res.json({ period, trend: trend.rows, byRoom: byRoom.rows, totals: totals.rows[0] });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
