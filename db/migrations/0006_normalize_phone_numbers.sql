-- Migration: 0006_normalize_phone_numbers
--
-- เก็บเบอร์โทรเป็นตัวเลขล้วน — หน้าเว็บตัดอักขระที่ไม่ใช่ตัวเลขออกก่อนส่งเสมอ แต่ข้อมูลเดิมบางแถว
-- มีขีด (เช่น 081-234-5678) ทำให้ลูกค้าเหล่านั้นล็อกอินไม่ได้ (หาเบอร์ไม่เจอ)
-- backend ใหม่ตรวจรูปแบบเบอร์ (ตัวเลข 9-10 หลัก) ทุกครั้งที่สมัคร/ล็อกอิน/แก้ไขโปรไฟล์อยู่แล้ว
--
-- วิธี apply:
--   psql "$DATABASE_URL" -f db/migrations/0006_normalize_phone_numbers.sql
--   (หรือเปิดไฟล์นี้ใน Query Tool ของ pgAdmin แล้วกด Execute — รันซ้ำได้)

UPDATE users SET phone = regexp_replace(phone, '[^0-9]', '', 'g') WHERE phone ~ '[^0-9]';
UPDATE booking SET walkin_phone = regexp_replace(walkin_phone, '[^0-9]', '', 'g') WHERE walkin_phone ~ '[^0-9]';
