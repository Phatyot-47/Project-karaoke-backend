-- Migration: 0003_add_service_session_and_extension
--
-- รองรับขอบเขตโครงงานข้อ 2.6 — บันทึกการเข้าใช้บริการจริง (Check-in/Check-out) และการต่อเวลา
-- พร้อมคำนวณค่าบริการเพิ่ม โครงสร้างตามตาราง SERVICE_SESSION และ EXTENSION ใน ER Diagram ของเอกสารโครงงาน
--   service_session -- 1 รอบการใช้บริการต่อ 1 booking (สร้างตอน Check-in, ปิดตอน Check-out)
--   extension       -- ประวัติการต่อเวลาแต่ละครั้งของรอบการใช้บริการ
--
-- วิธี apply:
--   psql "$DATABASE_URL" -f db/migrations/0003_add_service_session_and_extension.sql
--   (หรือเปิดไฟล์นี้ใน Query Tool ของ pgAdmin แล้วกด Execute)

CREATE TABLE IF NOT EXISTS service_session (
  session_id      SERIAL PRIMARY KEY,
  booking_id      INTEGER NOT NULL UNIQUE REFERENCES booking(booking_id) ON DELETE CASCADE,
  checkin_time    TIMESTAMP NOT NULL DEFAULT now(),
  checkout_time   TIMESTAMP,
  checked_in_by   INTEGER REFERENCES users(user_id),
  checked_out_by  INTEGER REFERENCES users(user_id),
  session_status  VARCHAR(20) NOT NULL DEFAULT 'in_progress'
                  CONSTRAINT service_session_status_check CHECK (session_status IN ('waiting', 'in_progress', 'finished')),
  overtime_amount NUMERIC(10,2) NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS extension (
  extension_id     SERIAL PRIMARY KEY,
  session_id       INTEGER NOT NULL REFERENCES service_session(session_id) ON DELETE CASCADE,
  extend_minutes   INTEGER NOT NULL
                   CONSTRAINT extension_minutes_check CHECK (extend_minutes > 0 AND extend_minutes % 30 = 0),
  new_end_datetime TIMESTAMP NOT NULL,
  extra_amount     NUMERIC(10,2) NOT NULL DEFAULT 0,
  approved_by      INTEGER REFERENCES users(user_id),
  created_at       TIMESTAMP NOT NULL DEFAULT now()
);
