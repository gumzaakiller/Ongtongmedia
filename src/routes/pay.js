import { AppError, json, readBody, readJson } from '../lib/http.js';
import { imageType, MAX_SLIP_BYTES } from '../lib/image.js';
import { text } from '../lib/validate.js';
import { submitSlip, notifyTransfer } from '../services/payments.js';
import { TOKEN_RE } from '../lib/crypto.js';
import { rateLimit } from '../lib/ratelimit.js';
import { promptPayPayload } from '../lib/promptpay.js';
import { qrPng } from '../lib/qr.js';
import { getPublicOrder } from '../services/orders.js';
import { shopConfig } from '../config.js';

const NOT_FOUND = 'ไม่พบรายการชำระเงินนี้ กรุณาตรวจสอบลิงก์ หรือติดต่อร้าน';

async function load(request, env, token) {
  // Limits link-guessing; a real customer (page + QR image) stays far below this.
  await rateLimit(request, env, 'pay-view', 120, 600);
  if (!TOKEN_RE.test(token)) throw new AppError(NOT_FOUND, 404);
  const order = await getPublicOrder(env, token);
  if (!order) throw new AppError(NOT_FOUND, 404);
  const shop = shopConfig(env);
  return { order, shop, payable: order.status === 'pending' && shop.ready };
}

export async function handlePayApi(request, env, token) {
  const { order, shop, payable } = await load(request, env, token);
  return json({
    order,
    shop: { name: shop.shopName, bankName: shop.bankName, accountName: shop.accountName, accountNo: shop.accountNo, promptPayId: shop.promptPayId, lineOaId: shop.lineOaId, facebookUrl: shop.facebookUrl, messengerUrl: shop.messengerUrl },
    // QR amount = orders.total_satang from D1. The browser only displays it.
    promptPayPayload: payable ? promptPayPayload(shop.promptPayId, order.totalSatang) : null,
    qrImageUrl: payable ? `/api/pay/${token}/qr.png` : null,
    canSubmitSlip: payable
  });
}

export async function handlePayQr(request, env, token) {
  const { order, shop, payable } = await load(request, env, token);
  if (!payable) throw new AppError('รายการนี้ไม่อยู่ในสถานะรอชำระเงิน', 409);
  const png = await qrPng(promptPayPayload(shop.promptPayId, order.totalSatang));
  return new Response(png, { headers: {
    'Content-Type': 'image/png',
    'Content-Disposition': `inline; filename="QR-${order.orderNo}.png"`
  } });
}

// Customer uploads a payment slip (multipart: slip=<image>, note=<text>), header Idempotency-Key.
export async function handlePaySlip(request, env, token) {
  await rateLimit(request, env, 'slip', 10, 600);
  if (!TOKEN_RE.test(token)) throw new AppError(NOT_FOUND, 404);
  const key = request.headers.get('Idempotency-Key');
  if (!/^[A-Za-z0-9-]{16,64}$/.test(key || '')) throw new AppError('รหัสคำขอไม่ถูกต้อง');
  const type = request.headers.get('content-type') || '';
  if (!type.startsWith('multipart/form-data')) throw new AppError('รูปแบบข้อมูลไม่ถูกต้อง', 415);
  let form;
  try { form = await new Response(await readBody(request, MAX_SLIP_BYTES + 64 * 1024), { headers: { 'Content-Type': type } }).formData(); }
  catch (e) { if (e instanceof AppError) throw e; throw new AppError('ข้อมูลที่ส่งมาไม่ถูกต้อง'); }
  const file = form.get('slip');
  if (!file || typeof file === 'string' || !file.size) throw new AppError('กรุณาเลือกรูปสลิป');
  if (file.size > MAX_SLIP_BYTES) throw new AppError('รูปสลิปต้องมีขนาดไม่เกิน 8 MB', 413);
  const bytes = new Uint8Array(await file.arrayBuffer());
  const mime = imageType(bytes); // from the file's bytes, not its name
  const note = text(form.get('note') ?? '', 'ข้อความถึงร้าน', 300);
  const { replayed } = await submitSlip(env, token, { bytes, mime, note, requestKey: key });
  return json({ ok: true, status: 'awaiting_verification' }, replayed ? 200 : 201);
}

// Customer says they have transferred, without a slip (JSON: { note }), header Idempotency-Key.
export async function handlePayNotify(request, env, token) {
  await rateLimit(request, env, 'slip', 10, 600);
  if (!TOKEN_RE.test(token)) throw new AppError(NOT_FOUND, 404);
  const key = request.headers.get('Idempotency-Key');
  if (!/^[A-Za-z0-9-]{16,64}$/.test(key || '')) throw new AppError('รหัสคำขอไม่ถูกต้อง');
  const body = await readJson(request);
  const note = text(body?.note ?? '', 'ข้อความถึงร้าน', 300);
  const { replayed } = await notifyTransfer(env, token, { note, requestKey: key });
  return json({ ok: true, status: 'awaiting_verification' }, replayed ? 200 : 201);
}
