const router = require('express').Router();
const pool = require('../db');
const { calculateBookingPrice } = require('../utils/pricing');
const { expireStalePendingBookings } = require('../utils/expireBookings');
const { isStartInPast } = require('../utils/time');

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
        COALESCE(SUM(price_total) FILTER (
          WHERE booking_status IN ('confirmed','completed') AND booking_date = CURRENT_DATE
        ), 0) AS revenue_today
      FROM booking`);
    const list = await pool.query(`
      SELECT b.*, r.room_name, r.image_url, COALESCE(u.name, b.walkin_name) AS customer_name,
        p.payment_id, p.evidence_url, p.payment_status
      FROM booking b
      JOIN room r ON r.room_id = b.room_id
      LEFT JOIN users u ON u.user_id = b.customer_id
      LEFT JOIN LATERAL (
        SELECT * FROM payment WHERE payment.booking_id = b.booking_id
        ORDER BY payment_id DESC LIMIT 1
      ) p ON true
      WHERE b.booking_date = CURRENT_DATE
      ORDER BY b.start_datetime`);
    res.json({ stats: stats.rows[0], bookings: list.rows });
  } catch (err) {
    next(err);
  }
});

// PATCH /api/admin/bookings/:id/confirm -- กดปุ่ม "ยืนยัน"
router.patch('/bookings/:id/confirm', async (req, res, next) => {
  try {
    const result = await pool.query(
      `UPDATE booking SET booking_status = 'confirmed', updated_at = now()
       WHERE booking_id = $1 AND booking_status = 'pending'
       RETURNING *`,
      [req.params.id]
    );
    if (!result.rows.length) return res.status(404).json({ error: 'ไม่พบรายการ หรือสถานะไม่ใช่ pending' });
    res.json(result.rows[0]);
  } catch (err) {
    next(err);
  }
});

// PATCH /api/admin/bookings/:id/reject  { reason } -- กดปุ่ม "ปฏิเสธ" / "ยืนยันยกเลิก"
router.patch('/bookings/:id/reject', async (req, res, next) => {
  try {
    const result = await pool.query(
      `UPDATE booking SET booking_status = 'cancelled', cancel_reason = $2, updated_at = now()
       WHERE booking_id = $1 AND booking_status = 'pending'
       RETURNING *`,
      [req.params.id, req.body.reason || 'ไม่ระบุเหตุ']
    );
    if (!result.rows.length) return res.status(404).json({ error: 'ไม่พบรายการ' });
    res.json(result.rows[0]);
  } catch (err) {
    next(err);
  }
});

// POST /api/admin/bookings/walkin -- ฟอร์ม "เพิ่มรายการจองวอล์คอิน"
router.post('/bookings/walkin', async (req, res, next) => {
  const { roomId, startDatetime, endDatetime, customerName, customerPhone, adminUserId } = req.body;
  if (!roomId || !startDatetime || !endDatetime) {
    return res.status(400).json({ error: 'ข้อมูลไม่ครบ (roomId, startDatetime, endDatetime)' });
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
    const bookingCode = 'BK-' + Date.now();

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
        p.payment_id, p.evidence_url, p.payment_status
      FROM booking b
      JOIN room r ON r.room_id = b.room_id
      LEFT JOIN users u ON u.user_id = b.customer_id
      LEFT JOIN LATERAL (
        SELECT * FROM payment WHERE payment.booking_id = b.booking_id
        ORDER BY payment_id DESC LIMIT 1
      ) p ON true
      ORDER BY b.created_at DESC`);
    res.json(result.rows);
  } catch (err) {
    next(err);
  }
});

/* ============================================================
 * ตรวจสอบสลิปการชำระเงิน
 * ========================================================== */

// PATCH /api/admin/payments/:id/verify  { adminUserId, approve }
router.patch('/payments/:id/verify', async (req, res, next) => {
  const { adminUserId, approve } = req.body;
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const status = approve === false ? 'rejected' : 'paid';
    const payResult = await client.query(
      `UPDATE payment SET payment_status = $2, verified_by = $3, verified_at = now()
       WHERE payment_id = $1
       RETURNING *`,
      [req.params.id, status, adminUserId || null]
    );
    if (!payResult.rows.length) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'ไม่พบรายการชำระเงิน' });
    }
    const depositStatus = status === 'paid' ? 'paid' : 'unpaid';
    await client.query(
      `UPDATE booking SET deposit_status = $2, updated_at = now() WHERE booking_id = $1`,
      [payResult.rows[0].booking_id, depositStatus]
    );
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
  const { name, taxId, phone, address, bankName, bankAccountNo, bankAccountName, qrCodeUrl, peakStartTime, peakSurcharge } = req.body;
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
         updated_at = now()
       WHERE shop_id = (SELECT shop_id FROM shop ORDER BY shop_id LIMIT 1)
       RETURNING *`,
      [name, taxId, phone, address, bankName, bankAccountNo, bankAccountName, qrCodeUrl, peakStartTime, peakSurcharge]
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
  let { description } = req.body;
  if (typeof description === 'string') {
    description = description.trim();
    if (description.length > 300) {
      return res.status(400).json({ error: 'หมายเหตุต้องไม่เกิน 300 ตัวอักษร' });
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
         description = COALESCE($7, description)
       WHERE room_id = $8
       RETURNING *`,
      [roomName, size, capacity, pricePerHour, imageUrl, isActive, description, req.params.id]
    );
    if (!result.rows.length) return res.status(404).json({ error: 'ไม่พบห้อง' });
    res.json(result.rows[0]);
  } catch (err) {
    next(err);
  }
});

// POST /api/admin/rooms -- เพิ่มห้องใหม่ (ปุ่ม + ในหน้า "ตั้งค่าห้อง")
router.post('/rooms', async (req, res, next) => {
  const { roomName, size, capacity, pricePerHour, imageUrl, description } = req.body;
  try {
    const shop = (await pool.query('SELECT shop_id FROM shop ORDER BY shop_id LIMIT 1')).rows[0];
    const roomCode = 'R-' + Date.now();
    const result = await pool.query(
      `INSERT INTO room (shop_id, room_code, room_name, size, capacity, price_per_hour, image_url, description)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
       RETURNING *`,
      [shop?.shop_id || null, roomCode, roomName || 'ห้องใหม่', size || 'S', capacity || null, pricePerHour || 0, imageUrl || null, description || null]
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

// GET /api/admin/reports?period=day|week|month
router.get('/reports', async (req, res, next) => {
  const period = req.query.period || 'day';
  const trunc = period === 'month' ? 'month' : period === 'week' ? 'week' : 'day';
  try {
    const trend = await pool.query(
      `SELECT date_trunc($1, booking_date::timestamp) AS period, SUM(price_total) AS revenue, COUNT(*) AS bookings
       FROM booking
       WHERE booking_status IN ('confirmed','completed')
       GROUP BY 1 ORDER BY 1`,
      [trunc]
    );
    const byRoom = await pool.query(`
      SELECT r.room_name, SUM(b.price_total) AS revenue, COUNT(*) AS bookings
      FROM booking b JOIN room r ON r.room_id = b.room_id
      WHERE b.booking_status IN ('confirmed','completed')
      GROUP BY r.room_name
      ORDER BY revenue DESC`);
    const totals = await pool.query(`
      SELECT COALESCE(SUM(price_total),0) AS total_revenue,
             COUNT(*) AS total_bookings,
             COALESCE(ROUND(AVG(price_total),2),0) AS avg_ticket
      FROM booking
      WHERE booking_status IN ('confirmed','completed')`);
    res.json({ period, trend: trend.rows, byRoom: byRoom.rows, totals: totals.rows[0] });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
