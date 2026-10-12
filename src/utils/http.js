// เครื่องมือช่วยเรื่อง "ตอบกลับ error" ที่ทุกไฟล์ route ใช้ร่วมกัน

/**
 * HttpError — error ที่บอกได้ว่าจะตอบรหัสอะไร (เช่น 400 ข้อมูลผิด, 404 ไม่พบ, 409 ทำไม่ได้ในสถานะนี้)
 * วิธีใช้: throw new HttpError(404, 'ไม่พบห้อง') แล้ว app.js จะตอบ { error: 'ไม่พบห้อง' } ด้วยรหัส 404 ให้เอง
 */
class HttpError extends Error {
  // code (ไม่บังคับ): รหัสพิเศษให้หน้าเว็บแยกกรณีได้ เช่น 'PASSWORD_NOT_SET' = บัญชียังไม่ตั้งรหัสผ่าน
  constructor(status, message, code) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

/**
 * ห่อฟังก์ชันของแต่ละ route — ถ้าข้างในเกิด error อะไรก็ตาม จะส่งไปตัวจัดการ error กลางใน app.js
 * (ถ้าไม่ห่อ Express 4 จะไม่รู้ว่ามี error ในฟังก์ชัน async แล้วเซิร์ฟเวอร์อาจล่ม)
 *
 * dbErrors: แปลง error จากฐานข้อมูลเป็นข้อความที่ผู้ใช้อ่านเข้าใจ เช่น
 *   { '23P01': [409, 'ช่วงเวลานี้ถูกจองไปแล้ว'] }
 *   23P01 = จองเวลาซ้อนกับคนอื่น, 23503 = อ้างถึงข้อมูลที่ไม่มีอยู่/ยังถูกใช้อยู่, 23505 = ค่าซ้ำกับที่มีแล้ว
 */
function route(handler, dbErrors = {}) {
  return async (req, res, next) => {
    try {
      await handler(req, res, next);
    } catch (err) {
      const mapped = dbErrors[err.code];
      next(mapped ? new HttpError(mapped[0], mapped[1]) : err);
    }
  };
}

module.exports = { HttpError, route };
