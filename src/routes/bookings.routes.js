// API การจองฝั่งลูกค้า (/api/bookings/...) — จองห้อง, ดูประวัติการจอง, แก้ไข และยกเลิกการจอง
// ลำดับปกติ: ลูกค้าเลือกเวลา → POST /api/bookings (สถานะ pending) → แนบสลิป (payments) → แอดมินตรวจและยืนยัน
//
// 📘 พื้นฐาน SQL ที่ทุกไฟล์ route ใช้ — อธิบายไว้ที่นี่ที่เดียว ไฟล์อื่นอ้างกลับมา ("ดูพื้นฐาน SQL ที่ bookings.routes.js")
//
// ส่งคำสั่ง:  pool.query(`SQL`, [ค่า1, ค่า2]) → ได้ { rows: [...แถวที่ได้] } — .rows[0] = แถวแรก (ไม่พบ = undefined)
//   $1, $2 = ช่องว่างที่ฐานข้อมูลเติมค่าจาก [ค่า1, ค่า2] ให้เอง ห้ามเอาค่าที่ผู้ใช้ส่งมาต่อเข้าไปในข้อความ SQL ตรงๆ
//            เพราะผู้ใช้อาจพิมพ์คำสั่ง SQL แฝงมา (SQL injection) — แบบ $1 ฐานข้อมูลถือเป็น "ข้อมูล" เสมอ
//   ${...} ในข้อความ SQL = ชิ้น SQL ที่เราเขียนเองในโค้ด (เช่น ROOM_TYPE_COLUMNS) ไม่ใช่ค่าจากผู้ใช้ จึงต่อได้
//
// คำสั่งหลัก:
//   SELECT ... FROM ตาราง WHERE เงื่อนไข   = อ่านข้อมูล (ORDER BY ... DESC = เรียงมากไปน้อย / LIMIT n = เอาแค่ n แถว)
//   INSERT INTO ตาราง (...) VALUES (...)    = เพิ่มแถวใหม่
//   UPDATE ตาราง SET ... WHERE ...          = แก้แถวที่ตรงเงื่อนไข / DELETE FROM ... WHERE ... = ลบ
//   RETURNING *                             = ทำเสร็จแล้วส่งแถวที่เพิ่ม/แก้/ลบกลับมาด้วย (ไม่ต้อง SELECT ซ้ำ)
//
// รวมหลายตาราง:
//   JOIN room r ON r.room_id = b.room_id    = เอาข้อมูลห้องมาต่อท้ายการจอง (b, r = ชื่อย่อของตาราง)
//                                             ไม่มีห้องที่ตรงกัน → แถวนั้นหายไปจากผล
//   LEFT JOIN ...                           = เหมือน JOIN แต่ไม่ทิ้งแถว ถ้าไม่มีข้อมูลคู่ ช่องนั้นเป็น NULL
//                                             (เช่น การจองที่ยังไม่ Check-in ไม่มี service_session ก็ยังได้แถวการจอง)
//   LEFT JOIN LATERAL (SELECT ...) x ON true = ต่อผลของ SELECT ย่อย (เช่น นโยบายล่าสุด) ให้ทุกแถว
//
// ฟังก์ชันที่เจอบ่อย:
//   COALESCE(a, b, 0)          = ใช้ค่าแรกที่ไม่ใช่ NULL (a ว่าง → ใช้ b → ว่างอีก → ใช้ 0)
//   EXISTS (SELECT 1 ...)      = มีแถวที่ตรงเงื่อนไขไหม → true/false (NOT EXISTS = ไม่มี)
//   CASE WHEN ก THEN x ELSE y END = if-else ใน SQL
//   SUM / COUNT(*) ... GROUP BY = รวมยอด/นับ แยกตามกลุ่ม · COUNT(*) FILTER (WHERE ...) = นับเฉพาะแถวที่ตรงเงื่อนไข
//   LOCALTIMESTAMP             = เวลาปัจจุบันของฐานข้อมูล (ตั้งเป็นเวลาไทยไว้) · interval '1 hour' = ระยะเวลา 1 ชม.
//
// กันข้อมูลชนกัน:
//   withTransaction(...)       = หลายคำสั่ง "สำเร็จทั้งหมดหรือไม่เลย" (ดู db.js)
//   SELECT ... FOR UPDATE      = ล็อกแถวที่อ่านไว้จนจบ transaction — อีกคำขอที่จะแก้แถวเดียวกันต้องรอ
//                                (กันกรณีกดพร้อมกัน 2 ครั้ง แล้วทั้งคู่เห็นข้อมูลเก่า)
//
// รหัส error จากฐานข้อมูล (แปลงเป็นข้อความด้วย route(..., { รหัส: [สถานะ, ข้อความ] }) ใน utils/http.js):
//   23P01 = เวลาซ้อนกับการจองอื่นของห้องเดียวกัน (ตาราง booking ตั้งกฎไว้ว่าการจอง pending/confirmed ห้ามทับกัน)
//   23503 = อ้างถึงข้อมูลที่ไม่มีอยู่ หรือจะลบข้อมูลที่ยังถูกใช้อยู่ · 23505 = ค่าซ้ำกับที่มีแล้ว (เช่น เบอร์โทรซ้ำ)
const router = require('express').Router();
const { pool, withTransaction } = require('../db');
const { HttpError, route } = require('../utils/http');
const { findActiveRoom, quoteBooking } = require('../utils/quoteBooking');
const { expireStalePendingBookings } = require('../utils/expireBookings');
const { isStartInPast } = require('../utils/time');
const { submittedDepositSql } = require('../utils/deposit');
const { requireCustomer, requireLogin } = require('../utils/auth');
const { reasonText } = require('../utils/validate');
const { ROOM_TYPE_COLUMNS, joinRoomType } = require('../utils/roomType');
const { LATEST_POLICY_SQL } = require('../utils/shop');

const NOTE_MAX_LENGTH = 300; // หมายเหตุถึงร้าน ยาวได้ไม่เกิน 300 ตัวอักษร

// POST /api/bookings  { roomId, startDatetime, endDatetime, guestCount, note }
// -- ลูกค้ากด "ยืนยันและชำระมัดจำ" → สร้างการจองสถานะ pending แล้วไปหน้าแนบสลิป
// ผู้จอง = ลูกค้าที่ล็อกอินอยู่เสมอ (ดูจาก token ไม่เชื่อรหัสลูกค้าที่หน้าเว็บส่งมา)
// ถ้าเวลาชนกับคนอื่น ฐานข้อมูลจะไม่ยอมบันทึก (error 23P01) แล้วเราตอบว่า "ช่วงเวลานี้ถูกจองไปแล้ว"
router.post(
  '/',
  requireCustomer,
  route(
    async (req, res) => {
      const { roomId, startDatetime, endDatetime, guestCount } = req.body;
      if (!roomId || !startDatetime || !endDatetime) {
        throw new HttpError(400, 'ข้อมูลไม่ครบ (roomId, startDatetime, endDatetime)');
      }
      const note = typeof req.body.note === 'string' ? req.body.note.trim() : '';
      if (note.length > NOTE_MAX_LENGTH) throw new HttpError(400, `หมายเหตุต้องไม่เกิน ${NOTE_MAX_LENGTH} ตัวอักษร`);
      if (isStartInPast(startDatetime)) throw new HttpError(400, 'เวลาที่เลือกผ่านไปแล้ว กรุณาเลือกเวลาอื่น');

      await expireStalePendingBookings();
      const room = await findActiveRoom(roomId);
      const q = await quoteBooking(room, startDatetime, endDatetime);

      // เพิ่มการจองใหม่ — ราคา/มัดจำใช้ค่าที่ backend คิดเอง (q) ไม่ใช่ค่าจากหน้าเว็บ / RETURNING * = ได้แถวที่เพิ่งสร้างกลับมา
      const booking = (
        await pool.query(
          `INSERT INTO booking (
       booking_code, customer_id, room_id, policy_id, booking_source,
       booking_date, start_datetime, end_datetime, guest_count, booking_status,
       base_price, peak_surcharge_total, price_total, deposit_required, deposit_status, note
     ) VALUES ($1,$2,$3,$4,'customer_online',$5,$6,$7,$8,'pending',$9,$10,$11,$12,'unpaid',$13)
     RETURNING *`,
          [
            q.bookingCode,
            req.user.id,
            roomId,
            q.policyId,
            q.bookingDate,
            startDatetime,
            endDatetime,
            guestCount || null,
            q.basePrice,
            q.peakSurchargeTotal,
            q.priceTotal,
            q.depositRequired,
            note || null,
          ],
        )
      ).rows[0];
      res.status(201).json(booking);
    },
    {
      '23P01': [409, 'ช่วงเวลานี้ถูกจองไปแล้ว กรุณาเลือกเวลาอื่น'],
      23503: [404, 'ไม่พบบัญชีผู้ใช้นี้ กรุณาเข้าสู่ระบบใหม่'],
    },
  ),
);

// GET /api/bookings/customer/:customerId -- หน้า "ประวัติการจอง" ของลูกค้า (ดูได้เฉพาะของตัวเอง ใหม่สุดอยู่บน)
router.get(
  '/customer/:customerId',
  requireCustomer,
  route(async (req, res) => {
    if (Number(req.params.customerId) !== req.user.id) throw new HttpError(403, 'ดูได้เฉพาะประวัติของตัวเอง');
    await expireStalePendingBookings();
    // การจอง + ข้อมูลห้อง (JOIN) + ข้อมูล Check-in (LEFT JOIN: ยังไม่เข้าห้อง = ช่องเป็น NULL แต่การจองยังอยู่ในผล)
    const result = await pool.query(
      `SELECT b.*, r.room_name, r.image_url, r.capacity, ${ROOM_TYPE_COLUMNS},
            s.session_status, s.checkin_time, s.checkout_time,
            ${submittedDepositSql('b')} AS paid_amount
     FROM booking b JOIN room r ON r.room_id = b.room_id ${joinRoomType('r')}
     LEFT JOIN service_session s ON s.booking_id = b.booking_id
     WHERE b.customer_id = $1
     ORDER BY b.created_at DESC`,
      [req.params.customerId],
    );
    res.json(result.rows);
  }),
);

// GET /api/bookings/:id -- ข้อมูลการจองรายการเดียว (ใช้ตอนรีเฟรชหน้าชำระเงิน / กด "ชำระมัดจำ" ต่อจากหน้าประวัติ)
// ลูกค้าดูได้เฉพาะของตัวเอง (ของคนอื่นตอบว่าไม่พบ เหมือนไม่มีรายการนี้) / แอดมินดูได้ทุกรายการ
router.get(
  '/:id',
  requireLogin,
  route(async (req, res) => {
    if (!/^\d+$/.test(req.params.id)) throw new HttpError(400, 'รหัสการจองไม่ถูกต้อง');
    await expireStalePendingBookings();
    // deposit_percent: ใช้ % มัดจำของนโยบายที่ผูกกับการจอง ถ้าไม่มี (การจองเก่า) ใช้ของนโยบายล่าสุดแทน (COALESCE)
    const booking = (
      await pool.query(
        `SELECT b.*, r.room_name, r.image_url, r.capacity, ${ROOM_TYPE_COLUMNS},
            ${submittedDepositSql('b')} AS paid_amount,
            COALESCE(p.deposit_percent, (SELECT deposit_percent FROM (${LATEST_POLICY_SQL}) latest)) AS deposit_percent
     FROM booking b JOIN room r ON r.room_id = b.room_id ${joinRoomType('r')}
     LEFT JOIN shop_policy p ON p.policy_id = b.policy_id
     WHERE b.booking_id = $1`,
        [req.params.id],
      )
    ).rows[0];
    if (!booking || (req.user.role === 'customer' && booking.customer_id !== req.user.id)) {
      throw new HttpError(404, 'ไม่พบรายการจอง');
    }
    res.json(booking);
  }),
);

const hhmm = (datetime) => String(datetime).slice(11, 16);
const baht = (n) => Number(n).toLocaleString('th-TH');

// PATCH /api/bookings/:id/edit  { roomId, startDatetime, endDatetime }
// -- ลูกค้าเปลี่ยนห้อง/เวลา ของการจองที่ส่งสลิปมัดจำแล้ว (ต้องเป็นวันเดิม และยังไม่ Check-in)
// เงื่อนไขเวลา: ต้องแก้ก่อนเวลาเริ่มเดิมอย่างน้อย "แก้ไขการจองได้ก่อนเวลาเริ่ม" ชั่วโมง
//   (ถ้าร้านไม่ได้ตั้งไว้ ใช้ค่าเดียวกับ "ยกเลิกได้ก่อนเวลาเริ่ม")
// เรื่องมัดจำ:
//   - มัดจำใหม่สูงกว่าที่จ่ายแล้ว → ต้องจ่ายส่วนต่าง การจองกลับเป็น pending ให้แอดมินตรวจสลิปและยืนยันใหม่
//   - มัดจำใหม่ต่ำกว่า → ไม่คืนส่วนต่าง (ลูกค้าเปลี่ยนเองตามนโยบายร้าน)
// สิ่งที่เปลี่ยนจะถูกเขียนต่อท้ายหมายเหตุ (note) ให้แอดมินเห็น
router.patch(
  '/:id/edit',
  requireCustomer,
  route(
    async (req, res) => {
      const { roomId, startDatetime, endDatetime } = req.body;
      if (!roomId || !startDatetime || !endDatetime) {
        throw new HttpError(400, 'ข้อมูลไม่ครบ (roomId, startDatetime, endDatetime)');
      }
      if (isStartInPast(startDatetime)) throw new HttpError(400, 'เวลาที่เลือกผ่านไปแล้ว กรุณาเลือกเวลาอื่น');
      await expireStalePendingBookings();
      const updated = await withTransaction(async (client) => {
        // ดึงการจองเดิม + ให้ฐานข้อมูลคิดว่า "ยังอยู่ในเวลาที่แก้ได้ไหม" (within_window) แล้วล็อกแถวไว้กันคนอื่นแก้พร้อมกัน
        // within_window = เวลาเริ่ม > ตอนนี้ + (ชม.ที่ต้องแก้ล่วงหน้า × 1 ชม.) — ไม่ได้ตั้งชม.แก้ไข ใช้ชม.ยกเลิกแทน (COALESCE)
        // FOR UPDATE OF b = ล็อกเฉพาะแถวการจอง (ไม่ล็อกห้อง/นโยบายที่ JOIN มาด้วย)
        const old = (
          await client.query(
            `SELECT b.*, r.room_name,
              ${submittedDepositSql('b')} AS paid_amount,
              EXISTS (SELECT 1 FROM service_session s WHERE s.booking_id = b.booking_id) AS checked_in,
              COALESCE(p.allow_edit_before_hours, p.cancel_hours_before, 0) AS edit_hours_before,
              b.start_datetime > LOCALTIMESTAMP
                + COALESCE(p.allow_edit_before_hours, p.cancel_hours_before, 0) * interval '1 hour' AS within_window
       FROM booking b
       JOIN room r ON r.room_id = b.room_id
       LEFT JOIN shop_policy p ON p.policy_id = b.policy_id
       WHERE b.booking_id = $1
       FOR UPDATE OF b`,
            [req.params.id],
          )
        ).rows[0];
        if (
          !old ||
          old.customer_id !== req.user.id ||
          !['pending', 'confirmed'].includes(old.booking_status) ||
          old.checked_in
        ) {
          throw new HttpError(404, 'ไม่พบรายการ หรือรายการนี้แก้ไขไม่ได้แล้ว');
        }
        if (Number(old.paid_amount) <= 0) {
          throw new HttpError(409, 'รายการนี้ยังไม่ได้ชำระมัดจำ — ยกเลิกแล้วจองใหม่ได้เลย');
        }
        if (!old.within_window) {
          throw new HttpError(
            409,
            `แก้ไขได้ก่อนเวลาเริ่มอย่างน้อย ${Number(old.edit_hours_before)} ชั่วโมงเท่านั้น กรุณาติดต่อร้าน`,
          );
        }
        if (startDatetime.slice(0, 10) !== old.booking_date)
          throw new HttpError(400, 'เปลี่ยนได้เฉพาะเวลาภายในวันเดิมของการจอง');
        if (
          Number(roomId) === old.room_id &&
          startDatetime === old.start_datetime &&
          endDatetime === old.end_datetime
        ) {
          throw new HttpError(400, 'ไม่มีการเปลี่ยนแปลง');
        }

        const room = await findActiveRoom(roomId, client);
        const q = await quoteBooking(room, startDatetime, endDatetime, client);
        const paid = Number(old.paid_amount);
        const depositRequired = Math.max(paid, q.depositRequired);
        const topUp = depositRequired - paid;

        const change =
          `${old.room_name} ${hhmm(old.start_datetime)}–${hhmm(old.end_datetime)} → ${room.room_name} ${hhmm(startDatetime)}–${hhmm(endDatetime)}` +
          ` · ยอดรวม ${baht(old.price_total)} → ${baht(q.priceTotal)} บาท` +
          (topUp > 0
            ? ` · มัดจำ ${baht(paid)} → ${baht(depositRequired)} (ชำระเพิ่ม ${baht(topUp)} บาท)`
            : ' · มัดจำเดิมพอแล้ว');

        // บันทึกห้อง/เวลา/ราคาใหม่ — $9 = ต้องจ่ายส่วนต่างไหม (true/false):
        //   true → CASE WHEN เปลี่ยนสถานะกลับเป็น pending + มัดจำ unpaid ให้ลูกค้าแนบสลิปส่วนต่าง / false → คงสถานะเดิม
        // note: ต่อข้อความ "[ลูกค้าแก้ไข เวลา] รายละเอียด" ท้ายหมายเหตุเดิม ขึ้นบรรทัดใหม่ (concat_ws = ต่อข้อความด้วยตัวคั่น)
        const booking = (
          await client.query(
            `UPDATE booking SET
         room_id = $2, start_datetime = $3, end_datetime = $4,
         base_price = $5, peak_surcharge_total = $6, price_total = $7, deposit_required = $8,
         booking_status = CASE WHEN $9 THEN 'pending' ELSE booking_status END,
         deposit_status = CASE WHEN $9 THEN 'unpaid' ELSE deposit_status END,
         note = concat_ws(E'\\n', note, '[ลูกค้าแก้ไข ' || to_char(LOCALTIMESTAMP, 'YYYY-MM-DD HH24:MI') || '] ' || $10::text),
         updated_at = now()
       WHERE booking_id = $1
       RETURNING *`,
            [
              old.booking_id,
              room.room_id,
              startDatetime,
              endDatetime,
              q.basePrice,
              q.peakSurchargeTotal,
              q.priceTotal,
              depositRequired,
              topUp > 0,
              change,
            ],
          )
        ).rows[0];
        return { ...booking, room_name: room.room_name, paid_amount: paid, topup_due: topUp };
      });
      res.json(updated);
    },
    { '23P01': [409, 'ช่วงเวลาใหม่ถูกจองไปแล้ว กรุณาเลือกเวลาอื่น'] },
  ),
);

// PATCH /api/bookings/:id/cancel  { reason } -- ลูกค้ายกเลิกการจองของตัวเอง
// ยกเลิกได้เฉพาะก่อนเวลาเริ่มอย่างน้อย "ยกเลิกได้ก่อนเวลาเริ่ม" ชั่วโมง ตามนโยบาย ณ ตอนที่จอง
// (การจองเก่าที่ไม่มีนโยบายผูกไว้ ใช้นโยบายล่าสุด) — เวลาปัจจุบันใช้ของฐานข้อมูล (LOCALTIMESTAMP = เวลาไทย)
// ลูกค้ายกเลิกเอง = ร้านไม่คืนมัดจำ (cancelled_by = 'customer' รายงานนับมัดจำนี้เป็นรายได้)
router.patch(
  '/:id/cancel',
  requireCustomer,
  route(async (req, res) => {
    const booking = await withTransaction(async (client) => {
      // ดึงการจอง + ให้ฐานข้อมูลคิดว่า "ยังอยู่ในเวลาที่ยกเลิกได้ไหม" (within_window) แล้วล็อกแถวไว้
      // ชม.ยกเลิก: ของนโยบายที่ผูกกับการจอง → ไม่มีใช้นโยบายล่าสุด (LEFT JOIN LATERAL ... latest) → ไม่มีอีกใช้ 0
      const found = (
        await client.query(
          `SELECT b.booking_status, b.customer_id,
              EXISTS (SELECT 1 FROM service_session s WHERE s.booking_id = b.booking_id) AS checked_in,
              COALESCE(p.cancel_hours_before, latest.cancel_hours_before, 0) AS cancel_hours_before,
              b.start_datetime > LOCALTIMESTAMP
                + COALESCE(p.cancel_hours_before, latest.cancel_hours_before, 0) * interval '1 hour' AS within_window
       FROM booking b
       LEFT JOIN shop_policy p ON p.policy_id = b.policy_id
       LEFT JOIN LATERAL (${LATEST_POLICY_SQL}) latest ON true
       WHERE b.booking_id = $1
       FOR UPDATE OF b`,
          [req.params.id],
        )
      ).rows[0];
      if (!found || found.customer_id !== req.user.id || !['pending', 'confirmed'].includes(found.booking_status)) {
        throw new HttpError(404, 'ไม่พบรายการ หรือยกเลิกไม่ได้แล้ว');
      }
      // Check-in ไปแล้ว (เข้าห้องแล้ว) ยกเลิกเองไม่ได้ — กรณี Check-in ก่อนเวลาเริ่ม 15 นาทีจะยังอยู่ในช่วงยกเลิกได้
      if (found.checked_in) throw new HttpError(409, 'รายการนี้ Check-in แล้ว ยกเลิกไม่ได้ กรุณาติดต่อร้าน');
      if (!found.within_window) {
        throw new HttpError(
          409,
          `ยกเลิกได้ก่อนเวลาเริ่มอย่างน้อย ${Number(found.cancel_hours_before)} ชั่วโมงเท่านั้น กรุณาติดต่อร้าน`,
        );
      }
      return (
        await client.query(
          `UPDATE booking SET booking_status = 'cancelled', cancel_reason = $2, cancelled_by = 'customer', updated_at = now()
       WHERE booking_id = $1
       RETURNING *`,
          [req.params.id, reasonText(req.body.reason, 'ลูกค้ายกเลิกเอง')],
        )
      ).rows[0];
    });
    res.json(booking);
  }),
);

module.exports = router;
