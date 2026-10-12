// API ฝั่งแอดมิน (/api/admin/...) — ทุกอย่างที่หน้าแอดมินใช้ แบ่งเป็นหมวด (หาหัวข้อ ===== ในไฟล์):
//   1. อนุมัติการจอง + ประวัติ (ยืนยัน/ปฏิเสธ, รับเงินสด, ไม่มาใช้บริการ, ย้ายห้อง, วอล์คอิน)
//   2. Check-in / ต่อเวลา / Check-out
//   3. ตรวจสลิป
//   4. ตั้งค่าร้าน (ข้อมูลร้าน, พีคไทม์, นโยบาย, เวลาเปิด-ปิด)
//   5. ประเภทห้อง   6. ตั้งค่าห้อง   7. รายงานรายได้
const router = require('express').Router();
const { pool, withTransaction } = require('../db');
const { HttpError, route } = require('../utils/http');
const { getShop } = require('../utils/shop');
const { findActiveRoom, priceRange, quoteBooking } = require('../utils/quoteBooking');
const { expireStalePendingBookings } = require('../utils/expireBookings');
const { isStartInPast } = require('../utils/time');
const { makeCode } = require('../utils/codes');
const { submittedDepositSql, paidDepositSql } = require('../utils/deposit');
const { requireAdmin } = require('../utils/auth');
const { ROOM_TYPE_COLUMNS, joinRoomType } = require('../utils/roomType');
const { notifyBookingCustomer } = require('../utils/notify');
const { normalizePhone, reasonText } = require('../utils/validate');
const { parseRates } = require('../utils/rates');

// ทุก route ในไฟล์นี้ต้องล็อกอินเป็นแอดมิน — ระบบบันทึกว่าแอดมินคนไหนเป็นคนทำ (checked_in_by, verified_by ฯลฯ) จาก token
router.use(requireAdmin);

/* ============================================================
 * อนุมัติการจอง (หน้า "อนุมัติการจอง") + ประวัติการจอง
 * ========================================================== */

// ข้อมูลที่หน้าอนุมัติการจองและหน้าประวัติใช้ร่วมกัน (เขียนไว้ที่เดียว 2 หน้าจะได้เหมือนกัน):
// ข้อมูลการจอง + ชื่อห้อง + ชื่อ/เบอร์ลูกค้า + สลิปล่าสุด + ยอดมัดจำที่ส่งมาแล้ว + ข้อมูล Check-in/out
const BOOKING_LIST_COLUMNS = `
  b.*, r.room_name, r.image_url, COALESCE(u.name, b.walkin_name) AS customer_name,
  COALESCE(u.phone, b.walkin_phone) AS customer_phone,
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

// วิธีนับรายได้ของการจองแต่ละรายการ (a = ชื่อย่อตาราง booking ในคำสั่งนั้น):
//   - ยืนยันแล้ว / ใช้บริการเสร็จ = ยอดรวมทั้งหมด
//   - ไม่มาใช้บริการ (no-show) = มัดจำ (ร้านเก็บไว้ ไม่คืน)
//   - ลูกค้ายกเลิกเอง = มัดจำที่ร้านได้รับแล้ว (ไม่คืนตามนโยบาย)
//   - ร้านยกเลิก = ไม่นับ (ร้านคืนเงินให้ลูกค้านอกระบบ)
const revenueFilter = (a) =>
  `(${a}.booking_status IN ('confirmed','completed','no_show')
    OR (${a}.booking_status = 'cancelled' AND ${a}.cancelled_by = 'customer' AND ${paidDepositSql(a)} > 0))`;
const revenueSql = (a) =>
  `CASE WHEN ${a}.booking_status = 'no_show' THEN ${a}.deposit_required
        WHEN ${a}.booking_status = 'cancelled' THEN ${paidDepositSql(a)}
        ELSE ${a}.price_total END`;

// การจองที่ "ค้างจากวันก่อน" = วันที่จองผ่านไปแล้ว แต่ยังรอยืนยัน/ยืนยันแล้วและยังไม่ได้ Check-in
// (แอดมินต้องจัดการต่อ เช่น ตรวจสลิป หรือบันทึกไม่มาใช้บริการ) — o = ชื่อย่อตาราง booking
const OVERDUE_SQL = `o.booking_date < CURRENT_DATE AND o.booking_status IN ('pending','confirmed')
  AND NOT EXISTS (SELECT 1 FROM service_session ss WHERE ss.booking_id = o.booking_id)`;

// GET /api/admin/bookings/today -- หน้า "อนุมัติการจอง": การ์ดสรุปตัวเลข + รายการจองวันนี้
router.get(
  '/bookings/today',
  route(async (req, res) => {
    await expireStalePendingBookings();
    const stats = await pool.query(`
    SELECT
      COUNT(*) FILTER (WHERE booking_status = 'pending')   AS pending_count,
      COUNT(*) FILTER (WHERE booking_status = 'confirmed') AS in_progress_count,
      COUNT(*) FILTER (WHERE booking_status = 'completed') AS completed_count,
      COALESCE(SUM(${revenueSql('booking')}) FILTER (WHERE ${revenueFilter('booking')}), 0) AS revenue_today,
      (SELECT COUNT(*) FROM booking o WHERE ${OVERDUE_SQL}) AS overdue_count
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
    -- แสดง: การจองวันนี้ + ห้องที่ยังใช้อยู่ (ยังไม่ Check-out แม้เลยเที่ยงคืน) + รายการค้างจากวันก่อน (ขึ้นก่อนเสมอ)
    WHERE b.booking_date = CURRENT_DATE OR s.session_status = 'in_progress'
       OR (b.booking_date < CURRENT_DATE AND b.booking_status IN ('pending','confirmed') AND s.session_id IS NULL)
    -- ในแต่ละกลุ่ม (ค้างจากวันก่อน / วันนี้) เรียงตามเวลาที่ลูกค้ากดจอง ใหม่สุดขึ้นก่อน
    ORDER BY is_overdue DESC, b.created_at DESC, b.booking_id DESC`);
    res.json({ stats: stats.rows[0], bookings: list.rows });
  }),
);

// GET /api/admin/alerts?afterPaymentId=<id> -- แจ้งเตือนฝั่งแอดมิน (หน้าแอดมินถามทุก 15 วินาที)
// ตอบ 3 อย่าง:
//   pendingCount    = ตัวเลขแดงบนเมนู "อนุมัติการจอง" (รอยืนยันวันนี้ + ค้างจากวันก่อน)
//   newSlips        = สลิปใหม่ที่รอตรวจ ซึ่งส่งมาหลังจากครั้งที่แล้วที่หน้าเว็บถาม (ใช้เด้งกล่องแจ้งเตือน + เสียง)
//   latestPaymentId = เลขสลิปล่าสุด ให้หน้าเว็บจำไว้ส่งมาครั้งถัดไป (เลข payment_id เพิ่มขึ้นเรื่อยๆ จึงใช้บอกว่า "ใหม่กว่า" ได้)
// ครั้งแรกหน้าเว็บส่ง 0 มาแค่เพื่อเอาเลขล่าสุด จะได้ไม่เด้งแจ้งเตือนของเก่าทั้งหมด
router.get(
  '/alerts',
  route(async (req, res) => {
    const after = Number(req.query.afterPaymentId ?? 0);
    if (!Number.isInteger(after) || after < 0) throw new HttpError(400, 'afterPaymentId ต้องเป็นจำนวนเต็มตั้งแต่ 0');
    await expireStalePendingBookings();
    const [counts, latest, slips] = await Promise.all([
      pool.query(`
        SELECT
          (SELECT COUNT(*) FROM booking WHERE booking_date = CURRENT_DATE AND booking_status = 'pending')
          + (SELECT COUNT(*) FROM booking o WHERE ${OVERDUE_SQL}) AS n`),
      pool.query('SELECT COALESCE(MAX(payment_id), 0) AS id FROM payment'),
      pool.query(
        `SELECT p.payment_id, p.booking_id, p.amount, r.room_name, COALESCE(u.name, b.walkin_name) AS customer_name,
                b.start_datetime, b.end_datetime,
                EXISTS (SELECT 1 FROM payment old WHERE old.booking_id = p.booking_id AND old.payment_id < p.payment_id
                          AND old.payment_status = 'paid') AS is_topup
         FROM payment p
         JOIN booking b ON b.booking_id = p.booking_id
         JOIN room r ON r.room_id = b.room_id
         LEFT JOIN users u ON u.user_id = b.customer_id
         WHERE p.payment_id > $1 AND p.payment_status = 'pending'
           AND b.booking_status IN ('pending', 'confirmed') -- การจองที่ยกเลิกไปแล้วไม่ต้องเตือน
         ORDER BY p.payment_id
         LIMIT 20`,
        [after],
      ),
    ]);
    res.json({
      pendingCount: Number(counts.rows[0].n),
      latestPaymentId: latest.rows[0].id,
      newSlips: slips.rows,
    });
  }),
);

// GET /api/admin/bookings/history -- หน้า "ประวัติการจอง" ของแอดมิน (ทุกสถานะ)
// แสดงเฉพาะ 7 วันล่าสุด (วันนี้ + ย้อนหลัง 6 วัน นับจากวันที่ใช้บริการ) ไม่รวมการจองวันข้างหน้า
// เรียงวันล่าสุดก่อน และในวันเดียวกันเรียงเวลาเริ่มล่าสุดก่อน — การจองที่เก่ากว่านี้ไม่ได้ถูกลบ (รายงานรายได้ยังใช้)
const HISTORY_DAYS = 7;
router.get(
  '/bookings/history',
  route(async (req, res) => {
    await expireStalePendingBookings();
    const result = await pool.query(
      `SELECT ${BOOKING_LIST_COLUMNS} ${BOOKING_LIST_JOINS}
       WHERE b.booking_date BETWEEN CURRENT_DATE - ($1::int - 1) AND CURRENT_DATE
       ORDER BY b.booking_date DESC, b.start_datetime DESC`,
      [HISTORY_DAYS],
    );
    res.json(result.rows);
  }),
);

// ---- นโยบายมัดจำเมื่อมีการยกเลิก ----
// ลูกค้ายกเลิกเอง / ไม่มาใช้บริการ = ร้านไม่คืนมัดจำ (สลิปที่ค้างตรวจยังตรวจได้ เพื่อยืนยันว่าได้เงินจริง)
// ร้านเป็นคนยกเลิก = สลิปที่ค้างตรวจทั้งหมดถูกตั้งเป็น "ไม่ผ่าน" อัตโนมัติ และร้านคืนเงินให้ลูกค้าเองนอกระบบ
const SHOP_CANCEL_SLIP_REMARK = 'ไม่ผ่าน (การจองถูกยกเลิก)';
const REFUND_NOTE = 'หากโอนมัดจำมาแล้ว ร้านจะติดต่อคืนเงินให้';

/**
 * เรียกหลังร้านยกเลิกการจอง (ใน withTransaction เดียวกัน): ตั้งสลิปที่ค้างตรวจเป็น "ไม่ผ่าน" ทั้งหมด
 * คืนค่า true ถ้าลูกค้าเคยโอนเงินมา (มีสลิปที่ผ่านแล้ว หรือสลิปที่เพิ่งถูกตั้งเป็นไม่ผ่าน)
 * → เอาไปต่อท้ายข้อความแจ้งเตือนว่า "ร้านจะติดต่อคืนเงินให้"
 */
async function rejectPendingSlipsOnShopCancel(client, bookingId, adminId) {
  const rejected = await client.query(
    `UPDATE payment SET payment_status = 'rejected', verified_by = $2, verified_at = now(), remark = $3
     WHERE booking_id = $1 AND payment_status = 'pending'`,
    [bookingId, adminId, SHOP_CANCEL_SLIP_REMARK],
  );
  // ตอนนี้ไม่มีสลิปรอตรวจแล้ว: ได้เงินครบมัดจำ = paid (ยอดที่ร้านต้องคืน) / ไม่ครบหรือไม่มีเลย = unpaid
  const paid = (
    await client.query(
      `UPDATE booking SET deposit_status = CASE
         WHEN ${paidDepositSql('booking')} >= deposit_required AND deposit_required > 0 THEN 'paid'
         ELSE 'unpaid' END
       WHERE booking_id = $1
       RETURNING ${paidDepositSql('booking')} AS paid_sum`,
      [bookingId],
    )
  ).rows[0];
  return rejected.rowCount > 0 || Number(paid?.paid_sum) > 0;
}

// PATCH /api/admin/bookings/:id/confirm -- ปุ่ม "ยืนยัน"
// ยืนยันได้เมื่อ: ยังรอยืนยันอยู่ + ยังไม่เลยเวลาสิ้นสุด + ได้มัดจำครบแล้ว (ตรวจสลิปผ่าน หรือกด "รับมัดจำเงินสดแล้ว")
// ยืนยันแล้วลูกค้าได้แจ้งเตือน "ร้านยืนยันการจองของคุณแล้ว"
router.patch(
  '/bookings/:id/confirm',
  route(async (req, res) => {
    const booking = await withTransaction(async (client) => {
      const updated = (
        await client.query(
          `UPDATE booking SET booking_status = 'confirmed', updated_at = now()
           WHERE booking_id = $1 AND booking_status = 'pending' AND end_datetime > LOCALTIMESTAMP
             AND deposit_status = 'paid'
           RETURNING *`,
          [req.params.id],
        )
      ).rows[0];
      if (!updated) {
        const found = (
          await client.query('SELECT deposit_status, booking_status FROM booking WHERE booking_id = $1', [
            req.params.id,
          ])
        ).rows[0];
        if (found?.booking_status === 'pending' && found.deposit_status !== 'paid') {
          throw new HttpError(409, 'ยังไม่ได้รับมัดจำครบ — ตรวจสลิปให้ผ่านก่อน หรือกด "รับมัดจำเงินสดแล้ว"');
        }
        throw new HttpError(404, 'ไม่พบรายการ สถานะไม่ใช่ pending หรือเลยเวลาของการจองนี้แล้ว');
      }
      await notifyBookingCustomer(client, updated.booking_id, 'booking_confirmed');
      return updated;
    });
    res.json(booking);
  }),
);

// PATCH /api/admin/bookings/:id/cash-deposit -- ปุ่ม "รับมัดจำเงินสดแล้ว" (ลูกค้ามาจ่ายมัดจำเป็นเงินสดที่ร้าน)
// บันทึกเป็นการจ่ายเงินสด (ถือว่าผ่านแล้ว) เท่ากับยอดที่ยังขาด จากนั้นแอดมินกด "ยืนยัน" ต่อได้
// ถ้ามีสลิปรอตรวจอยู่ ต้องตรวจสลิปก่อน (กันรับเงินซ้ำ 2 ทาง)
router.patch(
  '/bookings/:id/cash-deposit',
  route(async (req, res) => {
    const payment = await withTransaction(async (client) => {
      const b = (
        await client.query(
          `SELECT booking_id, booking_status, deposit_required - ${paidDepositSql('booking')} AS amount_due,
                  EXISTS (SELECT 1 FROM payment p WHERE p.booking_id = booking.booking_id AND p.payment_status = 'pending') AS has_pending_slip
           FROM booking WHERE booking_id = $1 FOR UPDATE`,
          [req.params.id],
        )
      ).rows[0];
      if (!b || !['pending', 'confirmed'].includes(b.booking_status)) {
        throw new HttpError(404, 'ไม่พบรายการ หรือรายการนี้ถูกยกเลิก/เสร็จสิ้นไปแล้ว');
      }
      if (b.has_pending_slip) throw new HttpError(409, 'มีสลิปรอตรวจอยู่ — กรุณาตรวจสลิปก่อน');
      if (Number(b.amount_due) <= 0) throw new HttpError(409, 'รายการนี้ได้รับมัดจำครบแล้ว');
      const inserted = (
        await client.query(
          `INSERT INTO payment (booking_id, payment_type, amount, method, paid_at, payment_status, verified_by, verified_at, remark)
           VALUES ($1, 'deposit', $2, 'cash', now(), 'paid', $3, now(), 'รับเงินสดที่หน้าร้าน')
           RETURNING *`,
          [b.booking_id, b.amount_due, req.user.id],
        )
      ).rows[0];
      await client.query(`UPDATE booking SET deposit_status = 'paid', updated_at = now() WHERE booking_id = $1`, [
        b.booking_id,
      ]);
      return inserted;
    });
    res.status(201).json(payment);
  }),
);

// PATCH /api/admin/bookings/:id/reject  { reason } -- ปุ่ม "ปฏิเสธ" (รายการรอยืนยัน) / "ยกเลิกการจอง" (ยืนยันแล้ว)
// ร้านยกเลิกได้ถ้ายังไม่ Check-in (เข้าห้องไปแล้วให้กด Check-out แทน) → ลูกค้าได้แจ้งเตือนพร้อมเหตุผล
router.patch(
  '/bookings/:id/reject',
  route(async (req, res) => {
    const reason = reasonText(req.body.reason, 'ไม่ระบุเหตุ');
    const booking = await withTransaction(async (client) => {
      const updated = (
        await client.query(
          `UPDATE booking SET booking_status = 'cancelled', cancel_reason = $2, cancelled_by = 'shop', updated_at = now()
           WHERE booking_id = $1 AND booking_status IN ('pending','confirmed')
             AND NOT EXISTS (SELECT 1 FROM service_session s WHERE s.booking_id = booking.booking_id)
           RETURNING *`,
          [req.params.id, reason],
        )
      ).rows[0];
      if (!updated) throw new HttpError(404, 'ไม่พบรายการ หรือรายการนี้ยกเลิกไม่ได้แล้ว (Check-in แล้ว)');
      const hadMoney = await rejectPendingSlipsOnShopCancel(client, updated.booking_id, req.user.id);
      await notifyBookingCustomer(
        client,
        updated.booking_id,
        'booking_cancelled',
        `เหตุผล: ${reason}${hadMoney ? ` — ${REFUND_NOTE}` : ''}`,
      );
      return updated;
    });
    res.json(booking);
  }),
);

// PATCH /api/admin/bookings/:id/no-show -- ปุ่ม "ไม่มาใช้บริการ" (ขอบเขตข้อ 2.3)
// กดได้เมื่อ: ยืนยันแล้ว + เลยเวลาเริ่มแล้ว + ลูกค้ายังไม่ Check-in → ห้องว่างให้คนอื่นจองต่อ ร้านไม่คืนมัดจำ
router.patch(
  '/bookings/:id/no-show',
  route(async (req, res) => {
    const reason = reasonText(req.body.reason, 'ลูกค้าไม่มาใช้บริการตามเวลาที่จอง');
    const booking = await withTransaction(async (client) => {
      const updated = (
        await client.query(
          `UPDATE booking SET booking_status = 'no_show', cancel_reason = $2, updated_at = now()
           WHERE booking_id = $1 AND booking_status = 'confirmed' AND start_datetime <= LOCALTIMESTAMP
             AND NOT EXISTS (SELECT 1 FROM service_session s WHERE s.booking_id = booking.booking_id)
           RETURNING *`,
          [req.params.id, reason],
        )
      ).rows[0];
      if (!updated) {
        throw new HttpError(409, 'บันทึกไม่มาใช้บริการได้เฉพาะรายการที่ยืนยันแล้ว เลยเวลาเริ่มแล้ว และยังไม่ Check-in');
      }
      await notifyBookingCustomer(client, updated.booking_id, 'no_show', 'มัดจำไม่คืนตามนโยบายของร้าน');
      return updated;
    });
    res.json(booking);
  }),
);

// PATCH /api/admin/bookings/:id/change-room  { roomId } -- ปุ่ม "ย้ายห้อง" (เวลาเดิม ราคาเดิม)
// ไม่มีตารางเก็บประวัติการย้ายห้อง จึงเขียนบันทึกการย้ายต่อท้ายหมายเหตุ (note) ของการจองแทน
// ถ้าห้องใหม่ไม่ว่างช่วงนั้น ฐานข้อมูลจะไม่ยอมบันทึก (error 23P01) แล้วเราตอบว่าห้องไม่ว่าง
router.patch(
  '/bookings/:id/change-room',
  route(
    async (req, res) => {
      const newRoomId = Number(req.body.roomId);
      if (!Number.isInteger(newRoomId) || newRoomId <= 0) throw new HttpError(400, 'กรุณาเลือกห้องที่จะย้ายไป');
      const booking = await withTransaction(async (client) => {
        const current = (
          await client.query(
            `SELECT b.booking_status, b.room_id, r.room_name
       FROM booking b JOIN room r ON r.room_id = b.room_id
       WHERE b.booking_id = $1
       FOR UPDATE OF b`,
            [req.params.id],
          )
        ).rows[0];
        if (!current || !['pending', 'confirmed'].includes(current.booking_status)) {
          throw new HttpError(404, 'ไม่พบรายการ หรือรายการนี้ย้ายห้องไม่ได้แล้ว');
        }
        if (current.room_id === newRoomId) throw new HttpError(400, 'ห้องใหม่ต้องไม่ใช่ห้องเดิม');
        const newRoom = await findActiveRoom(newRoomId, client);
        const moved = (
          await client.query(
            `UPDATE booking SET
         room_id = $2,
         note = concat_ws(E'\\n', note,
           '[ย้ายห้อง ' || to_char(LOCALTIMESTAMP, 'YYYY-MM-DD HH24:MI') || '] จาก ' || $3::text || ' เป็น ' || $4::text),
         updated_at = now()
       WHERE booking_id = $1
       RETURNING *`,
            [req.params.id, newRoomId, current.room_name, newRoom.room_name],
          )
        ).rows[0];
        // แจ้งเตือนลูกค้า (ข้อความจะเป็นชื่อห้องใหม่ เพราะอ่านจากการจองที่อัปเดตแล้ว)
        await notifyBookingCustomer(client, moved.booking_id, 'room_changed', `ย้ายจากห้อง ${current.room_name}`);
        return moved;
      });
      res.json(booking);
    },
    { '23P01': [409, 'ห้องใหม่ไม่ว่างในช่วงเวลานี้ กรุณาเลือกห้องอื่น'] },
  ),
);

const WALKIN_MIN_MINUTES = 60; // วอล์คอินต้องจองอย่างน้อย 1 ชม. — ต้องตรงกับ WALKIN_MIN_SLOTS ในหน้าเว็บ

// POST /api/admin/bookings/walkin -- หน้า "จองวอล์คอิน" (ลูกค้ามาที่ร้านเลย ไม่ได้จองผ่านเว็บ)
// สร้างเป็น "ยืนยันแล้ว + จ่ายมัดจำแล้ว" ทันที (จ่ายที่ร้าน) ไม่ต้องผ่านขั้นตรวจสลิป
router.post(
  '/bookings/walkin',
  route(
    async (req, res) => {
      const { roomId, startDatetime, endDatetime, customerName, customerPhone } = req.body;
      if (!roomId || !startDatetime || !endDatetime) {
        throw new HttpError(400, 'ข้อมูลไม่ครบ (roomId, startDatetime, endDatetime)');
      }
      if (!((new Date(endDatetime) - new Date(startDatetime)) / 60000 >= WALKIN_MIN_MINUTES)) {
        throw new HttpError(400, 'วอล์คอินต้องจองอย่างน้อย 1 ชั่วโมง');
      }
      if (isStartInPast(startDatetime)) throw new HttpError(400, 'เวลาที่เลือกผ่านไปแล้ว กรุณาเลือกเวลาอื่น');

      await expireStalePendingBookings();
      const room = await findActiveRoom(roomId); // ห้องที่ปิดให้บริการจองไม่ได้ เหมือนฝั่งลูกค้า
      const q = await quoteBooking(room, startDatetime, endDatetime);

      const booking = (
        await pool.query(
          `INSERT INTO booking (
       booking_code, created_by, room_id, policy_id, booking_source,
       booking_date, start_datetime, end_datetime, walkin_name, walkin_phone,
       booking_status, base_price, peak_surcharge_total, price_total, deposit_required, deposit_status
     ) VALUES ($1,$2,$3,$4,'admin_walkin',$5,$6,$7,$8,$9,'confirmed',$10,$11,$12,$13,'paid')
     RETURNING *`,
          [
            q.bookingCode,
            req.user.id,
            roomId,
            q.policyId,
            q.bookingDate,
            startDatetime,
            endDatetime,
            customerName || 'ลูกค้าหน้าร้าน',
            customerPhone ? normalizePhone(customerPhone) : null,
            q.basePrice,
            q.peakSurchargeTotal,
            q.priceTotal,
            q.depositRequired,
          ],
        )
      ).rows[0];
      res.status(201).json(booking);
    },
    { '23P01': [409, 'ช่วงเวลานี้ถูกจองไปแล้ว'] },
  ),
);

/* ============================================================
 * Check-in / ต่อเวลา / Check-out (ขอบเขตข้อ 2.6)
 * ลูกค้ามาถึง = Check-in (สร้างแถวใน service_session) · ต่อเวลา = เพิ่มแถวใน extension · ออก = Check-out
 * ========================================================== */

const CHECKIN_EARLY_MINUTES = 15; // มาถึงก่อนเวลาได้ Check-in ก่อนไม่เกิน 15 นาที
const OVERTIME_GRACE_MINUTES = 10; // ออกช้าไม่เกิน 10 นาที ไม่คิดเงินเพิ่ม
const MAX_EXTEND_MINUTES = 240; // ต่อเวลาได้ครั้งละไม่เกิน 4 ชั่วโมง

// ออกช้ากี่นาที → ต้องคิดเงินเพิ่มกี่ช่อง (ช่องละ 30 นาที) โดยหัก 10 นาทีแรกที่ไม่คิดเงินออกก่อน
// เช่น ออกช้า 10 นาที = 0 ช่อง, 11 นาที = 1 ช่อง, 40 นาที = 1 ช่อง, 41 นาที = 2 ช่อง
function overtimeHalfSlots(minutesLate) {
  return minutesLate > OVERTIME_GRACE_MINUTES ? Math.ceil((minutesLate - OVERTIME_GRACE_MINUTES) / 30) : 0;
}

// เวลา + จำนวนนาที (ให้ฐานข้อมูลคิด จะได้ข้ามเที่ยงคืน/ข้ามวันได้ถูก) ได้ผลเป็นข้อความเวลาไทย เช่น "2026-10-12T21:30:00"
async function addMinutes(client, timestamp, minutes) {
  return (await client.query('SELECT $1::timestamp + make_interval(mins => $2) AS t', [timestamp, minutes])).rows[0].t;
}

// ดึงการจอง + ราคาห้อง + ข้อมูล Check-in และให้ฐานข้อมูลคิดให้ว่า:
//   checkin_opened = ถึงเวลาที่ Check-in ได้หรือยัง · before_end = ยังไม่เลยเวลาสิ้นสุด · minutes_late = ออกช้ากี่นาที
// "FOR UPDATE" = ล็อกแถวนี้ไว้จนทำเสร็จ กันแอดมิน 2 คนกดพร้อมกันแล้วข้อมูลซ้ำ
async function lockBookingWithSession(client, bookingId) {
  return (
    await client.query(
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
      [bookingId, CHECKIN_EARLY_MINUTES],
    )
  ).rows[0];
}

// เหมือนข้างบน แต่ต้องเป็นรายการที่ Check-in แล้วและยังไม่ Check-out (ใช้ตอนต่อเวลา / Check-out)
async function lockActiveSession(client, bookingId, message) {
  const b = await lockBookingWithSession(client, bookingId);
  if (!b || b.session_status !== 'in_progress') throw new HttpError(409, message);
  return b;
}

// PATCH /api/admin/bookings/:id/check-in -- ปุ่ม "Check-in" (ลูกค้ามาถึงร้านแล้ว)
// ได้เมื่อ: ยืนยันแล้ว + เหลือไม่เกิน 15 นาทีก่อนเวลาเริ่ม (หรือเลยเวลาเริ่มแล้ว) + ยังไม่เลยเวลาสิ้นสุด
router.patch(
  '/bookings/:id/check-in',
  route(async (req, res) => {
    const session = await withTransaction(async (client) => {
      const b = await lockBookingWithSession(client, req.params.id);
      if (!b) throw new HttpError(404, 'ไม่พบรายการจอง');
      if (b.session_id) throw new HttpError(409, 'รายการนี้ Check-in ไปแล้ว');
      if (b.booking_status !== 'confirmed') throw new HttpError(409, 'ต้องยืนยันการจองก่อนจึงจะ Check-in ได้');
      if (!b.checkin_opened) throw new HttpError(409, `Check-in ได้ก่อนเวลาเริ่มไม่เกิน ${CHECKIN_EARLY_MINUTES} นาที`);
      if (!b.before_end) throw new HttpError(409, 'เลยเวลาสิ้นสุดของการจองแล้ว Check-in ไม่ได้');
      return (
        await client.query(
          `INSERT INTO service_session (booking_id, checkin_time, checked_in_by, session_status)
       VALUES ($1, LOCALTIMESTAMP, $2, 'in_progress')
       RETURNING *`,
          [b.booking_id, req.user.id],
        )
      ).rows[0];
    });
    res.status(201).json(session);
  }),
);

// PATCH /api/admin/bookings/:id/extend  { minutes } -- ปุ่ม "ต่อเวลา" (ทีละ 30 นาที คิดราคาแบบเดียวกับตอนจอง)
// เลื่อนเวลาสิ้นสุดของการจองออกไปจริง และบวกเงินเพิ่มเข้ายอดรวม
// ต่อไม่ได้ถ้า: เกินเวลาปิดร้านวันนั้น หรือมีคนจองห้องนี้ต่อจากเราแล้ว (ฐานข้อมูลตอบ error 23P01)
router.patch(
  '/bookings/:id/extend',
  route(
    async (req, res) => {
      const minutes = Number(req.body.minutes);
      if (!Number.isInteger(minutes) || minutes <= 0 || minutes % 30 !== 0 || minutes > MAX_EXTEND_MINUTES) {
        throw new HttpError(400, `ต่อเวลาได้ทีละ 30 นาที (สูงสุด ${MAX_EXTEND_MINUTES / 60} ชม. ต่อครั้ง)`);
      }
      const extension = await withTransaction(async (client) => {
        const b = await lockActiveSession(
          client,
          req.params.id,
          'ต่อเวลาได้เฉพาะรายการที่ Check-in แล้วและยังไม่ Check-out',
        );
        const newEnd = await addMinutes(client, b.end_datetime, minutes);
        const afterClose = (
          await client.query(
            `SELECT $1::timestamp > ($2::date + make_interval(hours => close_hour)) AS after_close
       FROM shop_hours WHERE day_of_week = EXTRACT(DOW FROM $2::date)
       ORDER BY shop_id LIMIT 1`,
            [newEnd, b.booking_date],
          )
        ).rows[0]?.after_close;
        if (afterClose) throw new HttpError(409, 'ต่อเวลาเกินเวลาปิดร้านไม่ได้');
        const extraAmount = (await priceRange(b, b.end_datetime, newEnd, client)).priceTotal;
        await client.query(
          `UPDATE booking SET end_datetime = $2, price_total = price_total + $3, updated_at = now()
       WHERE booking_id = $1`,
          [b.booking_id, newEnd, extraAmount],
        );
        return (
          await client.query(
            `INSERT INTO extension (session_id, extend_minutes, new_end_datetime, extra_amount, approved_by, created_at)
       VALUES ($1, $2, $3, $4, $5, LOCALTIMESTAMP)
       RETURNING *`,
            [b.session_id, minutes, newEnd, extraAmount, req.user.id],
          )
        ).rows[0];
      });
      res.status(201).json(extension);
    },
    { '23P01': [409, 'ต่อเวลาไม่ได้ เพราะห้องนี้มีการจองถัดไปในช่วงเวลานั้นแล้ว'] },
  ),
);

// PATCH /api/admin/bookings/:id/check-out -- ปุ่ม "Check-out" (ลูกค้าออกจากห้อง)
// ถ้าออกช้ากว่าเวลาสิ้นสุด คิดค่าเกินเวลาตาม overtimeHalfSlots() แล้วเปลี่ยนการจองเป็น "เสร็จสมบูรณ์" (completed)
router.patch(
  '/bookings/:id/check-out',
  route(async (req, res) => {
    const result = await withTransaction(async (client) => {
      const b = await lockActiveSession(
        client,
        req.params.id,
        'Check-out ได้เฉพาะรายการที่ Check-in แล้วและยังไม่ Check-out',
      );
      const halfSlots = overtimeHalfSlots(b.minutes_late);
      const overtimeAmount =
        halfSlots > 0
          ? (await priceRange(b, b.end_datetime, await addMinutes(client, b.end_datetime, halfSlots * 30), client))
              .priceTotal
          : 0;
      const session = (
        await client.query(
          `UPDATE service_session SET checkout_time = LOCALTIMESTAMP, checked_out_by = $2,
         session_status = 'finished', overtime_amount = $3
       WHERE session_id = $1
       RETURNING *`,
          [b.session_id, req.user.id, overtimeAmount],
        )
      ).rows[0];
      await client.query(
        `UPDATE booking SET booking_status = 'completed', price_total = price_total + $2, updated_at = now()
       WHERE booking_id = $1`,
        [b.booking_id, overtimeAmount],
      );
      return { ...session, minutes_late: Math.max(0, b.minutes_late) };
    });
    res.json(result);
  }),
);

/* ============================================================
 * ตรวจสอบสลิปการชำระเงิน
 * ========================================================== */

// PATCH /api/admin/payments/:id/verify  { approve, reason } -- ปุ่ม "ผ่าน" / "ไม่ผ่าน" ของสลิป
// ผ่าน = รับมัดจำ (แล้วแอดมินกด "ยืนยัน" การจองต่อ)
// ไม่ผ่าน = ร้านยกเลิกการจองทันที ลูกค้าได้แจ้งเตือนพร้อมเหตุผล และห้องว่างให้คนอื่นจอง
// ตรวจได้เฉพาะสลิปที่ยังรอตรวจ (กดซ้ำไม่ได้ ผลที่ตัดสินไปแล้วจะไม่เปลี่ยน)
router.patch(
  '/payments/:id/verify',
  route(async (req, res) => {
    const { approve } = req.body;
    const reason = reasonText(req.body.reason, 'สลิปไม่ผ่านการตรวจสอบ');
    const status = approve === false ? 'rejected' : 'paid';
    const payment = await withTransaction(async (client) => {
      const verified = (
        await client.query(
          `UPDATE payment SET payment_status = $2::varchar, verified_by = $3, verified_at = now(),
         remark = CASE WHEN $2::varchar = 'rejected' THEN $4::text ELSE remark END
       WHERE payment_id = $1 AND payment_status = 'pending'
       RETURNING *`,
          [req.params.id, status, req.user.id, reason],
        )
      ).rows[0];
      if (!verified) throw new HttpError(404, 'ไม่พบรายการชำระเงิน หรือสลิปนี้ตรวจไปแล้ว');
      if (status === 'paid') {
        // ผ่าน = รับมัดจำของการจองนี้ทั้งหมด: สลิปอื่นที่ยังรอตรวจของการจองเดียวกัน (เช่น สลิปก่อนลูกค้าแก้ไขการจอง) ผ่านไปด้วย
        await client.query(
          `UPDATE payment SET payment_status = 'paid', verified_by = $2, verified_at = now()
         WHERE booking_id = $1 AND payment_status = 'pending'`,
          [verified.booking_id, req.user.id],
        );
        // สถานะมัดจำใหม่: ได้เงินครบแล้ว = paid / ยังมีสลิปอื่นรอตรวจ = pending_verify / ยังไม่ครบ = unpaid
        await client.query(
          `UPDATE booking SET updated_at = now(), deposit_status = CASE
           WHEN ${paidDepositSql('booking')} >= deposit_required THEN 'paid'
           WHEN EXISTS (SELECT 1 FROM payment WHERE booking_id = $1 AND payment_status = 'pending') THEN 'pending_verify'
           ELSE 'unpaid' END
         WHERE booking_id = $1`,
          [verified.booking_id],
        );
      } else {
        // ถ้าการจองยังไม่ถูกยกเลิก → สลิปไม่ผ่าน = ร้านยกเลิกการจองนี้ / ถ้าลูกค้ายกเลิกไปเองแล้ว → แค่บันทึกว่าสลิปไม่ผ่าน
        const wasActive = ['pending', 'confirmed'].includes(
          (await client.query('SELECT booking_status FROM booking WHERE booking_id = $1', [verified.booking_id]))
            .rows[0]?.booking_status,
        );
        await client.query(
          `UPDATE booking SET deposit_status = 'unpaid',
           booking_status = CASE WHEN booking_status IN ('pending','confirmed') THEN 'cancelled' ELSE booking_status END,
           cancel_reason = CASE WHEN booking_status IN ('pending','confirmed') THEN $2 ELSE cancel_reason END,
           cancelled_by = CASE WHEN booking_status IN ('pending','confirmed') THEN 'shop' ELSE cancelled_by END,
           updated_at = now()
         WHERE booking_id = $1`,
          [verified.booking_id, 'ปฏิเสธสลิป: ' + reason],
        );
        let extra = `เหตุผล: ${reason}`;
        if (wasActive) {
          // สลิปอื่นที่ยังค้างตรวจของการจองนี้ ไม่ผ่านไปด้วย
          await rejectPendingSlipsOnShopCancel(client, verified.booking_id, req.user.id);
          // ถ้าเคยมีสลิปที่ผ่านแล้ว (เช่น มัดจำก่อนลูกค้าแก้ไขการจอง) ร้านต้องคืนเงินส่วนนั้น → บอกในแจ้งเตือน
          const paidBefore = (
            await client.query(`SELECT ${paidDepositSql('booking')} AS n FROM booking WHERE booking_id = $1`, [
              verified.booking_id,
            ])
          ).rows[0].n;
          extra += ' — การจองนี้ถูกยกเลิก' + (Number(paidBefore) > 0 ? ` · ${REFUND_NOTE}` : '');
        }
        await notifyBookingCustomer(client, verified.booking_id, 'slip_rejected', extra);
      }
      return verified;
    });
    res.json(payment);
  }),
);

/* ============================================================
 * ตั้งค่าร้าน (หน้า "ตั้งค่าร้าน")
 * ========================================================== */

// ชื่อช่องพีคไทม์ในฟอร์มตั้งค่าร้าน
const RATE_KEYS = ['peakStartTime', 'peakEndTime', 'peakSurcharge'];
// ค่าพีคไทม์ปัจจุบันในฐานข้อมูล → รูปแบบเดียวกับฟอร์ม (ใช้เติมช่องที่หน้าเว็บไม่ได้ส่งมา)
const rateFormFromRow = (row) => ({
  peakStartTime: row.peak_start_time ? String(row.peak_start_time).slice(0, 5) : '',
  peakEndTime: row.peak_end_time ? String(row.peak_end_time).slice(0, 5) : '',
  peakSurcharge: row.peak_surcharge,
});

// PATCH /api/admin/shop -- บันทึกข้อมูลร้าน + พีคไทม์ที่ใช้ทุกวัน (ช่องไหนไม่ได้ส่งมา = คงค่าเดิม)
// พีคไทม์: เวลาเริ่มว่าง = ไม่มีพีค / เวลาสิ้นสุดว่าง = พีคถึงร้านปิด
// (ในคำสั่ง SQL: COALESCE(ค่าใหม่, ค่าเดิม) = ถ้าไม่ได้ส่งค่าใหม่มาให้ใช้ค่าเดิม)
router.patch(
  '/shop',
  route(async (req, res) => {
    const { name, taxId, phone, address, bankName, bankAccountNo, bankAccountName, qrCodeUrl, floorPlanUrl } = req.body;
    const shop = await withTransaction(async (client) => {
      const current = await getShop(client);
      if (!current) throw new HttpError(404, 'ยังไม่ได้ตั้งค่าร้าน');
      let rates = null;
      if (RATE_KEYS.some((k) => req.body[k] !== undefined)) {
        const merged = { ...rateFormFromRow(current) };
        RATE_KEYS.forEach((k) => req.body[k] !== undefined && (merged[k] = req.body[k]));
        rates = parseRates(merged);
      }
      return (
        await client.query(
          `UPDATE shop SET
             name = COALESCE($1, name),
             tax_id = COALESCE($2, tax_id),
             phone = COALESCE($3, phone),
             address = COALESCE($4, address),
             bank_name = COALESCE($5, bank_name),
             bank_account_no = COALESCE($6, bank_account_no),
             bank_account_name = COALESCE($7, bank_account_name),
             qr_code_url = COALESCE($8, qr_code_url),
             floor_plan_url = COALESCE($9, floor_plan_url),
             peak_start_time = CASE WHEN $10 THEN $11::time ELSE peak_start_time END,
             peak_end_time = CASE WHEN $10 THEN $12::time ELSE peak_end_time END,
             peak_surcharge = CASE WHEN $10 THEN $13::numeric ELSE peak_surcharge END,
             updated_at = now()
           WHERE shop_id = $14
           RETURNING *`,
          [
            name,
            taxId,
            phone,
            address,
            bankName,
            bankAccountNo,
            bankAccountName,
            qrCodeUrl,
            floorPlanUrl,
            Boolean(rates),
            rates?.peak_start_time ?? null,
            rates?.peak_end_time ?? null,
            rates?.peak_surcharge ?? 0,
            current.shop_id,
          ],
        )
      ).rows[0];
    });
    res.json(shop);
  }),
);

// ตรวจจำนวนชั่วโมงในนโยบาย: 0-72 ทีละครึ่งชั่วโมง (เช่น 1, 1.5, 2) / allowBlank = ปล่อยว่างได้ (เก็บเป็น null)
function policyHours(value, label, allowBlank = false) {
  if (allowBlank && (value === '' || value === null || value === undefined)) return null;
  const n = Number(value);
  if (value === '' || value === null || !Number.isInteger(n * 2) || n < 0 || n > 72) {
    throw new HttpError(400, `${label}ต้องเป็น 0-72 ชั่วโมง ทีละ 0.5 ชั่วโมง`);
  }
  return n;
}

// PATCH /api/admin/policy  { depositPercent, cancelHoursBefore, allowEditBeforeHours, refundPolicyDesc, noShowPolicyDesc }
// -- การ์ด "นโยบายมัดจำและการยกเลิก" ในหน้าตั้งค่าร้าน (ขอบเขตข้อ 2.3)
// ไม่แก้ฉบับเดิม แต่สร้าง "นโยบายฉบับใหม่" ทุกครั้ง (ฉบับเดิมถูกปิดด้วย effective_to)
// เหตุผล: การจองที่ทำไปแล้วต้องใช้นโยบาย ณ ตอนที่จอง (เก็บไว้ใน booking.policy_id) ไม่ใช่นโยบายใหม่
router.patch(
  '/policy',
  route(async (req, res) => {
    const b = req.body;
    const depositPercent = Number(b.depositPercent);
    if (b.depositPercent === '' || !Number.isFinite(depositPercent) || depositPercent <= 0 || depositPercent > 100) {
      throw new HttpError(400, 'เปอร์เซ็นต์มัดจำต้องเป็นตัวเลข 0-100');
    }
    const cancelHours = policyHours(b.cancelHoursBefore, 'ยกเลิกได้ก่อนเวลาเริ่ม ');
    const editHours = policyHours(b.allowEditBeforeHours, 'แก้ไขการจองได้ก่อนเวลาเริ่ม ', true);
    const text = (v) => (typeof v === 'string' && v.trim() ? v.trim().slice(0, 500) : null);
    const policy = await withTransaction(async (client) => {
      await client.query('UPDATE shop_policy SET effective_to = now() WHERE effective_to IS NULL');
      return (
        await client.query(
          `INSERT INTO shop_policy (deposit_percent, cancel_hours_before, allow_edit_before_hours,
         refund_policy_desc, no_show_policy_desc, effective_from, updated_by)
       VALUES ($1, $2, $3, $4, $5, now(), $6)
       RETURNING *`,
          [depositPercent, cancelHours, editHours, text(b.refundPolicyDesc), text(b.noShowPolicyDesc), req.user.id],
        )
      ).rows[0];
    });
    res.json(policy);
  }),
);

const DAY_NAMES = ['อาทิตย์', 'จันทร์', 'อังคาร', 'พุธ', 'พฤหัสบดี', 'ศุกร์', 'เสาร์'];

// PATCH /api/admin/shop/hours   { hours: [{ dayOfWeek, openHour, closeHour, customRates, ...พีคไทม์ }, ...] }
// -- การ์ด "เวลาเปิด-ปิดร้าน" (แยกแต่ละวัน) + พีคไทม์เฉพาะวัน
router.patch(
  '/shop/hours',
  route(async (req, res) => {
    const { hours } = req.body;
    if (!Array.isArray(hours) || !hours.length) throw new HttpError(400, 'ต้องส่ง hours เป็น array');
    // ตรวจก่อนบันทึก: วัน 0-6 (อาทิตย์-เสาร์) / ชั่วโมง 0-24 / เวลาเปิดต้องไม่เกินเวลาปิด (เปิด = ปิด แปลว่าปิดทั้งวัน)
    const isInt = (v, min, max) => Number.isInteger(v) && v >= min && v <= max;
    for (const h of hours) {
      if (!isInt(h?.dayOfWeek, 0, 6)) throw new HttpError(400, 'วันในสัปดาห์ต้องเป็น 0-6 (อาทิตย์-เสาร์)');
      if (!isInt(h.openHour, 0, 24) || !isInt(h.closeHour, 0, 24)) {
        throw new HttpError(400, 'เวลาเปิด-ปิดต้องเป็นชั่วโมงเต็ม 0-24');
      }
      if (h.openHour > h.closeHour) {
        throw new HttpError(400, 'เวลาเปิดต้องไม่เกินเวลาปิด (ตั้งเปิดและปิดเท่ากัน = ปิดทั้งวัน)');
      }
    }
    const saved = await withTransaction(async (client) => {
      const shop = await getShop(client);
      if (!shop) throw new HttpError(404, 'ยังไม่ได้ตั้งค่าร้าน');
      for (const h of hours) {
        await client.query(
          'UPDATE shop_hours SET open_hour = $1, close_hour = $2 WHERE shop_id = $3 AND day_of_week = $4',
          [h.openHour, h.closeHour, shop.shop_id, h.dayOfWeek],
        );
        // พีคไทม์เฉพาะวันนี้: customRates = true ใช้ค่าที่ส่งมา / false = กลับไปใช้ค่าหลักของร้าน / ไม่ส่งมา = คงเดิม
        if (h.customRates === undefined) continue;
        const label = `วัน${DAY_NAMES[h.dayOfWeek]}: `;
        const rates = h.customRates ? parseRates(h, label) : null;
        await client.query(
          `UPDATE shop_hours SET custom_rates = $3,
             peak_start_time = $4, peak_end_time = $5, peak_surcharge = $6
           WHERE shop_id = $1 AND day_of_week = $2`,
          [
            shop.shop_id,
            h.dayOfWeek,
            Boolean(rates),
            rates?.peak_start_time ?? null,
            rates?.peak_end_time ?? null,
            rates?.peak_surcharge ?? 0,
          ],
        );
      }
      return (await client.query('SELECT * FROM shop_hours WHERE shop_id = $1 ORDER BY day_of_week', [shop.shop_id]))
        .rows;
    });
    res.json(saved);
  }),
);

/* ============================================================
 * ประเภทห้อง (หน้า "ประเภทห้อง") — S/M/L/XL หรือประเภทที่แอดมินเพิ่มเอง
 * ========================================================== */

// ตัดช่องว่างหัวท้าย + เช็คความยาว (ถ้าไม่ได้ส่งมา จะคืน undefined → ตอนบันทึกจะใช้ค่าเดิม)
function trimmedText(value, maxLength, label) {
  if (typeof value !== 'string') return value;
  const text = value.trim();
  if (text.length > maxLength) throw new HttpError(400, `${label}ต้องไม่เกิน ${maxLength} ตัวอักษร`);
  return text;
}

// ราคาต่อชั่วโมง: มากกว่า 0 และไม่เกิน 100,000 บาท (ห้ามราคา 0 เพราะมัดจำจะเป็น 0 ลูกค้าจ่ายมัดจำไม่ได้)
function parsePrice(value, label) {
  const n = Number(value);
  if (value === '' || value === null || !Number.isFinite(n) || n <= 0 || n > 100000) {
    throw new HttpError(400, `${label}ต้องมากกว่า 0 และไม่เกิน 100,000 บาท`);
  }
  return n;
}

// จำนวนคน: จำนวนเต็ม 1-100
function parseCapacity(value, label) {
  const n = Number(value);
  if (value === '' || value === null || !Number.isInteger(n) || n < 1 || n > 100) {
    throw new HttpError(400, `${label}ต้องเป็นจำนวนเต็ม 1-100 คน`);
  }
  return n;
}

// ตรวจข้อมูลประเภทห้องจากฟอร์ม (ใช้ทั้งตอนเพิ่มและตอนแก้ไข — ต้องส่งมาครบทุกช่อง)
function parseRoomTypeBody(body) {
  const code = typeof body.code === 'string' ? body.code.trim().toUpperCase() : '';
  if (!/^[A-Z0-9-]{1,10}$/.test(code)) {
    throw new HttpError(400, 'รหัสประเภทต้องเป็นตัวอักษรอังกฤษ/ตัวเลข ไม่เกิน 10 ตัว เช่น S, M, VIP');
  }
  const name = trimmedText(body.name, 100, 'ชื่อประเภท');
  if (!name) throw new HttpError(400, 'กรุณากรอกชื่อประเภท');
  const capacityMin = parseCapacity(body.capacityMin, 'ความจุต่ำสุด');
  const capacityMax = parseCapacity(body.capacityMax, 'ความจุสูงสุด');
  if (capacityMax < capacityMin) throw new HttpError(400, 'ความจุสูงสุดต้องไม่น้อยกว่าความจุต่ำสุด');
  return {
    code,
    name,
    capacityMin,
    capacityMax,
    basePrice: parsePrice(body.basePricePerHour, 'ราคาห้องธรรมดา'),
    description: trimmedText(body.description, 300, 'คำอธิบาย') || null,
  };
}

const ROOM_TYPE_ERRORS = { 23505: [409, 'รหัสประเภทนี้มีอยู่แล้ว'] };

// GET /api/admin/room-types -- ทุกประเภท + จำนวนห้อง (ทั้งหมด / ห้องธรรมดา / ห้องธีม)
router.get(
  '/room-types',
  route(async (req, res) => {
    const types = await pool.query(
      `SELECT t.*,
              COUNT(r.room_id)::int AS room_count,
              COUNT(r.room_id) FILTER (WHERE r.theme IS NULL)::int AS normal_room_count,
              COUNT(r.room_id) FILTER (WHERE r.theme IS NOT NULL)::int AS theme_room_count
       FROM room_type t LEFT JOIN room r ON r.type_id = t.type_id
       GROUP BY t.type_id
       ORDER BY t.capacity_min, t.code`,
    );
    res.json(types.rows);
  }),
);

// POST /api/admin/room-types  { code, name, capacityMin, capacityMax, basePricePerHour, description }
router.post(
  '/room-types',
  route(async (req, res) => {
    const t = parseRoomTypeBody(req.body);
    const type = (
      await pool.query(
        `INSERT INTO room_type (code, name, capacity_min, capacity_max, base_price_per_hour, description)
         VALUES ($1, $2, $3, $4, $5, $6)
         RETURNING *`,
        [t.code, t.name, t.capacityMin, t.capacityMax, t.basePrice, t.description],
      )
    ).rows[0];
    res.status(201).json(type);
  }, ROOM_TYPE_ERRORS),
);

// PATCH /api/admin/room-types/:id  { code, name, capacityMin, capacityMax, basePricePerHour, description, applyToRoomIds }
// applyToRoomIds = ห้องธรรมดาที่แอดมินติ๊กให้เปลี่ยนเป็นราคาใหม่ของประเภทนี้ (ไม่ติ๊กเลย = ไม่เปลี่ยนราคาห้องไหน)
// ห้องธีมจะไม่ถูกเปลี่ยนราคาจากตรงนี้เด็ดขาด (ราคาห้องธีมแอดมินตั้งเองรายห้องที่หน้าตั้งค่าห้อง)
router.patch(
  '/room-types/:id',
  route(async (req, res) => {
    const t = parseRoomTypeBody(req.body);
    const ids = req.body.applyToRoomIds ?? [];
    if (!Array.isArray(ids) || !ids.every((id) => Number.isInteger(id) && id > 0)) {
      throw new HttpError(400, 'รายการห้องที่จะเปลี่ยนราคาไม่ถูกต้อง');
    }
    const result = await withTransaction(async (client) => {
      const type = (
        await client.query(
          `UPDATE room_type SET code = $2, name = $3, capacity_min = $4, capacity_max = $5,
             base_price_per_hour = $6, description = $7
           WHERE type_id = $1
           RETURNING *`,
          [req.params.id, t.code, t.name, t.capacityMin, t.capacityMax, t.basePrice, t.description],
        )
      ).rows[0];
      if (!type) throw new HttpError(404, 'ไม่พบประเภทห้อง');
      const updated = await client.query(
        `UPDATE room SET price_per_hour = $2
         WHERE type_id = $1 AND theme IS NULL AND room_id = ANY($3::int[])
         RETURNING room_id`,
        [type.type_id, t.basePrice, ids],
      );
      return { ...type, updated_room_count: updated.rowCount };
    });
    res.json(result);
  }, ROOM_TYPE_ERRORS),
);

// DELETE /api/admin/room-types/:id -- ลบประเภทห้อง (ลบได้เฉพาะประเภทที่ไม่มีห้องเหลืออยู่แล้ว)
router.delete(
  '/room-types/:id',
  route(
    async (req, res) => {
      const type = (await pool.query('DELETE FROM room_type WHERE type_id = $1 RETURNING *', [req.params.id])).rows[0];
      if (!type) throw new HttpError(404, 'ไม่พบประเภทห้อง');
      res.json(type);
    },
    { 23503: [409, 'ลบประเภทนี้ไม่ได้ เนื่องจากยังมีห้องอยู่ในประเภทนี้ (ย้ายหรือลบห้องก่อน)'] },
  ),
);

/* ============================================================
 * ตั้งค่าห้อง (หน้า "ตั้งค่าห้อง")
 * ========================================================== */

// ข้อมูลห้องพร้อมประเภท (type_base_price = ราคาห้องธรรมดาของประเภทนั้น ไว้ให้หน้าเว็บเทียบว่าห้องนี้ราคาต่างไหม)
const ADMIN_ROOM_SQL = `
  SELECT r.*, ${ROOM_TYPE_COLUMNS}, t.base_price_per_hour AS type_base_price
  FROM room r ${joinRoomType('r')}`;

async function getAdminRoom(db, roomId) {
  return (await db.query(`${ADMIN_ROOM_SQL} WHERE r.room_id = $1`, [roomId])).rows[0];
}

async function getRoomType(db, typeId) {
  const type = (await db.query('SELECT * FROM room_type WHERE type_id = $1', [typeId])).rows[0];
  if (!type) throw new HttpError(404, 'ไม่พบประเภทห้อง');
  return type;
}

// GET /api/admin/rooms -- ทุกห้อง (รวมที่ปิดให้บริการ) เรียงตามประเภท
router.get(
  '/rooms',
  route(async (req, res) => {
    res.json((await pool.query(`${ADMIN_ROOM_SQL} ORDER BY t.capacity_min, t.code, r.room_name`)).rows);
  }),
);

// PATCH /api/admin/rooms/:id  { roomName, typeId, capacity, pricePerHour, imageUrl, isActive, description, theme }
// theme (ชื่อธีม): ว่าง = ห้องธรรมดา / มีชื่อ = ห้องธีม / ไม่ส่งมา = คงเดิม · ช่องอื่นที่ไม่ได้ส่งมา = คงค่าเดิม
router.patch(
  '/rooms/:id',
  route(
    async (req, res) => {
      const { roomName, typeId, imageUrl, isActive } = req.body;
      const capacity = req.body.capacity === undefined ? undefined : parseCapacity(req.body.capacity, 'ความจุ');
      const price =
        req.body.pricePerHour === undefined ? undefined : parsePrice(req.body.pricePerHour, 'ราคาต่อชั่วโมง');
      const description = trimmedText(req.body.description, 300, 'หมายเหตุ');
      const theme = trimmedText(req.body.theme, 100, 'ธีมห้อง');
      const updated = await pool.query(
        `UPDATE room SET
           room_name = COALESCE($1, room_name),
           type_id = COALESCE($2, type_id),
           capacity = COALESCE($3, capacity),
           price_per_hour = COALESCE($4, price_per_hour),
           image_url = COALESCE($5, image_url),
           is_active = COALESCE($6, is_active),
           description = COALESCE($7, description),
           theme = CASE WHEN $8::text IS NULL THEN theme ELSE NULLIF($8::text, '') END
         WHERE room_id = $9`,
        [roomName, typeId, capacity, price, imageUrl, isActive, description, theme, req.params.id],
      );
      if (!updated.rowCount) throw new HttpError(404, 'ไม่พบห้อง');
      res.json(await getAdminRoom(pool, req.params.id));
    },
    { 23503: [404, 'ไม่พบประเภทห้อง'] },
  ),
);

// สร้างห้องใหม่ 1 ห้องในประเภทนี้ — ความจุและราคาเริ่มต้นใช้ค่าของประเภท (เป็นห้องธรรมดา)
async function insertRoom(db, type, roomName) {
  const shop = await getShop(db);
  const room = (
    await db.query(
      `INSERT INTO room (shop_id, room_code, room_name, type_id, capacity, price_per_hour)
       VALUES ($1, $2, $3, $4, $5, $6)
       RETURNING room_id`,
      [shop?.shop_id || null, makeCode('R'), roomName, type.type_id, type.capacity_max, type.base_price_per_hour],
    )
  ).rows[0];
  return getAdminRoom(db, room.room_id);
}

const BULK_MAX_PER_TYPE = 20;
const BULK_MAX_TOTAL = 50;

// POST /api/admin/rooms/bulk  { items: [{ typeId, count }, ...] } -- ปุ่ม "เพิ่มห้องตามประเภท" (เพิ่มทีละหลายห้อง)
// ตั้งชื่อให้อัตโนมัติ เช่น มี S-01, S-02 อยู่แล้ว เพิ่มอีก 2 ห้อง → S-03, S-04 (แก้ชื่อทีหลังได้)
router.post(
  '/rooms/bulk',
  route(async (req, res) => {
    const { items } = req.body;
    if (!Array.isArray(items)) throw new HttpError(400, 'ต้องส่ง items เป็น array');
    const wanted = items.filter((it) => Number(it?.count) !== 0);
    for (const it of wanted) {
      const n = Number(it.count);
      if (!Number.isInteger(n) || n < 0 || n > BULK_MAX_PER_TYPE) {
        throw new HttpError(400, `จำนวนห้องต่อประเภทต้องเป็นจำนวนเต็ม 0-${BULK_MAX_PER_TYPE}`);
      }
    }
    const total = wanted.reduce((sum, it) => sum + Number(it.count), 0);
    if (total < 1) throw new HttpError(400, 'กรุณาใส่จำนวนห้องที่จะเพิ่มอย่างน้อย 1 ห้อง');
    if (total > BULK_MAX_TOTAL) throw new HttpError(400, `เพิ่มได้ครั้งละไม่เกิน ${BULK_MAX_TOTAL} ห้อง`);

    const created = await withTransaction(async (client) => {
      const rooms = [];
      for (const it of wanted) {
        const type = await getRoomType(client, it.typeId);
        // หาเลขที่มากที่สุดของชื่อแบบ "S-01" ในประเภทนี้ (ห้องที่แอดมินเปลี่ยนชื่อไปแล้วไม่นับ)
        const last = (
          await client.query(
            `SELECT COALESCE(MAX(substring(room_name FROM '^' || $1 || '-([0-9]+)$')::int), 0) AS n
             FROM room WHERE room_name ~ ('^' || $1 || '-[0-9]+$')`,
            [type.code],
          )
        ).rows[0].n;
        for (let i = 1; i <= Number(it.count); i++) {
          rooms.push(await insertRoom(client, type, `${type.code}-${String(last + i).padStart(2, '0')}`));
        }
      }
      return rooms;
    });
    res.status(201).json(created);
  }),
);

// DELETE /api/admin/rooms/:id -- ลบห้อง (ห้องที่เคยมีการจองแล้วลบไม่ได้ ให้กด "ปิดให้บริการ" แทน)
router.delete(
  '/rooms/:id',
  route(
    async (req, res) => {
      const room = (await pool.query('DELETE FROM room WHERE room_id = $1 RETURNING *', [req.params.id])).rows[0];
      if (!room) throw new HttpError(404, 'ไม่พบห้อง');
      res.json(room);
    },
    { 23503: [409, 'ลบห้องนี้ไม่ได้ เนื่องจากมีประวัติการจองผูกอยู่กับห้องนี้แล้ว'] },
  ),
);

/* ============================================================
 * รายงาน (หน้า "รายงาน" รายวัน/รายสัปดาห์/รายเดือน)
 * ========================================================== */

// ย้อนหลังกี่วัน/สัปดาห์/เดือน ของแต่ละแบบรายงาน — ต้องตรงกับ RANGE_LABEL ในหน้ารายงาน (AdminReportsPage)
const REPORT_RANGE_START = {
  day: `CURRENT_DATE - 6`, // 7 วันล่าสุด (รวมวันนี้)
  week: `date_trunc('week', CURRENT_DATE)::date - 21`, // 4 สัปดาห์ล่าสุด (รวมสัปดาห์นี้)
  month: `(date_trunc('month', CURRENT_DATE) - interval '5 months')::date`, // 6 เดือนล่าสุด (รวมเดือนนี้)
};

// GET /api/admin/reports?period=day|week|month -- หน้า "รายงานสรุป": รายได้ตามช่วงเวลา, แยกตามห้อง และยอดรวม
router.get(
  '/reports',
  route(async (req, res) => {
    const period = ['day', 'week', 'month'].includes(req.query.period) ? req.query.period : 'day';
    const inRange = (a) => `${revenueFilter(a)} AND ${a}.booking_date >= ${REPORT_RANGE_START[period]}`;
    const trend = await pool.query(
      `SELECT date_trunc($1, booking_date::timestamp) AS period, SUM(${revenueSql('booking')}) AS revenue, COUNT(*) AS bookings
     FROM booking WHERE ${inRange('booking')}
     GROUP BY 1 ORDER BY 1`,
      [period],
    );
    const byRoom = await pool.query(`
    SELECT r.room_name, SUM(${revenueSql('b')}) AS revenue, COUNT(*) AS bookings
    FROM booking b JOIN room r ON r.room_id = b.room_id
    WHERE ${inRange('b')}
    GROUP BY r.room_name
    ORDER BY revenue DESC`);
    const totals = await pool.query(`
    SELECT COALESCE(SUM(${revenueSql('booking')}),0) AS total_revenue,
           COUNT(*) AS total_bookings,
           COALESCE(ROUND(AVG(${revenueSql('booking')}),2),0) AS avg_ticket
    FROM booking WHERE ${inRange('booking')}`);
    res.json({ period, trend: trend.rows, byRoom: byRoom.rows, totals: totals.rows[0] });
  }),
);

module.exports = router;
