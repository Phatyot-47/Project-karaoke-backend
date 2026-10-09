-- Migration: 0009_add_cancelled_by_and_cash_payment
--
-- 1) booking.cancelled_by — ใครเป็นคนยกเลิกการจอง: 'customer' (ลูกค้ายกเลิกเอง) / 'shop' (ร้านยกเลิก) / 'system' (หมดเวลาชำระ)
--    ใช้ตามนโยบายมัดจำ: ลูกค้ายกเลิกเอง = ร้านเก็บมัดจำ (นับเป็นรายได้ในรายงาน) / ร้านยกเลิก = ร้านคืนเงินนอกระบบ (ไม่นับ)
-- 2) payment.method เพิ่ม 'cash' — แอดมินบันทึก "รับมัดจำเงินสดแล้ว" ให้ลูกค้าที่จ่ายเงินสดหน้าร้าน
--
-- วิธี apply:
--   psql "$DATABASE_URL" -f db/migrations/0009_add_cancelled_by_and_cash_payment.sql
--   (หรือเปิดไฟล์นี้ใน Query Tool ของ pgAdmin แล้วกด Execute — รันซ้ำได้)

BEGIN;

ALTER TABLE booking ADD COLUMN IF NOT EXISTS cancelled_by VARCHAR(10);
ALTER TABLE booking DROP CONSTRAINT IF EXISTS booking_cancelled_by_check;
ALTER TABLE booking ADD CONSTRAINT booking_cancelled_by_check
  CHECK (cancelled_by IN ('customer', 'shop', 'system'));

-- เติมค่าให้การจองที่ยกเลิกไปแล้ว เท่าที่ดูจากเหตุผลได้ (ที่เหลือไม่รู้ว่าใครยกเลิก ปล่อยเป็น NULL)
UPDATE booking SET cancelled_by = 'system'
WHERE booking_status = 'cancelled' AND cancelled_by IS NULL AND cancel_reason LIKE 'หมดเวลาชำระมัดจำ%';
UPDATE booking SET cancelled_by = 'shop'
WHERE booking_status = 'cancelled' AND cancelled_by IS NULL AND cancel_reason LIKE 'ปฏิเสธสลิป%';
UPDATE booking SET cancelled_by = 'customer'
WHERE booking_status = 'cancelled' AND cancelled_by IS NULL AND cancel_reason = 'ลูกค้ายกเลิกเอง';

ALTER TABLE payment DROP CONSTRAINT IF EXISTS payment_method_check;
ALTER TABLE payment ADD CONSTRAINT payment_method_check CHECK (method IN ('qrcode', 'cash'));

COMMIT;
