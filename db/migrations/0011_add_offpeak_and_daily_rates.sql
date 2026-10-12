-- Migration: 0011_add_offpeak_and_daily_rates
--
-- ราคาตามช่วงเวลา: พีคไทม์ (มีเวลาสิ้นสุดได้แล้ว) + ออฟพีคไทม์ (ส่วนลด บาท/ชม.)
--   shop.peak_end_time       -- พีคสิ้นสุดเวลาไหน (NULL = ถึงร้านปิด แบบเดิม)
--   shop.offpeak_start_time  -- ออฟพีคเริ่ม (NULL = ไม่มีออฟพีค)
--   shop.offpeak_end_time    -- ออฟพีคสิ้นสุด (NULL = ถึงร้านปิด)
--   shop.offpeak_discount    -- ส่วนลดช่วงออฟพีค บาท/ชม.
-- ค่าใน shop = ใช้ทุกวัน / ถ้าวันไหนตั้ง shop_hours.custom_rates = true จะใช้ราคาตามช่วงเวลาของวันนั้นแทน
-- booking.offpeak_discount_total -- ส่วนลดออฟพีครวมของการจองนั้น (price_total = base + พีค - ออฟพีค)
--
-- วิธี apply:
--   psql "$DATABASE_URL" -f db/migrations/0011_add_offpeak_and_daily_rates.sql
--   (หรือเปิดไฟล์นี้ใน Query Tool ของ pgAdmin แล้วกด Execute — รันซ้ำได้)

BEGIN;

ALTER TABLE shop ADD COLUMN IF NOT EXISTS peak_end_time TIME;
ALTER TABLE shop ADD COLUMN IF NOT EXISTS offpeak_start_time TIME;
ALTER TABLE shop ADD COLUMN IF NOT EXISTS offpeak_end_time TIME;
ALTER TABLE shop ADD COLUMN IF NOT EXISTS offpeak_discount NUMERIC(10,2) NOT NULL DEFAULT 0;

ALTER TABLE shop_hours ADD COLUMN IF NOT EXISTS custom_rates BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE shop_hours ADD COLUMN IF NOT EXISTS peak_start_time TIME;
ALTER TABLE shop_hours ADD COLUMN IF NOT EXISTS peak_end_time TIME;
ALTER TABLE shop_hours ADD COLUMN IF NOT EXISTS peak_surcharge NUMERIC(10,2) NOT NULL DEFAULT 0;
ALTER TABLE shop_hours ADD COLUMN IF NOT EXISTS offpeak_start_time TIME;
ALTER TABLE shop_hours ADD COLUMN IF NOT EXISTS offpeak_end_time TIME;
ALTER TABLE shop_hours ADD COLUMN IF NOT EXISTS offpeak_discount NUMERIC(10,2) NOT NULL DEFAULT 0;

ALTER TABLE booking ADD COLUMN IF NOT EXISTS offpeak_discount_total NUMERIC(10,2) NOT NULL DEFAULT 0;

COMMIT;
