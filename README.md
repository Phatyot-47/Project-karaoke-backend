# Gens Karaoke Backend API

Backend สำหรับระบบจองห้องคาราโอเกะ Gens Karaoke & Board Game (Node.js + Express + PostgreSQL)
ฐานข้อมูลมี 9 ตาราง: users, shop, shop_hours, shop_policy, room, booking, payment, service_session, extension

## ติดตั้ง

```bash
cd Project-karaoke-backend
npm install
cp .env.example .env
```

แก้ `.env` ให้ตรงกับเครื่องตัวเอง

```
DATABASE_URL=postgresql://postgres:รหัสผ่านของคุณ@localhost:5432/gens_karaoke
JWT_SECRET=สุ่มค่ายาวๆ เอง (ดูคำสั่งใน .env.example)
```

### สร้างฐานข้อมูล (ครั้งแรก)

1. สร้าง database เปล่าชื่อ `gens_karaoke` ใน pgAdmin
2. รัน `db/schema.sql` (เปิดใน Query Tool ของ pgAdmin แล้วกด Execute หรือ `psql "$DATABASE_URL" -f db/schema.sql`)
   ไฟล์นี้รวมทุก migration แล้ว และตั้ง timezone ของ database เป็น Asia/Bangkok ให้อัตโนมัติ
3. เพิ่มข้อมูลร้าน เวลาเปิด-ปิด นโยบายมัดจำ ห้อง และบัญชีแอดมิน
   (รหัสผ่านแอดมินเก็บแบบ hash: `crypt('รหัสผ่าน', gen_salt('bf'))`)

ส่วน `db/migrations/` เก็บไว้ดูประวัติการแก้โครงสร้าง ใช้กับ DB เก่าที่สร้างก่อนมี schema.sql เท่านั้น

## รัน

```bash
npm run dev     # ใช้ nodemon รีสตาร์ทอัตโนมัติเวลาแก้โค้ด
npm start       # รันปกติ
npm run format  # จัดรูปแบบโค้ดด้วย Prettier
```

เปิด `http://localhost:4000/api/health` ควรเห็น `{"ok":true}`

## Endpoint ทั้งหมด

🔓 = ไม่ต้องล็อกอิน · 👤 = token ลูกค้า · 🛠 = token แอดมิน (ส่ง header `Authorization: Bearer <token>`)

### เข้าสู่ระบบ (จำกัด 10 ครั้ง / 15 นาที / IP)

- 🔓 `POST /api/auth/register` `{ name, phone, password }`
- 🔓 `POST /api/auth/login` `{ phone, password }`
- 🔓 `POST /api/auth/set-password` `{ phone, name, password }` (บัญชีเก่าที่ยังไม่มีรหัสผ่าน)
- 🔓 `POST /api/auth/admin-login` `{ username, password }`

### ห้อง / ร้าน

- 🔓 `GET /api/rooms?size=S|M|L|XL|all&start=&end=` (ส่ง start/end จะได้ `is_available`)
- 🔓 `GET /api/rooms/:id`
- 🔓 `GET /api/rooms/:id/availability?date=YYYY-MM-DD`
- 🔓 `GET /api/shop`

### ลูกค้า

- 👤 `POST /api/bookings` `{ roomId, startDatetime, endDatetime, guestCount, note }`
- 👤 `GET /api/bookings/customer/:customerId`
- 👤🛠 `GET /api/bookings/:id`
- 👤 `PATCH /api/bookings/:id/edit` `{ roomId, startDatetime, endDatetime }`
- 👤 `PATCH /api/bookings/:id/cancel` `{ reason }`
- 👤 `POST /api/payments` `{ bookingId, method, evidenceUrl }`
- 👤🛠 `POST /api/uploads` (multipart field `file` รูป JPG/PNG/GIF/WEBP ไม่เกิน 5MB)
- 👤 `PATCH /api/users/:id` `{ name, phone, avatarUrl }`
- 👤 `PATCH /api/users/:id/password` `{ currentPassword, newPassword }`

### แอดมิน

- 🛠 `GET /api/admin/bookings/today`
- 🛠 `GET /api/admin/bookings/history`
- 🛠 `PATCH /api/admin/bookings/:id/confirm`
- 🛠 `PATCH /api/admin/bookings/:id/reject` `{ reason }`
- 🛠 `PATCH /api/admin/bookings/:id/no-show` `{ reason }`
- 🛠 `PATCH /api/admin/bookings/:id/change-room` `{ roomId }`
- 🛠 `POST /api/admin/bookings/walkin` `{ roomId, startDatetime, endDatetime, customerName, customerPhone }`
- 🛠 `PATCH /api/admin/bookings/:id/check-in`
- 🛠 `PATCH /api/admin/bookings/:id/extend` `{ minutes }` (ทีละ 30 นาที)
- 🛠 `PATCH /api/admin/bookings/:id/check-out`
- 🛠 `PATCH /api/admin/payments/:id/verify` `{ approve, reason }`
- 🛠 `PATCH /api/admin/shop` `{ name, taxId, phone, address, bankName, bankAccountNo, bankAccountName, qrCodeUrl, peakStartTime, peakSurcharge, floorPlanUrl }`
- 🛠 `PATCH /api/admin/shop/hours` `{ hours: [{ dayOfWeek, openHour, closeHour }] }`
- 🛠 `PATCH /api/admin/policy` `{ depositPercent, cancelHoursBefore, allowEditBeforeHours, refundPolicyDesc, noShowPolicyDesc }`
- 🛠 `GET /api/admin/rooms` · `POST /api/admin/rooms` · `PATCH /api/admin/rooms/:id` · `DELETE /api/admin/rooms/:id`
- 🛠 `GET /api/admin/reports?period=day|week|month`

## หมายเหตุ

- ราคาการจอง (base_price / peak_surcharge_total / price_total) และยอดมัดจำคำนวณที่ backend เสมอ (`src/utils/pricing.js`) ไม่รับราคาจาก frontend กันลูกค้าแก้ราคาเอง
- จองเวลาชนกับรายการ pending/confirmed ในห้องเดียวกัน DB จะปฏิเสธเอง (exclusion constraint) backend ตอบ 409
- การจองออนไลน์ที่ไม่แนบสลิปภายใน 5 นาทีจะถูกยกเลิกอัตโนมัติ (`src/utils/expireBookings.js`)
- รหัสผ่านทั้งลูกค้าและแอดมินเก็บเป็น hash ด้วย pgcrypto `crypt()`
- ข้อมูลที่ส่งมาผิดรูปแบบ (เช่น id ไม่ใช่ตัวเลข วันที่ผิด) ตอบ 400 ไม่ใช่ 500
