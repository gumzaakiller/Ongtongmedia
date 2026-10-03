import { AppError, json } from '../lib/http.js';
import { TOKEN_RE } from '../lib/crypto.js';
import { rateLimit } from '../lib/ratelimit.js';
import { promptPayPayload } from '../lib/promptpay.js';
import { getPublicOrder } from '../services/orders.js';
import { shopConfig } from '../config.js';

const NOT_FOUND = 'ไม่พบรายการชำระเงินนี้ กรุณาตรวจสอบลิงก์ หรือติดต่อร้าน';

export async function handlePayApi(request, env, token) {
  // Limits link-guessing; a real customer reloads far less than this.
  await rateLimit(request, env, 'pay-view', 120, 600);
  if (!TOKEN_RE.test(token)) throw new AppError(NOT_FOUND, 404);
  const order = await getPublicOrder(env, token);
  if (!order) throw new AppError(NOT_FOUND, 404);
  const shop = shopConfig(env);
  const payable = order.status === 'pending' && shop.ready;
  return json({
    order,
    shop: { name: shop.shopName, bankName: shop.bankName, accountName: shop.accountName, accountNo: shop.accountNo, promptPayId: shop.promptPayId, lineOaId: shop.lineOaId },
    // QR amount = orders.total_satang from D1. The browser only draws it.
    promptPayPayload: payable ? promptPayPayload(shop.promptPayId, order.totalSatang) : null,
    canSubmitSlip: payable
  });
}
