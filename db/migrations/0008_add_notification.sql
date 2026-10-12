-- Migration: 0008_add_notification
--
-- แจ้งเตือนลูกค้าในเว็บ (ไอคอนกระดิ่งบนเมนูลูกค้า) เมื่อร้าน/ระบบเปลี่ยนสถานะการจองของลูกค้า
-- เช่น ร้านยืนยันการจอง, ปฏิเสธ/ยกเลิก, สลิปไม่ผ่าน, ย้ายห้อง, ไม่มาใช้บริการ, หมดเวลาชำระมัดจำ
-- (ลูกค้าทำเอง เช่น ยกเลิกการจองของตัวเอง ไม่ต้องแจ้ง / วอล์คอินไม่มีบัญชีลูกค้า จึงไม่มีแจ้งเตือน)
--
-- วิธี apply:
--   psql "$DATABASE_URL" -f db/migrations/0008_add_notification.sql
--   (หรือเปิดไฟล์นี้ใน Query Tool ของ pgAdmin แล้วกด Execute — รันซ้ำได้)

CREATE TABLE IF NOT EXISTS notification (
  notification_id SERIAL PRIMARY KEY,
  user_id         INTEGER NOT NULL REFERENCES users(user_id) ON DELETE CASCADE,
  booking_id      INTEGER REFERENCES booking(booking_id) ON DELETE CASCADE,
  type            VARCHAR(30) NOT NULL
                  CONSTRAINT notification_type_check CHECK (type IN (
                    'booking_confirmed', 'booking_cancelled', 'slip_rejected',
                    'room_changed', 'no_show', 'payment_expired'
                  )),
  title           VARCHAR(200) NOT NULL,
  message         TEXT,
  is_read         BOOLEAN NOT NULL DEFAULT false,
  -- เวลาไทยแบบ naive เหมือน booking.created_at (DB ตั้ง timezone เป็น Asia/Bangkok)
  created_at      TIMESTAMP NOT NULL DEFAULT LOCALTIMESTAMP
);

-- หน้าเว็บดึง "แจ้งเตือนของฉัน ใหม่สุดก่อน" + นับที่ยังไม่อ่าน
CREATE INDEX IF NOT EXISTS notification_user_created_idx ON notification (user_id, created_at DESC);
