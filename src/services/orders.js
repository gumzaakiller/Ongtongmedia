import { AppError } from '../lib/http.js';
import { randomToken } from '../lib/crypto.js';
import { bangkokDate, nowIso } from '../lib/time.js';

export const STATUSES = ['pending', 'awaiting_verification', 'paid', 'processing', 'completed', 'cancelled'];

// Manual transitions an admin may make from the order page.
// 'paid' is reached only through payment verification (which also records income) — Phase 7.
// 'awaiting_verification' is reached only when a customer submits a slip — Phase 6.
export const MANUAL_TRANSITIONS = {
  pending: ['cancelled'],
  awaiting_verification: [],
  paid: ['processing', 'completed'],
  processing: ['completed'],
  completed: [],
  cancelled: []
};

// A batch statement that aborts the whole D1 batch (transaction) unless the condition holds.
// json_extract('{') raises "malformed JSON", rolling back every statement in the batch.
const GUARD_FAIL = 'malformed JSON';
export function guard(db, conditionSql, ...params) {
  return db.prepare(`SELECT CASE WHEN (${conditionSql}) THEN 1 ELSE json_extract('{', '$') END AS ok`).bind(...params);
}
export const isGuardFailure = e => String(e?.message || e).includes(GUARD_FAIL);

// Turn DB-enforced rule violations (triggers in 0002) into user-facing errors.
export function mapDbError(e) {
  const msg = String(e?.message || e);
  if (msg.includes('amount_locked')) return new AppError('แก้ยอดเงินไม่ได้ เพราะมีการส่งหลักฐานการชำระแล้วหรือออเดอร์ไม่อยู่ในสถานะรอชำระ', 409);
  if (msg.includes('order_not_payable')) return new AppError('ออเดอร์นี้ไม่อยู่ในสถานะที่รับชำระเงินได้', 409);
  if (msg.includes('amount_mismatch')) return new AppError('ยอดชำระไม่ตรงกับยอดออเดอร์', 409);
  if (msg.includes('income_requires_verified_payment')) return new AppError('ลงรายรับได้เฉพาะการชำระที่ยืนยันแล้ว', 409);
  return null;
}

const orderNoFor = (compact, n) => `ONT-${compact}-${String(n).padStart(4, '0')}`;
export const ORDER_NO_RE = /^ONT-\d{8}-\d{4,7}$/;
export const payUrl = (origin, token) => `${origin}/pay/${token}`;

export async function createOrder(env, input, requestKey, origin) {
  const db = env.DB;
  const existing = await db.prepare('SELECT order_no FROM orders WHERE request_key=?').bind(requestKey).first();
  if (existing) return { created: false, order: await getOrderDetail(env, existing.order_no, origin) };

  if (input.customer.id) {
    const found = await db.prepare('SELECT id FROM customers WHERE id=?').bind(input.customer.id).first();
    if (!found) throw new AppError('ไม่พบลูกค้าที่เลือก', 404);
  }
  const now = nowIso();
  const { compact } = bangkokDate();
  // Running number per Thai calendar day. Atomic; a failed order later only leaves a gap.
  const { last_no } = await db.prepare("INSERT INTO order_counters(day,last_no) VALUES(?,1) ON CONFLICT(day) DO UPDATE SET last_no=last_no+1 RETURNING last_no").bind(compact).first();
  const orderNo = orderNoFor(compact, last_no);
  const token = randomToken();

  const stmts = [];
  if (!input.customer.id) {
    stmts.push(db.prepare('INSERT INTO customers(name,phone,line_id,created_at,updated_at) VALUES(?,?,?,?,?)')
      .bind(input.customer.name, input.customer.phone, input.customer.lineId, now, now));
  }
  const customerIdSql = input.customer.id ? '?' : 'last_insert_rowid()';
  const orderParams = [orderNo, token, requestKey, ...(input.customer.id ? [input.customer.id] : []), input.title, input.note, input.internalNote, input.subtotal, input.discount, input.total, now, now];
  stmts.push(db.prepare(`INSERT INTO orders(order_no,public_token,request_key,customer_id,title,note,internal_note,subtotal_satang,discount_satang,total_satang,created_at,updated_at)
    VALUES(?,?,?,${customerIdSql},?,?,?,?,?,?,?,?)`).bind(...orderParams));
  for (const item of input.items) {
    stmts.push(db.prepare('INSERT INTO order_items(order_id,position,description,qty,unit_price_satang,amount_satang) SELECT id,?,?,?,?,? FROM orders WHERE order_no=?')
      .bind(item.position, item.description, item.qty, item.unitPrice, item.amount, orderNo));
  }
  stmts.push(db.prepare("INSERT INTO order_events(order_id,from_status,to_status,note,created_at) SELECT id,NULL,'pending','สร้างรายการเรียกเก็บเงิน',? FROM orders WHERE order_no=?").bind(now, orderNo));

  try { await db.batch(stmts); }
  catch (e) {
    // Same Idempotency-Key sent twice at once: the loser returns the winner's order.
    const raced = await db.prepare('SELECT order_no FROM orders WHERE request_key=?').bind(requestKey).first();
    if (raced) return { created: false, order: await getOrderDetail(env, raced.order_no, origin) };
    throw e;
  }
  return { created: true, order: await getOrderDetail(env, orderNo, origin) };
}

function serializeItems(rows) {
  return rows.map(r => ({ position: r.position, description: r.description, qty: r.qty, unitPriceSatang: r.unit_price_satang, amountSatang: r.amount_satang }));
}

export async function getOrderDetail(env, orderNo, origin) {
  const db = env.DB;
  const o = await db.prepare(`SELECT o.*, c.name AS customer_name, c.phone AS customer_phone, c.line_id AS customer_line_id
    FROM orders o JOIN customers c ON c.id=o.customer_id WHERE o.order_no=?`).bind(orderNo).first();
  if (!o) throw new AppError('ไม่พบออเดอร์', 404);
  const [items, payments, events] = await db.batch([
    db.prepare('SELECT * FROM order_items WHERE order_id=? ORDER BY position').bind(o.id),
    db.prepare('SELECT id,amount_satang,method,slip_key,slip_mime,slip_size,customer_note,status,reject_reason,submitted_at,reviewed_at FROM payments WHERE order_id=? ORDER BY id DESC').bind(o.id),
    db.prepare('SELECT from_status,to_status,note,created_at FROM order_events WHERE order_id=? ORDER BY id').bind(o.id)
  ]);
  return {
    orderNo: o.order_no,
    payUrl: payUrl(origin, o.public_token),
    status: o.status,
    version: o.version,
    title: o.title,
    note: o.note,
    internalNote: o.internal_note,
    customer: { id: o.customer_id, name: o.customer_name, phone: o.customer_phone, lineId: o.customer_line_id },
    items: serializeItems(items.results),
    subtotalSatang: o.subtotal_satang,
    discountSatang: o.discount_satang,
    totalSatang: o.total_satang,
    payments: payments.results.map(p => ({
      id: p.id, amountSatang: p.amount_satang, method: p.method, hasSlip: !!p.slip_key, slipMime: p.slip_mime, slipSize: p.slip_size,
      customerNote: p.customer_note, status: p.status, rejectReason: p.reject_reason, submittedAt: p.submitted_at, reviewedAt: p.reviewed_at
    })),
    events: events.results.map(e => ({ from: e.from_status, to: e.to_status, note: e.note, at: e.created_at })),
    paidAt: o.paid_at, cancelledAt: o.cancelled_at, createdAt: o.created_at, updatedAt: o.updated_at
  };
}

export async function listOrders(env, { status, q, cursor, limit = 30 }) {
  const where = []; const params = [];
  if (status) {
    if (!STATUSES.includes(status)) throw new AppError('สถานะไม่ถูกต้อง');
    where.push('o.status=?'); params.push(status);
  }
  if (q) {
    // instr() instead of LIKE: no wildcard escaping, and no D1 pattern-length limits.
    where.push('(instr(o.order_no, ?)>0 OR instr(c.name, ?)>0 OR instr(c.phone, ?)>0)');
    const term = q.toUpperCase().startsWith('ONT') ? q.toUpperCase() : q;
    params.push(term, q, q);
  }
  if (cursor) { where.push('o.id<?'); params.push(cursor); }
  const sql = `SELECT o.id,o.order_no,o.title,o.status,o.total_satang,o.created_at,o.paid_at,c.name AS customer_name,c.phone AS customer_phone
    FROM orders o JOIN customers c ON c.id=o.customer_id ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY o.id DESC LIMIT ?`;
  const { results } = await env.DB.prepare(sql).bind(...params, limit + 1).all();
  const page = results.slice(0, limit);
  return {
    orders: page.map(r => ({ orderNo: r.order_no, title: r.title, status: r.status, totalSatang: r.total_satang, customerName: r.customer_name, customerPhone: r.customer_phone, createdAt: r.created_at, paidAt: r.paid_at })),
    nextCursor: results.length > limit ? page.at(-1).id : null
  };
}

async function explainConflict(env, orderNo, version, expectStatuses, verb) {
  const row = await env.DB.prepare('SELECT status,version FROM orders WHERE order_no=?').bind(orderNo).first();
  if (!row) return new AppError('ไม่พบออเดอร์', 404);
  if (row.version !== version) return new AppError('ออเดอร์ถูกแก้ไขไปแล้ว กรุณาโหลดข้อมูลใหม่', 409);
  if (!expectStatuses.includes(row.status)) return new AppError(`${verb}ไม่ได้ในสถานะปัจจุบัน`, 409);
  return null;
}

export async function editOrder(env, orderNo, edit, origin) {
  const db = env.DB; const now = nowIso();
  const sets = ['version=version+1', 'updated_at=?']; const setParams = [now];
  for (const [field, column] of [['title', 'title'], ['note', 'note'], ['internalNote', 'internal_note']]) {
    if (field in edit) { sets.push(`${column}=?`); setParams.push(edit[field]); }
  }
  if (edit.items) {
    sets.push('subtotal_satang=?', 'discount_satang=?', 'total_satang=?');
    setParams.push(edit.subtotal, edit.discount, edit.total);
  }
  const stmts = [
    guard(db, "SELECT count(*) FROM orders WHERE order_no=? AND version=? AND status='pending'", orderNo, edit.version),
    db.prepare(`UPDATE orders SET ${sets.join(',')} WHERE order_no=?`).bind(...setParams, orderNo)
  ];
  if (edit.items) {
    stmts.push(db.prepare('DELETE FROM order_items WHERE order_id=(SELECT id FROM orders WHERE order_no=?)').bind(orderNo));
    for (const item of edit.items) {
      stmts.push(db.prepare('INSERT INTO order_items(order_id,position,description,qty,unit_price_satang,amount_satang) SELECT id,?,?,?,?,? FROM orders WHERE order_no=?')
        .bind(item.position, item.description, item.qty, item.unitPrice, item.amount, orderNo));
    }
  }
  stmts.push(db.prepare("INSERT INTO order_events(order_id,from_status,to_status,note,created_at) SELECT id,'pending','pending','แก้ไขรายละเอียด',? FROM orders WHERE order_no=?").bind(now, orderNo));
  try { await db.batch(stmts); }
  catch (e) {
    if (isGuardFailure(e)) throw (await explainConflict(env, orderNo, edit.version, ['pending'], 'แก้ไข')) || new AppError('แก้ไขไม่สำเร็จ กรุณาลองใหม่', 409);
    throw mapDbError(e) || e;
  }
  return getOrderDetail(env, orderNo, origin);
}

export async function changeStatus(env, orderNo, { to, version, note }, origin) {
  if (!STATUSES.includes(to)) throw new AppError('สถานะไม่ถูกต้อง');
  if (!Number.isInteger(version)) throw new AppError('ข้อมูลไม่ถูกต้อง');
  const row = await env.DB.prepare('SELECT status,version FROM orders WHERE order_no=?').bind(orderNo).first();
  if (!row) throw new AppError('ไม่พบออเดอร์', 404);
  if (row.version !== version) throw new AppError('ออเดอร์ถูกแก้ไขไปแล้ว กรุณาโหลดข้อมูลใหม่', 409);
  const from = row.status;
  if (!MANUAL_TRANSITIONS[from].includes(to)) throw new AppError(`เปลี่ยนสถานะจาก ${from} เป็น ${to} ไม่ได้`, 409);
  const db = env.DB; const now = nowIso();
  try {
    await db.batch([
      guard(db, 'SELECT count(*) FROM orders WHERE order_no=? AND version=? AND status=?', orderNo, version, from),
      db.prepare(`UPDATE orders SET status=?, version=version+1, updated_at=?, cancelled_at=CASE WHEN ?='cancelled' THEN ? ELSE cancelled_at END WHERE order_no=?`)
        .bind(to, now, to, now, orderNo),
      db.prepare('INSERT INTO order_events(order_id,from_status,to_status,note,created_at) SELECT id,?,?,?,? FROM orders WHERE order_no=?').bind(from, to, note || '', now, orderNo)
    ]);
  } catch (e) {
    if (isGuardFailure(e)) throw new AppError('ออเดอร์ถูกแก้ไขไปแล้ว กรุณาโหลดข้อมูลใหม่', 409);
    throw mapDbError(e) || e;
  }
  return getOrderDetail(env, orderNo, origin);
}

export async function searchCustomers(env, q) {
  const { results } = q
    ? await env.DB.prepare('SELECT id,name,phone,line_id FROM customers WHERE instr(name,?)>0 OR instr(phone,?)>0 OR instr(line_id,?)>0 ORDER BY updated_at DESC LIMIT 10').bind(q, q, q).all()
    : await env.DB.prepare('SELECT id,name,phone,line_id FROM customers ORDER BY updated_at DESC LIMIT 10').all();
  return results.map(c => ({ id: c.id, name: c.name, phone: c.phone, lineId: c.line_id }));
}

// What a customer sees through their pay link: no internal notes, no customer contact data, no ids.
export async function getPublicOrder(env, token) {
  const db = env.DB;
  const o = await db.prepare('SELECT id,order_no,title,note,status,subtotal_satang,discount_satang,total_satang,paid_at,created_at FROM orders WHERE public_token=?').bind(token).first();
  if (!o) return null;
  const [items, latest] = await db.batch([
    db.prepare('SELECT * FROM order_items WHERE order_id=? ORDER BY position').bind(o.id),
    db.prepare('SELECT status,reject_reason,submitted_at FROM payments WHERE order_id=? ORDER BY id DESC LIMIT 1').bind(o.id)
  ]);
  const last = latest.results[0];
  return {
    orderNo: o.order_no, title: o.title, note: o.note, status: o.status,
    items: serializeItems(items.results),
    subtotalSatang: o.subtotal_satang, discountSatang: o.discount_satang, totalSatang: o.total_satang,
    createdAt: o.created_at, paidAt: o.paid_at,
    lastPayment: last ? { status: last.status, rejectReason: last.status === 'rejected' ? last.reject_reason : '', submittedAt: last.submitted_at } : null
  };
}
