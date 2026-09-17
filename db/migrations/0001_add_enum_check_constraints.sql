-- Migration: 0001_add_enum_check_constraints
--
-- เพิ่ม CHECK constraint ให้คอลัมน์ varchar ที่ใช้เป็น enum ในทางปฏิบัติ (booking_status,
-- deposit_status, booking_source, payment_status, payment_type, method, role) แต่ก่อนหน้านี้
-- ไม่มี constraint ใดๆ กัน ทำให้ค่าที่พิมพ์ผิด/ไม่ตรงกับที่โค้ดรองรับหลุดเข้า DB ได้แบบเงียบๆ
-- (room.size มี CHECK อยู่แล้วชื่อ room_size_check จึงไม่รวมในไฟล์นี้)
--
-- ค่าที่อนุญาตอ้างอิงจากค่าที่โค้ด backend/frontend ใช้จริงตอนเขียน migration นี้ (2026-09-17)
-- ตรวจแล้วว่าข้อมูลปัจจุบันในทุกตารางอยู่ในชุดค่านี้ครบ 100% (ดูรายงานตรวจสอบก่อนรัน migration)
--
-- วิธี apply:
--   psql "$DATABASE_URL" -f db/migrations/0001_add_enum_check_constraints.sql

ALTER TABLE booking ADD CONSTRAINT booking_status_check
  CHECK (booking_status IN ('pending', 'confirmed', 'cancelled', 'completed'));

ALTER TABLE booking ADD CONSTRAINT booking_deposit_status_check
  CHECK (deposit_status IN ('unpaid', 'pending_verify', 'paid'));

ALTER TABLE booking ADD CONSTRAINT booking_source_check
  CHECK (booking_source IN ('customer_online', 'admin_walkin'));

ALTER TABLE payment ADD CONSTRAINT payment_status_check
  CHECK (payment_status IN ('pending', 'paid', 'rejected'));

ALTER TABLE payment ADD CONSTRAINT payment_type_check
  CHECK (payment_type IN ('deposit'));

ALTER TABLE payment ADD CONSTRAINT payment_method_check
  CHECK (method IN ('qrcode'));

ALTER TABLE users ADD CONSTRAINT users_role_check
  CHECK (role IN ('customer', 'admin'));

-- users.status และ room.room_status ไม่ถูกอ่าน/เขียนโดยโค้ดจุดใดเลย (dead column) แต่ใส่ CHECK ไว้
-- ด้วยเพื่อกันข้อมูลเพี้ยนถ้ามีคนแก้ผ่าน SQL ตรงๆ ในอนาคต
ALTER TABLE users ADD CONSTRAINT users_status_check
  CHECK (status IN ('active'));

ALTER TABLE room ADD CONSTRAINT room_status_check
  CHECK (room_status IN ('available'));
