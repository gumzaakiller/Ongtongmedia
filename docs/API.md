# API — ระบบเรียกเก็บเงินอองตองมีเดีย

เงินทุกช่องเป็น **สตางค์ (integer)** ชื่อฟิลด์ลงท้าย `Satang` · เวลาเป็น ISO UTC · error ตอบ `{ "error": "ข้อความภาษาไทย" }`
คำขอที่ไม่ใช่ GET ต้องมี header `Origin` ตรงกับเว็บไซต์ (กัน CSRF)

## Public
| Method | Path | หมายเหตุ |
|---|---|---|
| GET | `/api/health` | `{ ok, paymentsConfigured, env }` |
| GET | `/api/config` | `{ shopName, lineOaId, env }` |
| GET | `/api/pay/:token` | ข้อมูลออเดอร์สำหรับลูกค้า + `promptPayPayload` (สร้างจากยอดใน D1) · rate limit 120 ครั้ง/10 นาที/IP · token ผิดได้ 404 เหมือนกันทุกกรณี |
| GET | `/pay/:token` | หน้าเว็บลูกค้า (`public/pay.html`, Phase 5) |

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
| pending → awaiting_verification | ลูกค้าส่งสลิป (Phase 6) |
| awaiting_verification → paid (+ ลงรายรับ) | admin ยืนยันการชำระ (Phase 7) |
| awaiting_verification → pending | admin ปฏิเสธสลิป (Phase 7) |

### การแก้ไขพร้อมกัน
ทุกการแก้ต้องส่ง `version` ล่าสุด ถ้าไม่ตรงได้ 409 · ทุก batch เริ่มด้วย guard ที่ทำให้ทั้ง batch ย้อนกลับเมื่อเงื่อนไขไม่ผ่าน
ยอดเงินถูกล็อกด้วย trigger ใน D1 เมื่อมีการส่งหลักฐานการชำระแล้ว
