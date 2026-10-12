// ส่วน SQL ของ "ประเภทห้อง" (room_type) ที่ใช้ร่วมกันหลาย route
// ห้องเก็บแค่ type_id → ต้อง JOIN room_type เพื่อได้รหัสประเภท (size เช่น S/M/L/XL), ชื่อประเภท และช่วงความจุ
// ส่ง code ออกไปในชื่อ size เหมือนเดิม หน้าเว็บส่วนที่ใช้ size อยู่แล้วจะได้ไม่ต้องแก้

/** คอลัมน์ของประเภทห้องสำหรับต่อท้าย SELECT (alias ตาราง room_type = t) */
const ROOM_TYPE_COLUMNS = 't.code AS size, t.name AS type_name, t.capacity_min, t.capacity_max';

/** JOIN ตาราง room_type ให้ห้อง (roomAlias = alias ของตาราง room ใน query นั้น) */
const joinRoomType = (roomAlias) => `JOIN room_type t ON t.type_id = ${roomAlias}.type_id`;

module.exports = { ROOM_TYPE_COLUMNS, joinRoomType };
