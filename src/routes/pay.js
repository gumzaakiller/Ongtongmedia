import { AppError, json } from '../lib/http.js';
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
    shop: { name: shop.shopName, bankName: shop.bankName, accountName: shop.accountName, accountNo: shop.accountNo, promptPayId: shop.promptPayId, lineOaId: shop.lineOaId },
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
