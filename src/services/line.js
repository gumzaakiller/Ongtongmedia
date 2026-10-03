import { AppError, json, readBody } from '../lib/http.js';
import { imageType, MAX_SLIP_BYTES } from '../lib/image.js';
import { nowIso } from '../lib/time.js';
import { submitSlipForOrder } from './payments.js';

// LINE OA webhook (Messaging API). Inactive until LINE_CHANNEL_SECRET and LINE_CHANNEL_ACCESS_TOKEN are set.
//   1. customer taps "ส่งทาง LINE" on the pay page → chat opens with the order number typed in
//   2. that text message links the LINE user to the order (line_links)
//   3. the slip image they send next is stored in R2 and the order becomes awaiting_verification
// Replies never include amounts or names: order numbers are guessable, so a stranger learns nothing.
const LINK_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const ORDER_NO_IN_TEXT = /ONT-\d{8}-\d{4,7}/i;

export const lineEnabled = env => !!(env.LINE_CHANNEL_SECRET && env.LINE_CHANNEL_ACCESS_TOKEN);

const b64 = s => Uint8Array.from(atob(s), c => c.charCodeAt(0));
export async function validLineSignature(secret, body, signature) {
  if (!signature || !/^[A-Za-z0-9+/]+=*$/.test(signature)) return false;
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['verify']);
  try { return await crypto.subtle.verify('HMAC', key, b64(signature), body); } catch { return false; }
}

async function reply(env, replyToken, text) {
  if (!replyToken) return;
  const res = await fetch('https://api.line.me/v2/bot/message/reply', {
    method: 'POST',
    headers: { Authorization: `Bearer ${env.LINE_CHANNEL_ACCESS_TOKEN}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ replyToken, messages: [{ type: 'text', text }] })
  });
  if (!res.ok) console.error('LINE reply failed', res.status);
}

async function fetchImage(env, messageId) {
  const res = await fetch(`https://api-data.line.me/v2/bot/message/${encodeURIComponent(messageId)}/content`, {
    headers: { Authorization: `Bearer ${env.LINE_CHANNEL_ACCESS_TOKEN}` }
  });
  if (!res.ok) throw new Error(`LINE content ${res.status}`);
  if (Number(res.headers.get('content-length')) > MAX_SLIP_BYTES) throw new AppError('รูปใหญ่เกิน 8 MB', 413);
  return readBody(res, MAX_SLIP_BYTES);
}

const MSG = {
  linked: no => `รับเลขที่ ${no} แล้ว\nส่งรูปสลิปในแชทนี้ได้เลย ร้านจะตรวจสอบและแจ้งผล`,
  alreadyWaiting: no => `รายการ ${no} ร้านได้รับสลิปแล้ว กำลังตรวจสอบ`,
  alreadyPaid: no => `รายการ ${no} ชำระเรียบร้อยแล้ว ขอบคุณค่ะ`,
  cancelled: no => `รายการ ${no} ถูกยกเลิกแล้ว หากมีข้อสงสัยพิมพ์สอบถามร้านได้เลย`,
  notFound: 'ไม่พบเลขที่รายการนี้ กรุณาตรวจสอบเลขที่อีกครั้ง',
  needOrderNo: 'รับรูปแล้ว แต่ระบบยังไม่ทราบว่าเป็นของรายการไหน\nกรุณาพิมพ์เลขที่รายการ (เช่น ONT-20261003-0001) แล้วส่งรูปสลิปอีกครั้ง',
  slipSaved: no => `ได้รับสลิปของรายการ ${no} แล้ว\nร้านจะตรวจสอบยอดเงินและแจ้งผลค่ะ`,
  badImage: 'รูปนี้ใช้เป็นสลิปไม่ได้ กรุณาส่งรูปสลิป (JPG หรือ PNG) ขนาดไม่เกิน 8 MB'
};

async function onText(env, event) {
  const no = event.message.text.match(ORDER_NO_IN_TEXT)?.[0].toUpperCase();
  if (!no) return; // ordinary chat: leave it for the shop to answer
  const order = await env.DB.prepare('SELECT id,order_no,status FROM orders WHERE order_no=?').bind(no).first();
  if (!order) return reply(env, event.replyToken, MSG.notFound);
  if (order.status === 'pending') {
    await env.DB.prepare('INSERT INTO line_links(line_user_id,order_id,updated_at) VALUES(?,?,?) ON CONFLICT(line_user_id) DO UPDATE SET order_id=excluded.order_id, updated_at=excluded.updated_at')
      .bind(event.source.userId, order.id, nowIso()).run();
    return reply(env, event.replyToken, MSG.linked(order.order_no));
  }
  const text = order.status === 'awaiting_verification' ? MSG.alreadyWaiting(order.order_no)
    : order.status === 'cancelled' ? MSG.cancelled(order.order_no) : MSG.alreadyPaid(order.order_no);
  return reply(env, event.replyToken, text);
}

async function onImage(env, event) {
  const link = await env.DB.prepare(`SELECT o.id,o.order_no,o.status,l.updated_at FROM line_links l JOIN orders o ON o.id=l.order_id WHERE l.line_user_id=?`)
    .bind(event.source.userId).first();
  if (!link || Date.now() - Date.parse(link.updated_at) > LINK_TTL_MS) return reply(env, event.replyToken, MSG.needOrderNo);
  if (link.status !== 'pending') return reply(env, event.replyToken, link.status === 'awaiting_verification' ? MSG.alreadyWaiting(link.order_no) : MSG.alreadyPaid(link.order_no));
  let bytes, mime;
  try { bytes = await fetchImage(env, event.message.id); mime = imageType(bytes); }
  catch (e) { if (e instanceof AppError) return reply(env, event.replyToken, MSG.badImage); throw e; }
  try {
    await submitSlipForOrder(env, link, { bytes, mime, note: 'ส่งทาง LINE', requestKey: `line-${event.message.id}` });
  } catch (e) {
    if (e instanceof AppError) return reply(env, event.replyToken, e.message);
    throw e;
  }
  return reply(env, event.replyToken, MSG.slipSaved(link.order_no));
}

export async function handleLineWebhook(request, env) {
  if (!lineEnabled(env)) throw new AppError('ไม่พบ API หรือวิธีเรียกไม่ถูกต้อง', 404);
  const body = await readBody(request, 1024 * 1024);
  if (!await validLineSignature(env.LINE_CHANNEL_SECRET, body, request.headers.get('x-line-signature'))) throw new AppError('ลายเซ็นไม่ถูกต้อง', 401);
  let payload;
  try { payload = JSON.parse(new TextDecoder().decode(body)); } catch { throw new AppError('ข้อมูลไม่ถูกต้อง'); }
  for (const event of payload.events || []) {
    if (event.type !== 'message' || event.source?.type !== 'user' || !event.source.userId) continue;
    try {
      if (event.message?.type === 'text') await onText(env, event);
      else if (event.message?.type === 'image') await onImage(env, event);
    } catch (e) {
      // One bad event must not make LINE retry the whole batch; the shop still sees the message in LINE chat.
      console.error('LINE event failed', e?.name, e?.message);
    }
  }
  return json({ ok: true });
}
