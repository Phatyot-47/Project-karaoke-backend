-- Migration: 0010_relative_upload_urls
--
-- ลิงก์ไฟล์ที่อัปโหลด (สลิป, QR ร้าน, แผนผังร้าน, รูปห้อง, รูปโปรไฟล์) เดิมเก็บเป็นลิงก์เต็ม เช่น
-- http://localhost:4000/uploads/xxx.jpg — เปิดจากมือถือ/เครื่องอื่น หรือย้าย server แล้วรูปขึ้นไม่ได้
-- ตั้งแต่นี้เก็บเป็น /uploads/xxx.jpg แล้วหน้าเว็บเติมที่อยู่ backend ให้เอง — ไฟล์นี้แปลงลิงก์เดิมให้เป็นแบบใหม่
--
-- วิธี apply:
--   psql "$DATABASE_URL" -f db/migrations/0010_relative_upload_urls.sql
--   (หรือเปิดไฟล์นี้ใน Query Tool ของ pgAdmin แล้วกด Execute — รันซ้ำได้)

BEGIN;

UPDATE shop SET qr_code_url = regexp_replace(qr_code_url, '^https?://[^/]+(/uploads/)', '\1')
WHERE qr_code_url ~ '^https?://[^/]+/uploads/';
UPDATE shop SET floor_plan_url = regexp_replace(floor_plan_url, '^https?://[^/]+(/uploads/)', '\1')
WHERE floor_plan_url ~ '^https?://[^/]+/uploads/';
UPDATE room SET image_url = regexp_replace(image_url, '^https?://[^/]+(/uploads/)', '\1')
WHERE image_url ~ '^https?://[^/]+/uploads/';
UPDATE users SET avatar_url = regexp_replace(avatar_url, '^https?://[^/]+(/uploads/)', '\1')
WHERE avatar_url ~ '^https?://[^/]+/uploads/';
UPDATE payment SET evidence_url = regexp_replace(evidence_url, '^https?://[^/]+(/uploads/)', '\1')
WHERE evidence_url ~ '^https?://[^/]+/uploads/';

COMMIT;
