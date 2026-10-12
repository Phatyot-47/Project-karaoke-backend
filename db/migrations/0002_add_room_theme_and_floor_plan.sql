-- Migration: 0002_add_room_theme_and_floor_plan
--
-- รองรับขอบเขตโครงงานข้อ 1.2 / 2.1 (ธีมห้อง) และ 1.2 (แผนผังห้องของร้าน)
-- ซึ่งก่อนหน้านี้ไม่มีคอลัมน์รองรับใน DB
--   room.theme          -- ธีมของห้อง เช่น "One Piece", "สงกรานต์" (ไม่บังคับกรอก)
--   shop.floor_plan_url -- ลิงก์รูปแผนผังห้องของร้าน อัปโหลดจากหน้าตั้งค่าร้าน (แบบเดียวกับ qr_code_url)
--
-- วิธี apply:
--   psql "$DATABASE_URL" -f db/migrations/0002_add_room_theme_and_floor_plan.sql
--   (หรือเปิดไฟล์นี้ใน Query Tool ของ pgAdmin แล้วกด Execute)

ALTER TABLE room ADD COLUMN IF NOT EXISTS theme VARCHAR(100);

ALTER TABLE shop ADD COLUMN IF NOT EXISTS floor_plan_url TEXT;
