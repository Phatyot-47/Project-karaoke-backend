-- Migration: 0007_add_room_type
--
-- เพิ่ม "ประเภทห้อง" (ROOM_TYPE) ตามที่อาจารย์เสนอ — แต่ละประเภท (S/M/L/XL หรือที่แอดมินเพิ่มเอง)
-- มีชื่อ ช่วงความจุ และราคาห้องธรรมดาต่อชั่วโมง ในแต่ละประเภทมีได้ทั้งห้องธรรมดาและห้องธีม
--   room_type.base_price_per_hour -- ราคาห้องธรรมดาของประเภทนั้น (ห้องใหม่ใช้ราคานี้ / เปลี่ยนแล้วเลือกได้ว่าห้องไหนเปลี่ยนตาม)
--   room.price_per_hour           -- ราคาจริงของแต่ละห้อง (ห้องธีมแอดมินกรอกเอง)
--   room.theme                    -- ว่าง = ห้องธรรมดา / มีชื่อธีม = ห้องธีม
--
-- แทนคอลัมน์ room.size เดิม (S/M/L/XL ตายตัว) ด้วย room.type_id — API ยังส่ง size (= room_type.code) ให้เหมือนเดิม
--
-- วิธี apply:
--   psql "$DATABASE_URL" -f db/migrations/0007_add_room_type.sql
--   (หรือเปิดไฟล์นี้ใน Query Tool ของ pgAdmin แล้วกด Execute — รันซ้ำได้)

BEGIN;

CREATE TABLE IF NOT EXISTS room_type (
  type_id             SERIAL PRIMARY KEY,
  code                VARCHAR(10)  NOT NULL UNIQUE,
  name                VARCHAR(100) NOT NULL,
  capacity_min        INTEGER NOT NULL CONSTRAINT room_type_capacity_min_check CHECK (capacity_min >= 1),
  capacity_max        INTEGER NOT NULL,
  base_price_per_hour NUMERIC(10,2) NOT NULL DEFAULT 0 CONSTRAINT room_type_price_check CHECK (base_price_per_hour >= 0),
  description         TEXT,
  CONSTRAINT room_type_capacity_range_check CHECK (capacity_max >= capacity_min)
);

-- ประเภทเริ่มต้น: ความจุตามป้ายที่หน้าเว็บใช้อยู่เดิม / ราคาธรรมดาตามห้องธรรมดาที่มีอยู่ตอนนี้
INSERT INTO room_type (code, name, capacity_min, capacity_max, base_price_per_hour, description) VALUES
  ('S',  'ห้องเล็ก',      1, 3,  120, 'เหมาะกับร้องคนเดียวหรือมากับเพื่อน 1-3 คน'),
  ('M',  'ห้องกลาง',      3, 5,  180, 'เหมาะกับกลุ่มเพื่อน 3-5 คน'),
  ('L',  'ห้องใหญ่',      5, 8,  250, 'เหมาะกับกลุ่ม 5-8 คน'),
  ('XL', 'ห้องใหญ่พิเศษ', 8, 12, 350, 'เหมาะกับปาร์ตี้ 8-12 คน')
ON CONFLICT (code) DO NOTHING;

ALTER TABLE room ADD COLUMN IF NOT EXISTS type_id INTEGER REFERENCES room_type(type_id);

-- ย้ายข้อมูลจาก size เดิม (ถ้ายังมีคอลัมน์ size อยู่) แล้วลบคอลัมน์ size ทิ้ง
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'room' AND column_name = 'size') THEN
    UPDATE room SET type_id = t.type_id FROM room_type t WHERE t.code = room.size AND room.type_id IS NULL;
    ALTER TABLE room DROP COLUMN size;
  END IF;
END $$;

ALTER TABLE room ALTER COLUMN type_id SET NOT NULL;

-- ธีมว่าง ('') ให้เป็น NULL ทั้งหมด จะได้เช็ค "ห้องธรรมดา" ด้วย theme IS NULL อย่างเดียว
UPDATE room SET theme = NULL WHERE theme IS NOT NULL AND btrim(theme) = '';

COMMIT;
