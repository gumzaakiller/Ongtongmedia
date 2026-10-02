# ระบบชำระเงินร้านอองตองมีเดีย (Google Apps Script)

## สิ่งที่ระบบทำได้
- กรอกข้อมูลลูกค้า
- เพิ่มสินค้า/บริการหลายรายการ
- คำนวณยอด + ค่าจัดส่ง
- สร้าง QR PromptPay ตามยอดแบบไดนามิก
- แนบสลิป PNG/JPG/WEBP
- เก็บคำสั่งซื้อใน Google Sheets
- เก็บสลิปใน Google Drive
- มีหน้าผู้ดูแลสำหรับดูออเดอร์และเปลี่ยนสถานะ

## วิธีติดตั้ง
1. ไปที่ script.google.com แล้วสร้าง New project
2. สร้างไฟล์ `Code.gs` และวางโค้ดจากไฟล์ Code.gs
3. สร้างไฟล์ HTML ชื่อ `index` และวางโค้ดจาก index.html
4. แก้ค่าด้านบนใน `CONFIG` โดยเฉพาะ:
   - `PROMPTPAY_ID`
   - `BANK_NAME`
   - `ACCOUNT_NAME`
   - `ACCOUNT_NO`
   - `ADMIN_PIN`
5. ตั้ง Project Settings > Time zone เป็น `Asia/Bangkok`
6. เลือกฟังก์ชัน `setupSystem` แล้วกด Run 1 ครั้ง และอนุญาตสิทธิ์
7. Deploy > New deployment > Web app
   - Execute as: Me
   - Who has access: Anyone
8. เปิด URL ที่ได้เพื่อใช้งาน

## หมายเหตุสำคัญ
ระบบนี้เป็น “แจ้งชำระเงิน + แนบสลิป” ร้านยังต้องตรวจยอดเงินจริงก่อนเปลี่ยนสถานะเป็น “ชำระแล้ว”
หากต้องการตรวจเงินเข้าอัตโนมัติ ควรเชื่อมผู้ให้บริการ Payment Gateway / QR Payment API ที่รองรับ webhook และตรวจลายเซ็นฝั่งเซิร์ฟเวอร์

## ความปลอดภัยก่อนใช้จริง
- เปลี่ยน ADMIN_PIN
- อย่าเผยแพร่ Spreadsheet/Drive folder แบบสาธารณะ
- หากยอดขายสูงหรือมีข้อมูลลูกค้าจำนวนมาก ควรเพิ่มระบบล็อกอินแอดมินแทน PIN และใช้ payment gateway จริง
