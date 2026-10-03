// Walk-in transfer page (/transfer, linked from the LINE OA rich menu): the customer pays without
// waiting for a bill link, then sends name + amount + slip. The server turns that into a bill
// (order) + payment waiting for the shop to verify, so the usual verify → income flow applies.
// The amount here is what the customer says they paid; the shop checks it against the slip/bank.
import { AppError, json, readBody } from '../lib/http.js';
import { imageType, MAX_SLIP_BYTES } from '../lib/image.js';
import { text, validateNewOrder } from '../lib/validate.js';
import { toSatang } from '../lib/money.js';
import { rateLimit } from '../lib/ratelimit.js';
import { promptPayPayload } from '../lib/promptpay.js';
import { qrPng } from '../lib/qr.js';
import { createOrder } from '../services/orders.js';
import { submitSlipForOrder } from '../services/payments.js';
import { nowIso } from '../lib/time.js';
import { shopConfig } from '../config.js';

function readyShop(env) {
  const shop = shopConfig(env);
  if (!shop.ready) throw new AppError('ร้านยังไม่ได้ตั้งค่าข้อมูลรับชำระเงิน', 503);
  return shop;
}

export function handleTransferInfo(env) {
  const s = readyShop(env);
  return json({ shop: { name: s.shopName, bankName: s.bankName, accountName: s.accountName, accountNo: s.accountNo, promptPayId: s.promptPayId, lineOaId: s.lineOaId, facebookUrl: s.facebookUrl, messengerUrl: s.messengerUrl } });
}

// GET /api/transfer/qr.png[?amount=850.50]
export async function handleTransferQr(request, env) {
  await rateLimit(request, env, 'transfer-qr', 60, 600);
  const shop = readyShop(env);
  const raw = new URL(request.url).searchParams.get('amount');
  const satang = raw ? toSatang(raw, 'ยอดเงิน') : null;
  const png = await qrPng(promptPayPayload(shop.promptPayId, satang));
  return new Response(png, { headers: { 'Content-Type': 'image/png', 'Cache-Control': 'no-store' } });
}

// POST /api/transfer  multipart: slip, name, phone, amount, ref, note · header Idempotency-Key
export async function handleTransferSubmit(request, env, origin) {
  await rateLimit(request, env, 'transfer', 5, 600);
  readyShop(env);
  const key = request.headers.get('Idempotency-Key');
  if (!/^[A-Za-z0-9-]{16,64}$/.test(key || '')) throw new AppError('รหัสคำขอไม่ถูกต้อง');
  const type = request.headers.get('content-type') || '';
  if (!type.startsWith('multipart/form-data')) throw new AppError('รูปแบบข้อมูลไม่ถูกต้อง', 415);
  let form;
  try { form = await new Response(await readBody(request, MAX_SLIP_BYTES + 64 * 1024), { headers: { 'Content-Type': type } }).formData(); }
  catch (e) { if (e instanceof AppError) throw e; throw new AppError('ข้อมูลที่ส่งมาไม่ถูกต้อง'); }

  const name = text(form.get('name') ?? '', 'ชื่อผู้โอน', 200, { required: true });
  const phone = text(form.get('phone') ?? '', 'เบอร์โทร', 30, { required: true });
  const ref = text(form.get('ref') ?? '', 'โอนค่าอะไร', 200);
  const note = text(form.get('note') ?? '', 'ข้อความถึงร้าน', 300);
  const file = form.get('slip');
  if (!file || typeof file === 'string' || !file.size) throw new AppError('กรุณาแนบรูปสลิป');
  if (file.size > MAX_SLIP_BYTES) throw new AppError('รูปสลิปต้องมีขนาดไม่เกิน 8 MB', 413);
  const bytes = new Uint8Array(await file.arrayBuffer());
  const mime = imageType(bytes);

  toSatang(String(form.get('amount') ?? '').replace(/,/g, ''), 'ยอดที่โอน'); // clear message before building the bill
  const input = validateNewOrder({
    customer: { name, phone },
    title: ref ? `แจ้งโอน: ${ref}` : 'แจ้งโอนจากลูกค้า',
    items: [{ description: ref || 'ชำระเงินค่างาน', qty: 1, unitPrice: String(form.get('amount') ?? '').replace(/,/g, '') }],
    internalNote: 'ลูกค้ากรอกยอดเองจากหน้าโอนเงิน ตรวจยอดกับสลิปและบัญชีก่อนยืนยัน'
  });

  const { order } = await createOrder(env, input, `t-${key}`, origin);
  const row = await env.DB.prepare('SELECT id,order_no,status FROM orders WHERE order_no=?').bind(order.orderNo).first();
  try {
    await submitSlipForOrder(env, row, { bytes, mime, note, requestKey: key });
  } catch (e) {
    // No slip attached to this new bill: cancel it so it doesn't sit in the list as an unpaid bill.
    if (row.status === 'pending') {
      const now = nowIso();
      await env.DB.batch([
        env.DB.prepare("UPDATE orders SET status='cancelled', cancelled_at=?, version=version+1, updated_at=? WHERE id=? AND status='pending' AND NOT EXISTS (SELECT 1 FROM payments WHERE order_id=?)").bind(now, now, row.id, row.id),
        env.DB.prepare("INSERT INTO order_events(order_id,from_status,to_status,note,created_at) SELECT id,'pending','cancelled','ส่งสลิปไม่สำเร็จ ยกเลิกอัตโนมัติ',? FROM orders WHERE id=? AND status='cancelled'").bind(now, row.id)
      ]).catch(() => {});
    }
    throw e;
  }
  return json({ ok: true, orderNo: order.orderNo, payUrl: order.payUrl }, 201);
}
