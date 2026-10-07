/**
 * HttpError — error ที่มี HTTP status ติดมาด้วย โยนจากที่ไหนก็ได้ใน route/helper
 * แล้ว error handler กลางใน app.js จะตอบ { error: message } ด้วย status นั้นให้เอง
 */
class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

/**
 * ห่อ async route handler — Express 4 ไม่จับ promise ที่ reject ให้เอง (ถ้าไม่ห่อ error จะหลุดเป็น
 * unhandled rejection แล้ว process ล่ม) จึงส่งทุก error ต่อไปที่ error handler กลาง
 *
 * dbErrors: แปลง error code ของ PostgreSQL ที่คาดไว้เป็นข้อความเฉพาะ route เช่น
 *   { '23P01': [409, 'ช่วงเวลานี้ถูกจองไปแล้ว'] }  (23P01 = exclusion constraint ช่วงเวลาซ้อน,
 *   23503 = foreign key ไม่พบแถวที่อ้างถึง, 23505 = ค่าซ้ำกับ unique constraint)
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
