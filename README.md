# Oongtong Media - GitHub + Cloudflare

## โครงสร้าง
- `public/index.html` หน้าเว็บชำระเงิน
- `public/oongtong-logo.jpg` โลโก้ร้าน
- `public/payment-qr.jpg` QR ชำระเงิน
- `src/index.js` Cloudflare Worker (มี `/api/health`)
- `wrangler.jsonc` การตั้งค่า Cloudflare

## สิ่งที่ต้องแก้ก่อนใช้จริง
เปิด `public/index.html` แล้วเปลี่ยน `@YOUR_LINE_ID` เป็น LINE OA ของร้าน

## Deploy จากเครื่องด้วย Wrangler
```bash
npm install
npx wrangler login
npm run deploy
```

## Deploy จาก GitHub ผ่าน Cloudflare
1. Push โฟลเดอร์นี้ขึ้น GitHub repository `Ongtongmedia`
2. Cloudflare Dashboard > Workers & Pages > Create > Import a repository
3. เลือก GitHub และเลือก repository `Ongtongmedia`
4. Build command: `npm run deploy`
5. Root directory: `/`
6. Deploy

> ชุดนี้ยังเป็น frontend + Worker พื้นฐาน ยังไม่ได้เปิด D1/R2 จริง
> ขั้นต่อไปสามารถเพิ่ม D1 สำหรับ orders/payments/accounting และ R2 สำหรับเก็บสลิปได้
