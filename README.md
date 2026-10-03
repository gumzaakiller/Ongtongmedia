# Ongtongmedia — Cloudflare

เว็บแจ้งชำระเงินภาษาไทย ใช้ Cloudflare Worker + D1 + R2 ไม่มี Google Apps Script หรือ Google Sheets/Drive

## โครงสร้าง
- [public/index.html](public/index.html): หน้าแจ้งชำระเงินและผู้ดูแล
- [public/styles.css](public/styles.css): รูปแบบ desktop/mobile
- [src/client.js](src/client.js): ฟอร์ม, QR, อัปโหลดสลิป, เข้าสู่ระบบและสถานะ
- [src/shared.js](src/shared.js): validation, จำนวนเงินหน่วยสตางค์ และ PromptPay payload
- [src/index.js](src/index.js): Worker API, D1, R2, session และ rate limit
- [migrations/0001_initial.sql](migrations/0001_initial.sql): ตารางคำสั่งซื้อ/session/rate limit
- [scripts/build.mjs](scripts/build.mjs): bundle หน้าเว็บและไลบรารี QR มาเสิร์ฟเอง
- [wrangler.jsonc](wrangler.jsonc): bindings สำหรับ D1 และ R2 ที่สร้างไว้
- [test/](test/): unit tests และ integration tests บน D1/R2 จำลอง

## เริ่มต้นในเครื่อง
```sh
npm ci
# คัดลอก .dev.vars.example เป็น .dev.vars แล้วตั้งค่าข้อมูลทดสอบและรหัสผ่าน
npm run db:local
npm run dev
```
Windows PowerShell ที่ไม่อนุญาตสคริปต์ให้ใช้ `npm.cmd` และ `npx.cmd`

```sh
npm test
npm run build
```
ดู [SETUP.md](SETUP.md) สำหรับขั้นตอนเปิดใช้งานจริง

## ขอบเขตระบบ
- ลูกค้ากรอกรายการและราคาตามที่ตกลงกับร้าน ระบบคำนวณยอดใหม่บนเซิร์ฟเวอร์ แต่ยังไม่มีแค็ตตาล็อกราคาหรือใบเสนอราคาจากร้านให้เทียบราคา
- สลิปเป็นหลักฐานประกอบ ร้านต้องตรวจยอดเงินจริงก่อนเลือก “ชำระแล้ว” ไม่มีการยืนยันเงินเข้าจากธนาคารอัตโนมัติ
- ไม่แนบสลิปได้ สถานะจะเป็น “รอชำระเงิน”; ยังไม่มีหน้าลูกค้าอัปโหลดสลิปเพิ่มให้คำสั่งซื้อเดิมภายหลัง ให้ติดต่อร้านพร้อมเลขคำสั่งซื้อ
- มีบัญชีผู้ดูแลร่วมหนึ่งบัญชี รหัสผ่านเก็บเป็น Cloudflare secret และ session อายุ 8 ชั่วโมง เก็บเฉพาะ hash ของ session ใน D1
- จำกัดการเข้าสู่ระบบ 5 ครั้ง/15 นาที/IP และส่งคำสั่งซื้อ 20 ครั้ง/10 นาที/IP (เครือข่ายร่วมใช้โควตาเดียวกัน)
- ป้องกันส่งซ้ำด้วย idempotency key และ hash ของข้อมูล/สลิป เมื่อเครือข่ายผิดพลาดให้กดส่งซ้ำในหน้าเดิม อย่ารีเฟรชหรือเริ่มหน้าใหม่จนกว่าจะตรวจสอบผล เพราะยังไม่ได้เก็บคำขอข้ามการโหลดหน้า
- จำกัด 50 รายการ/คำสั่งซื้อ ยอดรวมไม่เกิน 1,000,000 บาท สลิปไม่เกิน 8 MB
- การเขียน D1 กับ R2 ไม่ใช่ transaction เดียวกัน หากบริการหยุดระหว่างขั้นตอนอาจมีไฟล์ R2 ที่ไม่มีคำสั่งซื้ออ้างถึง ควรตรวจไฟล์ตกค้างเป็นระยะ
- local tests ไม่เขียนข้อมูลบน Cloudflare จริง

## บัญชีและการยืนยันชำระ
- `POST /api/admin/payments` รับ `{ "orderId": "OTM-..." }` สร้างหรือคืน payment เดิม ยอดและสลิปอ่านจาก order เท่านั้น คำสั่งซื้อใหม่สร้าง payment ให้อัตโนมัติ
- `POST /api/admin/payments/:id/confirm` ยืนยันเต็มยอด บันทึก paid_at, สถานะ order และ income ใน D1 batch transaction เดียว การกดซ้ำหรือพร้อมกันไม่เพิ่มรายรับซ้ำ (`income.order_id UNIQUE`) และไม่เปลี่ยนเวลารับเงินเดิม
- `GET /api/admin/payments/:id/slip` อ่านสลิปจาก R2 binding SLIPS ผ่าน session ผู้ดูแลเท่านั้น
- `GET /api/admin/dashboard`, `/api/admin/income`, `/api/admin/expenses`, `/api/admin/payments/pending` อ่านข้อมูลจริง รายการแบ่งหน้าด้วย `offset` และ `nextOffset`
- `POST /api/admin/expenses` รับ `requestId` (UUID เดิมเมื่อ retry), `amount` (บาท), `category`, `description`, `expenseDate` (YYYY-MM-DD)
- ทุก endpoint ใช้ session เดิม และคำขอเขียนต้องมี Origin ตรงกับเว็บ รายรับสร้างจากการยืนยันชำระเท่านั้น ไม่เปิดให้เพิ่มรายรับจากลูกค้า
- Dashboard: ยอดขายวันนี้ไม่รวม order ยกเลิก; รับเงินแล้วเป็นยอดสะสม; รอตรวจสอบนับ payment pending ที่ order ไม่ยกเลิก; รายรับ/รายจ่าย/กำไรเป็นเดือนปัจจุบันตามเวลาไทย
- ไม่รองรับจ่ายบางส่วนหรือคืนเงิน จึงไม่อนุญาตเปลี่ยน order ที่รับเงินแล้วกลับเป็นรอชำระ/ยกเลิก และไม่ให้เริ่มงานก่อนยืนยันรับเงิน
- [migration 0002](migrations/0002_accounting.sql) เพิ่มตารางสำหรับฐานข้อมูลใหม่ด้วย IF NOT EXISTS และตรงกับ schema production ที่ตรวจแล้ว ไม่มี DROP หรือแก้ข้อมูลเดิม ห้ามรัน migration บน production โดยอัตโนมัติจาก PR นี้

## Preview ก่อน merge
รัน `npm run preview` แล้วเปิด http://127.0.0.1:8788/ เลือกผู้ดูแล รหัส `local-preview-admin-only` ใช้เฉพาะ preview ในเครื่อง ฐานข้อมูลและ R2 จำลองจะหายเมื่อปิด process ไม่ใช้ secret หรือข้อมูล production และปิดการรับชำระจริงไว้

Preview มีคำสั่งซื้อจำลอง 250 บาทให้ทดลองยืนยันชำระ เพิ่มรายจ่าย และดู dashboard ได้ รัน `npm test`, `npm run build`, `npx wrangler deploy --dry-run` ก่อนส่ง PR; GitHub workflow Checks รันรายการเดียวกัน ห้าม merge จนตรวจ preview และ checks ผ่าน การ deploy production เป็นขั้นตอนแยกหลัง review

## เอกสารอ้างอิง
- [Workers Static Assets](https://developers.cloudflare.com/workers/static-assets/)
- [D1 bindings และ transactions](https://developers.cloudflare.com/d1/worker-api/d1-database/)
- [R2 Workers API](https://developers.cloudflare.com/r2/api/workers/workers-api-reference/)
