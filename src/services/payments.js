import { AppError } from '../lib/http.js';
import { randomHex, sha256Hex } from '../lib/crypto.js';
import { extensionFor } from '../lib/image.js';
import { bangkokDate, isYmd, nowIso } from '../lib/time.js';
import { getOrderDetail, guard, isGuardFailure, mapDbError } from './orders.js';

export const PAYMENT_METHODS = { promptpay: 'พร้อมเพย์', bank_transfer: 'โอนเข้าบัญชี', cash: 'เงินสด', other: 'อื่นๆ' };

const isUnique = (e, what) => String(e?.message || e).includes('UNIQUE') && String(e?.message || e).includes(what);

// ---------------------------------------------------------------------------
// Customer: upload a slip from the pay page → stored privately in R2, order becomes awaiting_verification.
// ---------------------------------------------------------------------------
export async function submitSlip(env, token, { bytes, mime, note, requestKey }) {
  const db = env.DB;
  const order = await db.prepare('SELECT id,order_no,status FROM orders WHERE public_token=?').bind(token).first();
  if (!order) throw new AppError('ไม่พบรายการชำระเงินนี้ กรุณาตรวจสอบลิงก์ หรือติดต่อร้าน', 404);

  // Same request sent again (network retry): answer with what was saved the first time.
  const previous = await db.prepare('SELECT order_id FROM payments WHERE request_key=?').bind(requestKey).first();
  if (previous) {
    if (previous.order_id !== order.id) throw new AppError('รหัสคำขอไม่ถูกต้อง', 409);
    return { replayed: true };
  }
  if (order.status === 'awaiting_verification') throw new AppError('ร้านได้รับหลักฐานการชำระของรายการนี้แล้ว กำลังตรวจสอบ', 409);
  if (order.status !== 'pending') throw new AppError('รายการนี้ไม่อยู่ในสถานะรอชำระเงิน', 409);

  const sha = await sha256Hex(bytes);
  if (await db.prepare('SELECT 1 FROM payments WHERE order_id=? AND slip_sha256=?').bind(order.id, sha).first()) {
    throw new AppError('สลิปนี้เคยส่งให้รายการนี้แล้ว หากชำระใหม่ กรุณาแนบสลิปใบใหม่', 409);
  }

  const now = nowIso(); const [yyyy, mm] = bangkokDate().ymd.split('-');
  const key = `slips/${yyyy}/${mm}/${order.order_no}/${randomHex(8)}.${extensionFor(mime)}`;
  await env.SLIPS.put(key, bytes, { httpMetadata: { contentType: mime }, customMetadata: { orderNo: order.order_no } });

  try {
    await db.batch([
      guard(db, "SELECT count(*) FROM orders WHERE id=? AND status='pending'", order.id),
      db.prepare(`INSERT INTO payments(order_id,request_key,amount_satang,method,slip_key,slip_sha256,slip_mime,slip_size,customer_note,submitted_at)
        SELECT id,?,total_satang,'promptpay',?,?,?,?,?,? FROM orders WHERE id=?`).bind(requestKey, key, sha, mime, bytes.length, note, now, order.id),
      db.prepare("UPDATE orders SET status='awaiting_verification', version=version+1, updated_at=? WHERE id=?").bind(now, order.id),
      db.prepare("INSERT INTO order_events(order_id,from_status,to_status,note,created_at) VALUES(?,'pending','awaiting_verification','ลูกค้าส่งหลักฐานการชำระ',?)").bind(order.id, now)
    ]);
  } catch (e) {
    // The DB write failed, so the uploaded file is not referenced: remove it (keeps R2 free of orphans).
    await env.SLIPS.delete(key).catch(() => {});
    if (await db.prepare('SELECT 1 FROM payments WHERE request_key=?').bind(requestKey).first()) return { replayed: true };
    if (isGuardFailure(e) || isUnique(e, 'payments.order_id')) throw new AppError('สถานะรายการเปลี่ยนไปแล้ว กรุณารีเฟรชหน้า', 409);
    if (isUnique(e, 'slip_sha256')) throw new AppError('สลิปนี้เคยส่งให้รายการนี้แล้ว', 409);
    throw mapDbError(e) || e;
  }
  return { replayed: false };
}

// ---------------------------------------------------------------------------
// Admin: verify / reject a submitted slip, or record a payment received outside the site (e.g. slip sent in LINE).
// ---------------------------------------------------------------------------
async function paymentWithOrder(env, paymentId) {
  const row = await env.DB.prepare(`SELECT p.id,p.status,p.submitted_at,o.order_no,o.version AS order_version,o.status AS order_status
    FROM payments p JOIN orders o ON o.id=p.order_id WHERE p.id=?`).bind(paymentId).first();
  if (!row) throw new AppError('ไม่พบรายการชำระเงิน', 404);
  return row;
}
function assertReviewable(row, version) {
  if (row.status !== 'submitted') throw new AppError('หลักฐานนี้ถูกตรวจไปแล้ว', 409);
  if (row.order_version !== version) throw new AppError('รายการถูกแก้ไขไปแล้ว กรุณาโหลดข้อมูลใหม่', 409);
}
const reviewGuard = (db, paymentId, version) => guard(db,
  "SELECT count(*) FROM payments p JOIN orders o ON o.id=p.order_id WHERE p.id=? AND p.status='submitted' AND o.version=? AND o.status='awaiting_verification'",
  paymentId, version);

export async function verifyPayment(env, paymentId, { version }, origin) {
  const db = env.DB; const row = await paymentWithOrder(env, paymentId);
  assertReviewable(row, version);
  const now = nowIso();
  const receivedDate = bangkokDate(new Date(row.submitted_at)).ymd; // the day the customer paid
  try {
    await db.batch([
      reviewGuard(db, paymentId, version),
      db.prepare("UPDATE payments SET status='verified', reviewed_at=? WHERE id=?").bind(now, paymentId),
      db.prepare("UPDATE orders SET status='paid', paid_at=?, version=version+1, updated_at=? WHERE id=(SELECT order_id FROM payments WHERE id=?)").bind(now, now, paymentId),
      // Amount, order and customer all come from D1. UNIQUE(order_id)/UNIQUE(payment_id) block a second income row.
      db.prepare(`INSERT INTO income(order_id,payment_id,customer_id,amount_satang,received_date,note,created_at)
        SELECT o.id,p.id,o.customer_id,p.amount_satang,?,'',? FROM payments p JOIN orders o ON o.id=p.order_id WHERE p.id=?`).bind(receivedDate, now, paymentId),
      db.prepare("INSERT INTO order_events(order_id,from_status,to_status,note,created_at) SELECT order_id,'awaiting_verification','paid','ยืนยันการชำระเงินแล้ว ลงรายรับอัตโนมัติ',? FROM payments WHERE id=?").bind(now, paymentId)
    ]);
  } catch (e) {
    if (isGuardFailure(e) || isUnique(e, 'income.')) throw new AppError('รายการนี้ถูกยืนยันหรือแก้ไขไปแล้ว กรุณาโหลดข้อมูลใหม่', 409);
    throw mapDbError(e) || e;
  }
  return getOrderDetail(env, row.order_no, origin);
}

export async function rejectPayment(env, paymentId, { version, reason }, origin) {
  const db = env.DB; const row = await paymentWithOrder(env, paymentId);
  assertReviewable(row, version);
  const now = nowIso();
  try {
    await db.batch([
      reviewGuard(db, paymentId, version),
      db.prepare("UPDATE payments SET status='rejected', reject_reason=?, reviewed_at=? WHERE id=?").bind(reason, now, paymentId),
      db.prepare("UPDATE orders SET status='pending', version=version+1, updated_at=? WHERE id=(SELECT order_id FROM payments WHERE id=?)").bind(now, paymentId),
      db.prepare("INSERT INTO order_events(order_id,from_status,to_status,note,created_at) SELECT order_id,'awaiting_verification','pending',?,? FROM payments WHERE id=?").bind(`หลักฐานไม่ผ่าน: ${reason}`, now, paymentId)
    ]);
  } catch (e) {
    if (isGuardFailure(e)) throw new AppError('รายการนี้ถูกตรวจหรือแก้ไขไปแล้ว กรุณาโหลดข้อมูลใหม่', 409);
    throw mapDbError(e) || e;
  }
  return getOrderDetail(env, row.order_no, origin);
}

export async function recordManualPayment(env, orderNo, { version, method, receivedDate, note }, origin) {
  if (!Number.isInteger(version)) throw new AppError('ข้อมูลไม่ถูกต้อง');
  if (!PAYMENT_METHODS[method]) throw new AppError('ช่องทางการชำระไม่ถูกต้อง');
  const today = bangkokDate().ymd;
  if (!isYmd(receivedDate) || receivedDate > today) throw new AppError('วันที่รับเงินไม่ถูกต้อง (ต้องไม่เกินวันนี้)');
  const db = env.DB;
  const order = await db.prepare('SELECT status,version FROM orders WHERE order_no=?').bind(orderNo).first();
  if (!order) throw new AppError('ไม่พบออเดอร์', 404);
  if (order.version !== version) throw new AppError('รายการถูกแก้ไขไปแล้ว กรุณาโหลดข้อมูลใหม่', 409);
  if (order.status === 'awaiting_verification') throw new AppError('มีหลักฐานจากลูกค้ารอตรวจอยู่ กรุณายืนยันหรือปฏิเสธหลักฐานนั้นก่อน', 409);
  if (order.status !== 'pending') throw new AppError('บันทึกรับชำระได้เฉพาะรายการที่รอชำระเงิน', 409);
  const now = nowIso(); const key = `manual-${randomHex(16)}`;
  const label = PAYMENT_METHODS[method];
  try {
    await db.batch([
      guard(db, "SELECT count(*) FROM orders WHERE order_no=? AND version=? AND status='pending'", orderNo, version),
      db.prepare('INSERT INTO payments(order_id,request_key,amount_satang,method,customer_note,submitted_at) SELECT id,?,total_satang,?,?,? FROM orders WHERE order_no=?').bind(key, method, note, now, orderNo),
      db.prepare("UPDATE payments SET status='verified', reviewed_at=? WHERE request_key=?").bind(now, key),
      db.prepare("UPDATE orders SET status='paid', paid_at=?, version=version+1, updated_at=? WHERE order_no=?").bind(now, now, orderNo),
      db.prepare(`INSERT INTO income(order_id,payment_id,customer_id,amount_satang,received_date,note,created_at)
        SELECT o.id,p.id,o.customer_id,p.amount_satang,?,?,? FROM payments p JOIN orders o ON o.id=p.order_id WHERE p.request_key=?`).bind(receivedDate, note, now, key),
      db.prepare("INSERT INTO order_events(order_id,from_status,to_status,note,created_at) SELECT id,'pending','paid',?,? FROM orders WHERE order_no=?").bind(`บันทึกรับชำระ (${label}) ลงรายรับอัตโนมัติ`, now, orderNo)
    ]);
  } catch (e) {
    if (isGuardFailure(e) || isUnique(e, 'income.')) throw new AppError('รายการถูกแก้ไขไปแล้ว กรุณาโหลดข้อมูลใหม่', 409);
    throw mapDbError(e) || e;
  }
  return getOrderDetail(env, orderNo, origin);
}

export async function getSlip(env, paymentId) {
  const row = await env.DB.prepare('SELECT slip_key FROM payments WHERE id=?').bind(paymentId).first();
  if (!row?.slip_key) throw new AppError('ไม่พบสลิป', 404);
  const object = await env.SLIPS.get(row.slip_key);
  if (!object) throw new AppError('ไม่พบไฟล์สลิป', 404);
  return new Response(object.body, { headers: {
    'Content-Type': object.httpMetadata?.contentType || 'application/octet-stream',
    'Content-Disposition': `inline; filename="slip-${paymentId}.${row.slip_key.split('.').pop()}"`
  } });
}
