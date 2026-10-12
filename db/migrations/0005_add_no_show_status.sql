-- Migration: 0005_add_no_show_status
--
-- รองรับขอบเขตโครงงานข้อ 2.3 — สถานะ No-show (ลูกค้าไม่มาใช้บริการตามเวลาที่จอง)
-- แอดมินกดปุ่ม "ไม่มาใช้บริการ" ได้เมื่อเลยเวลาเริ่มแล้วยังไม่ Check-in → booking_status = 'no_show'
-- (ช่วงเวลาถูกปล่อยว่างทันที เพราะ exclusion constraint ของ booking นับเฉพาะ pending/confirmed
--  และมัดจำที่จ่ายแล้วไม่คืนตาม shop_policy.no_show_policy_desc)
--
-- วิธี apply:
--   psql "$DATABASE_URL" -f db/migrations/0005_add_no_show_status.sql
--   (หรือเปิดไฟล์นี้ใน Query Tool ของ pgAdmin แล้วกด Execute — รันซ้ำได้)

ALTER TABLE booking DROP CONSTRAINT IF EXISTS booking_status_check;
ALTER TABLE booking ADD CONSTRAINT booking_status_check
  CHECK (booking_status IN ('pending', 'confirmed', 'cancelled', 'completed', 'no_show'));

-- ข้อความนโยบาย No-show เริ่มต้น (แก้ไขได้ในหน้าตั้งค่าร้านฝั่งแอดมิน)
UPDATE shop_policy SET no_show_policy_desc = 'ไม่มาใช้บริการตามเวลาที่จอง ร้านขอสงวนสิทธิ์ไม่คืนเงินมัดจำ'
WHERE no_show_policy_desc IS NULL;
