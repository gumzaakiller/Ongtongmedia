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

## เอกสารอ้างอิง
- [Workers Static Assets](https://developers.cloudflare.com/workers/static-assets/)
- [D1 bindings และ transactions](https://developers.cloudflare.com/d1/worker-api/d1-database/)
- [R2 Workers API](https://developers.cloudflare.com/r2/api/workers/workers-api-reference/)
