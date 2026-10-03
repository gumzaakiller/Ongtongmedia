# API — ระบบเรียกเก็บเงินอองตองมีเดีย

เงินทุกช่องเป็น **สตางค์ (integer)** ชื่อฟิลด์ลงท้าย `Satang` · เวลาเป็น ISO UTC · error ตอบ `{ "error": "ข้อความภาษาไทย" }`
คำขอที่ไม่ใช่ GET ต้องมี header `Origin` ตรงกับเว็บไซต์ (กัน CSRF)

## Public
| Method | Path | หมายเหตุ |
|---|---|---|
| GET | `/api/health` | `{ ok, paymentsConfigured, env }` |
| GET | `/api/config` | `{ shopName, lineOaId, env }` |
| GET | `/api/pay/:token` | ข้อมูลออเดอร์สำหรับลูกค้า + `promptPayPayload` (สร้างจากยอดใน D1) · rate limit 120 ครั้ง/10 นาที/IP · token ผิดได้ 404 เหมือนกันทุกกรณี |
| GET | `/api/pay/:token/qr.png` | รูป QR พร้อมเพย์ (PNG) ตามยอดใน D1 · เฉพาะสถานะ `pending` |
| POST | `/api/pay/:token/slip` | ลูกค้าส่งสลิป: multipart `slip` (PNG/JPG/WEBP ≤ 8 MB ตรวจจากเนื้อไฟล์) + `note` · header `Idempotency-Key` · 10 ครั้ง/10 นาที/IP |
| POST | `/api/pay/:token/notify` | ลูกค้าแจ้งโอนแล้วโดยไม่มีสลิป: JSON `{ note }` · header `Idempotency-Key` · ร้านต้องเช็คเงินเข้าแล้วยืนยันเอง |
| GET | `/pay/:token` | หน้าเว็บลูกค้า (`public/pay.html`) |
| GET | `/api/catalog` | ประเภทงานในเมนูสั่งงาน (แก้ที่ `src/catalog.js`) |
| POST | `/api/requests` | ลูกค้าส่งคำขอสั่งงาน: multipart `category, qty, width, height, unit, options[], artwork, deadline, details, name, phone, lineId, files[]` · ไฟล์ JPG/PNG/WEBP/PDF ≤ 5 ไฟล์ ไฟล์ละ ≤ 20 MB รวม ≤ 25 MB · `Idempotency-Key` · 5 ครั้ง/10 นาที/IP → `{ requestNo, trackUrl }` |
| GET | `/api/requests/:token` | หน้าติดตามคำขอของลูกค้า + ลิงก์ชำระเงินเมื่อร้านแจ้งราคาแล้ว |
| GET | `/order` · `/request/:token` | หน้าสั่งงาน · หน้าติดตามคำขอ |
| POST | `/api/line/webhook` | LINE Messaging API webhook · ตรวจ `x-line-signature` (HMAC-SHA256) · ปิด (404) จนกว่าจะตั้ง `LINE_CHANNEL_SECRET` + `LINE_CHANNEL_ACCESS_TOKEN` |

ข้อมูลที่ลูกค้าเห็น **ไม่มี** หมายเหตุภายใน ข้อมูลติดต่อลูกค้า หรือ id ภายใน

## Admin (ต้องมี session cookie)
| Method | Path | Body / Query |
|---|---|---|
| POST | `/api/admin/login` | `{ password }` · 5 ครั้ง/15 นาที/IP |
| POST | `/api/admin/logout` | |
| GET | `/api/admin/session` | |
| GET | `/api/admin/customers?q=` | ค้นจากชื่อ/เบอร์/LINE สูงสุด 10 รายการ |
| GET | `/api/admin/orders?status=&q=&cursor=` | หน้าละ 30 · `q` ค้นเลขออเดอร์/ชื่อ/เบอร์ |
| POST | `/api/admin/orders` | header `Idempotency-Key` (16–64 ตัว) · body ด้านล่าง · 201 สร้างใหม่ / 200 ส่งซ้ำ |
| GET | `/api/admin/orders/:orderNo` | รายละเอียด + `payUrl` + payments + events |
| PATCH | `/api/admin/orders/:orderNo` | `{ version, title?, note?, internalNote?, items?, discount? }` เฉพาะสถานะ `pending` |
| POST | `/api/admin/orders/:orderNo/status` | `{ to, version, note? }` |
| POST | `/api/admin/orders/:orderNo/payments` | บันทึกรับเงินเอง (สลิปทาง LINE/เงินสด): `{ version, method, receivedDate, note? }` → ชำระแล้ว + ลงรายรับ |
| POST | `/api/admin/payments/:id/verify` | `{ version }` ยืนยันสลิป → ชำระแล้ว + ลงรายรับ (วันที่รับเงิน = วันที่ลูกค้าส่งสลิป) |
| POST | `/api/admin/payments/:id/reject` | `{ version, reason }` สลิปไม่ผ่าน → กลับเป็นรอชำระ ลูกค้าเห็นเหตุผล |
| GET | `/api/admin/payments/:id/slip` | เปิดรูปสลิป (R2 private) |
| GET | `/api/admin/requests?status=new\|quoted\|cancelled&cursor=` | รายการคำขอสั่งงาน |
| GET | `/api/admin/requests/:requestNo` | รายละเอียด + ไฟล์ + ข้อมูลติดต่อ |
| GET | `/api/admin/request-files/:id` | เปิดไฟล์แนบ (R2 private) |
| POST | `/api/admin/requests/:requestNo/quote` | แจ้งราคา = สร้างบิล (body เหมือนสร้างออเดอร์ + `requestVersion`) และผูกกับคำขอใน transaction เดียว · `Idempotency-Key` |
| POST | `/api/admin/requests/:requestNo/cancel` | `{ version, reason }` เฉพาะคำขอใหม่ |
| GET | `/api/admin/dashboard` | ยอดวันนี้/เดือนนี้, ออกบิลวันนี้, รอตรวจ, ยังไม่ชำระ, รายรับ 7 วัน (ตามเวลาไทย) |
| GET | `/api/admin/income?month=YYYY-MM` หรือ `from=&to=`, `q=`, `cursor=` | รายการรายรับ + ยอดรวมตามตัวกรอง หน้าละ 50 |
| GET | `/api/admin/income.csv` | ตัวกรองเดียวกัน ไฟล์ CSV เปิดใน Excel ภาษาไทยได้ (มี BOM, กันสูตรอันตราย) |

### สร้างออเดอร์
```json
{
  "customer": { "name": "คุณสมชาย", "phone": "0898765432", "lineId": "somchai" },
  "title": "งานพิมพ์ป้าย",
  "note": "แสดงให้ลูกค้าเห็น",
  "internalNote": "เห็นเฉพาะร้าน",
  "items": [{ "description": "ไวนิล 2x1 ม.", "qty": 2, "unitPrice": "350" }],
  "discount": "50"
}
```
ใช้ลูกค้าเดิม: `"customer": { "id": 12 }` · ยอดรวมคำนวณที่ server เสมอ ค่ายอดที่ส่งมาจะถูกละเลย

### สถานะ
`pending → awaiting_verification → paid → processing → completed` และ `cancelled`

| เปลี่ยนผ่าน | ทำโดย |
|---|---|
| pending → cancelled | admin (`/status`) |
| paid → processing / completed, processing → completed | admin (`/status`) |
| pending → awaiting_verification | ลูกค้าส่งสลิป |
| awaiting_verification → paid (+ ลงรายรับ) | admin ยืนยันการชำระ |
| pending → paid (+ ลงรายรับ) | admin บันทึกรับเงินเอง |
| awaiting_verification → pending | admin ปฏิเสธสลิป |

### การแก้ไขพร้อมกัน
ทุกการแก้ต้องส่ง `version` ล่าสุด ถ้าไม่ตรงได้ 409 · ทุก batch เริ่มด้วย guard ที่ทำให้ทั้ง batch ย้อนกลับเมื่อเงื่อนไขไม่ผ่าน
ยอดเงินถูกล็อกด้วย trigger ใน D1 เมื่อมีการส่งหลักฐานการชำระแล้ว

### รายรับ
ลงอัตโนมัติเมื่อยืนยันการชำระเท่านั้น (ไม่มีปุ่มเพิ่มรายรับด้วยมือ) · `income.order_id` และ `income.payment_id` เป็น UNIQUE และ trigger ใน D1 ตรวจว่ามาจากการชำระที่ยืนยันแล้ว ยอดตรงกับออเดอร์ → ลงซ้ำไม่ได้แม้กดพร้อมกัน

### สลิปใน R2
key: `slips/YYYY/MM/<เลขออเดอร์>/<สุ่ม>.<png|jpg|webp>` · bucket เป็น private เปิดได้ผ่าน admin เท่านั้น · ถ้าบันทึก D1 ไม่สำเร็จ ไฟล์ที่เพิ่งอัปโหลดจะถูกลบทันที
