// ชิ้นส่วน SQL ของ "ประเภทห้อง" (S/M/L/XL ...) ที่หลาย route ใช้ร่วมกัน
// ตาราง room เก็บแค่รหัสประเภท (type_id) จึงต้องดึงรายละเอียดจากตาราง room_type มาต่อ (JOIN)
// ส่งรหัสประเภทออกไปในชื่อ size (เช่น size: 'M') เหมือนเดิม หน้าเว็บจะได้ไม่ต้องแก้

/** คอลัมน์ของประเภทห้องที่ใส่ต่อท้าย SELECT (t = ตัวย่อของตาราง room_type) */
const ROOM_TYPE_COLUMNS = 't.code AS size, t.name AS type_name, t.capacity_min, t.capacity_max';

/** คำสั่งต่อตาราง room_type เข้ากับห้อง (roomAlias = ตัวย่อของตาราง room ในคำสั่งนั้น เช่น 'r') */
const joinRoomType = (roomAlias) => `JOIN room_type t ON t.type_id = ${roomAlias}.type_id`;

module.exports = { ROOM_TYPE_COLUMNS, joinRoomType };
