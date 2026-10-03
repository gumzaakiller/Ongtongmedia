# ติดตั้งบน Cloudflare

## ทรัพยากรที่กำหนดไว้
- Worker: `oongtong-media` (คงชื่อจากโปรเจกต์เดิม)
- D1: `ongtongmedia-db`
- Database ID: `cbd0c379-e34c-43eb-abfb-5175fdf1d431`
- R2: `ongtongmedia-slips` — คง Public Access เป็น Disabled
- Binding names: `DB`, `SLIPS`, `ASSETS`

## 1. ติดตั้งและทดสอบในเครื่อง
```sh
npm ci
```
คัดลอก [.dev.vars.example](.dev.vars.example) เป็น `.dev.vars` แล้วกำหนด:
- `ADMIN_PASSWORD`: รหัสผ่านเฉพาะร้านอย่างน้อย 16 ตัวอักษร ไม่ใช้ PIN เดิม
- `PROMPTPAY_ID`: เบอร์ 10 หลักหรือเลขประจำตัว 13 หลักที่ลงทะเบียนพร้อมเพย์ไว้จริง
- `ACCOUNT_NAME`: ชื่อบัญชีจริง
- `BANK_NAME` และ `ACCOUNT_NO`: ข้อมูลบัญชีโอนเงิน ถ้าต้องการแสดง

ไฟล์ `.dev.vars` ถูก ignore จาก Git อย่าส่งรหัสผ่านในแชตหรือใส่ใน frontend

```sh
npm run db:local
npm test
npm run dev
```
เปิด URL ที่ Wrangler แสดง โดยทั่วไป `http://localhost:8787` ห้ามเปิด HTML ผ่าน `file://` เพราะต้องใช้ Worker API
ฐานข้อมูลและสลิปขั้นตอนนี้เป็นข้อมูลจำลองในเครื่อง ไม่แตะ D1/R2 จริง
Windows PowerShell ใช้ `npm.cmd` และ `npx.cmd` ถ้าระบบบล็อกสคริปต์
คำสั่ง dev และ db:local ใช้ `.state` ร่วมกันเพื่อให้ path ฐานข้อมูลสั้นพอบน Windows และตรึง Wrangler/Miniflare ให้ใช้ runtime รุ่นเดียวกัน หากย้ายโปรเจกต์ไป path ที่ยาวกว่านี้ ควรย้าย checkout ไปตำแหน่งสั้นลง

## 2. ตั้งค่าร้านสำหรับ production
ใส่ `PROMPTPAY_ID`, `ACCOUNT_NAME`, `BANK_NAME`, `ACCOUNT_NO` ใน `vars` ของ [wrangler.jsonc](wrangler.jsonc) ข้อมูลนี้จะแสดงต่อสาธารณะบนหน้าชำระเงิน
ค่าเริ่มต้นว่างเพื่อป้องกันการโอนเข้าบัญชีตัวอย่าง ระบบจะไม่เปิดรับคำสั่งซื้อจนกว่าจะตั้งพร้อมเพย์และชื่อบัญชี

เข้าสู่บัญชี Cloudflare ที่เป็นเจ้าของ D1/R2:
```sh
npx wrangler login
```
ตั้งรหัสผ่าน production ผ่าน secret (พิมพ์ใน prompt):
```sh
npx wrangler secret put ADMIN_PASSWORD
```
หาก Worker ยังไม่มี Wrangler อาจเสนอสร้าง Worker ให้ ตรวจชื่อ `oongtong-media` ก่อนยืนยัน
การเปลี่ยนรหัสผ่านทำให้ session เดิมใช้งานไม่ได้

## 3. สร้างตารางและ deploy
คำสั่งต่อไปนี้เขียนข้อมูลบนบัญชี Cloudflare จริง:
```sh
npm run db:remote
npm run deploy
```
หากใช้ GitHub integration ให้ install dependencies ด้วย `npm ci` แล้วใช้ `npm run deploy` เป็น deploy command การสร้างตารางครั้งแรกและ secret ยังต้องทำให้ครบ

## 4. ตรวจหลัง deploy
1. เปิด `/api/health`: ต้องได้ `ok: true` และ `paymentsConfigured: true`
2. ตรวจชื่อผู้รับและหมายเลขพร้อมเพย์ให้ตรงกับร้าน
3. กรอกยอดทดสอบแล้วใช้แอปธนาคารอ่าน QR ตรวจชื่อผู้รับและจำนวนเงินก่อนชำระจริง
4. ส่งคำสั่งซื้อทดสอบหนึ่งรายการและแนบสลิปทดสอบที่ไม่มีข้อมูลส่วนตัว
5. เข้าผู้ดูแลด้วยรหัสผ่าน ดูรายการ/สลิป เปลี่ยนสถานะ และโหลดใหม่เพื่อตรวจว่าเก็บสำเร็จ
6. ออกจากระบบและลองเปิด URL สลิปเดิม ต้องถูกปฏิเสธ
7. ตรวจหน้าเว็บบนมือถือจริงและ desktop

ไม่มีการใช้ Google Apps Script อีกต่อไป ไม่ต้องสร้างหรือ deploy โปรเจกต์ Google

## ดูแลระบบ
รหัสผ่านคือบัญชีผู้ดูแลร่วม ยังไม่มีบัญชีรายบุคคลหรือ audit log รายคน
session ที่หมดอายุและ rate-limit ที่หมดช่วงเวลาจะถูกล้างเมื่อมีการเข้าสู่ระบบสำเร็จ
เก็บ R2 เป็น private เสมอ ไม่จำเป็นต้องเปิด CORS หรือ public URL เพราะ Worker รับอัปโหลดและตรวจสิทธิ์ก่อนส่งสลิป
หากปริมาณสแปมสูง สามารถเพิ่ม Turnstile/WAF ภายหลังได้
ต้องสำรอง/กำหนดนโยบายอายุข้อมูลลูกค้าและสลิปตามการใช้งานของร้าน
