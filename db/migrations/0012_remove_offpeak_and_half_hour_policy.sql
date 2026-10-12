-- Migration: 0012_remove_offpeak_and_half_hour_policy
--
-- 1) ร้านใช้แค่พีคไทม์ → ลบคอลัมน์ออฟพีคที่เพิ่มใน 0011 (ยังเก็บ peak_end_time และการกำหนดพีคเองรายวันไว้)
-- 2) "ยกเลิกได้ก่อนเวลาเริ่ม" / "แก้ไขการจองได้ก่อนเวลาเริ่ม" ตั้งได้ทีละ 0.5 ชั่วโมง → เปลี่ยนเป็นทศนิยม 1 ตำแหน่ง
--
-- วิธี apply:
--   psql "$DATABASE_URL" -f db/migrations/0012_remove_offpeak_and_half_hour_policy.sql
--   (หรือเปิดไฟล์นี้ใน Query Tool ของ pgAdmin แล้วกด Execute — รันซ้ำได้)

BEGIN;

ALTER TABLE shop DROP COLUMN IF EXISTS offpeak_start_time;
ALTER TABLE shop DROP COLUMN IF EXISTS offpeak_end_time;
ALTER TABLE shop DROP COLUMN IF EXISTS offpeak_discount;

ALTER TABLE shop_hours DROP COLUMN IF EXISTS offpeak_start_time;
ALTER TABLE shop_hours DROP COLUMN IF EXISTS offpeak_end_time;
ALTER TABLE shop_hours DROP COLUMN IF EXISTS offpeak_discount;

ALTER TABLE booking DROP COLUMN IF EXISTS offpeak_discount_total;

ALTER TABLE shop_policy ALTER COLUMN cancel_hours_before TYPE NUMERIC(4,1);
ALTER TABLE shop_policy ALTER COLUMN allow_edit_before_hours TYPE NUMERIC(4,1);

COMMIT;
