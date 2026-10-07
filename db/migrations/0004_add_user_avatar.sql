-- Migration: 0004_add_user_avatar
--
-- ให้ลูกค้าตั้งรูปโปรไฟล์ได้ในหน้า "ข้อมูลส่วนตัว" — เก็บลิงก์รูปที่อัปโหลดผ่าน /api/uploads
-- (แบบเดียวกับ room.image_url / shop.qr_code_url) ไม่บังคับ ถ้าว่างจะแสดงตัวอักษรแรกของชื่อแทน
--
-- วิธี apply:
--   psql "$DATABASE_URL" -f db/migrations/0004_add_user_avatar.sql
--   (หรือเปิดไฟล์นี้ใน Query Tool ของ pgAdmin แล้วกด Execute)

ALTER TABLE users ADD COLUMN IF NOT EXISTS avatar_url TEXT;
