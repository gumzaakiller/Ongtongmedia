// Invoices (ใบแจ้งหนี้), delivery notes (ใบส่งของ) and receipts (ใบเสร็จรับเงิน), laid out like the shop's paper forms.
// Numbers run per document type per Thai (BE) year: "เล่มที่ 69 เลขที่ 0001". Re-issuing a document keeps its number.
// Each document stores a snapshot of what was printed, so later edits elsewhere never change an issued document.
import { AppError } from '../lib/http.js';
import { text } from '../lib/validate.js';
import { bangkokDate, isYmd, nowIso } from '../lib/time.js';
import { bahtText } from '../lib/thaitext.js';
import { shopConfig } from '../config.js';
import { PAYMENT_METHODS } from './payments.js';

export const DOC_TYPES = { invoice: 'ใบแจ้งหนี้', delivery: 'ใบส่งของ', receipt: 'ใบเสร็จรับเงิน' };
const SETTING_KEYS = { address: 'doc_address', phone: 'doc_phone', taxId: 'doc_tax_id', signer: 'doc_signer' };
const PAID = ['paid', 'processing', 'completed'];

export async function getDocSettings(env) {
  const { results } = await env.DB.prepare(`SELECT key,value FROM settings WHERE key IN (${Object.values(SETTING_KEYS).map(() => '?').join(',')})`).bind(...Object.values(SETTING_KEYS)).all();
  const map = Object.fromEntries(results.map(r => [r.key, r.value]));
  return Object.fromEntries(Object.entries(SETTING_KEYS).map(([k, key]) => [k, map[key] || '']));
}

export async function saveDocSettings(env, body) {
  if (!body || typeof body !== 'object') throw new AppError('ข้อมูลไม่ถูกต้อง');
  const v = {
    address: text(body.address, 'ที่อยู่ร้าน', 300),
    phone: text(body.phone, 'เบอร์โทรร้าน', 100),
    taxId: text(body.taxId, 'เลขประจำตัวผู้เสียภาษี', 20),
    signer: text(body.signer, 'ชื่อผู้ลงนาม', 120)
  };
  if (v.taxId && !/^\d{13}$/.test(v.taxId.replace(/[\s-]/g, ''))) throw new AppError('เลขประจำตัวผู้เสียภาษีต้องเป็นตัวเลข 13 หลัก');
  v.taxId = v.taxId.replace(/[\s-]/g, '');
  const now = nowIso();
  await env.DB.batch(Object.entries(SETTING_KEYS).map(([k, key]) =>
    env.DB.prepare('INSERT INTO settings(key,value,updated_at) VALUES(?,?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at=excluded.updated_at').bind(key, v[k], now)));
  return v;
}

function validateDocCustomer(c) {
  if (!c || typeof c !== 'object') return null;
  const taxId = text(c.taxId, 'เลขผู้เสียภาษีลูกค้า', 20).replace(/[\s-]/g, '');
  if (taxId && !/^\d{13}$/.test(taxId)) throw new AppError('เลขผู้เสียภาษีลูกค้าต้องเป็นตัวเลข 13 หลัก');
  return { name: text(c.name, 'ชื่อลูกค้า', 200, { required: true }), address: text(c.address, 'ที่อยู่ลูกค้า', 300), phone: text(c.phone, 'เบอร์โทรลูกค้า', 30), taxId };
}

const docLabel = (year, seq) => ({ book: String(year).slice(-2), number: String(seq).padStart(4, '0') });

async function loadOrder(env, where, value) {
  const o = await env.DB.prepare(`SELECT o.*, c.name AS c_name, c.phone AS c_phone, c.address AS c_address, c.tax_id AS c_tax_id
    FROM orders o JOIN customers c ON c.id=o.customer_id WHERE o.${where}=?`).bind(value).first();
  if (!o) throw new AppError('ไม่พบออเดอร์', 404);
  return o;
}

async function buildSnapshot(env, o, type, issuedDate, year, seq) {
  const db = env.DB;
  const [items, pay, delivery] = await db.batch([
    db.prepare('SELECT position,description,qty,unit_price_satang,amount_satang FROM order_items WHERE order_id=? ORDER BY position').bind(o.id),
    db.prepare("SELECT method FROM payments WHERE order_id=? AND status='verified' ORDER BY id DESC LIMIT 1").bind(o.id),
    db.prepare("SELECT year,seq FROM documents WHERE order_id=? AND doc_type='delivery'").bind(o.id)
  ]);
  const shop = shopConfig(env), info = await getDocSettings(env);
  const d = delivery.results[0];
  return {
    type, title: DOC_TYPES[type], ...docLabel(year, seq), issuedDate, orderNo: o.order_no,
    shop: { name: shop.shopName, ...info, bankName: shop.bankName, accountName: shop.accountName, accountNo: shop.accountNo, promptPayId: shop.promptPayId },
    customer: { name: o.c_name, address: o.c_address, phone: o.c_phone, taxId: o.c_tax_id },
    items: items.results.map(i => ({ position: i.position, description: i.description, qty: i.qty, unitPriceSatang: i.unit_price_satang, amountSatang: i.amount_satang })),
    subtotalSatang: o.subtotal_satang, discountSatang: o.discount_satang, totalSatang: o.total_satang,
    amountText: bahtText(o.total_satang),
    deliveryRef: type === 'receipt' && d ? docLabel(d.year, d.seq) : null,
    paymentMethod: type === 'receipt' && pay.results[0] ? PAYMENT_METHODS[pay.results[0].method] || '' : ''
  };
}

// Admin: issue (or re-issue) a document for a bill. customer = optional fixes saved to the customer record.
export async function issueDocument(env, orderNo, { type, customer, date }) {
  if (!DOC_TYPES[type]) throw new AppError('ประเภทเอกสารไม่ถูกต้อง');
  const db = env.DB;
  let o = await loadOrder(env, 'order_no', orderNo);
  if (o.status === 'cancelled') throw new AppError('บิลนี้ถูกยกเลิกแล้ว ออกเอกสารไม่ได้', 409);
  if (type === 'receipt' && !PAID.includes(o.status)) throw new AppError('ออกใบเสร็จได้หลังยืนยันการชำระเงินแล้วเท่านั้น', 409);
  const today = bangkokDate().ymd;
  if (date !== undefined && date !== null && date !== '' && (!isYmd(date) || date > today)) throw new AppError('วันที่เอกสารไม่ถูกต้อง (ต้องไม่เกินวันนี้)');

  const c = validateDocCustomer(customer);
  if (c) {
    await db.prepare('UPDATE customers SET name=?, address=?, phone=?, tax_id=?, updated_at=? WHERE id=?').bind(c.name, c.address, c.phone, c.taxId, nowIso(), o.customer_id).run();
    o = await loadOrder(env, 'order_no', orderNo);
  }
  const existing = await db.prepare('SELECT * FROM documents WHERE order_id=? AND doc_type=?').bind(o.id, type).first();
  const now = nowIso();
  if (existing) {
    const issued = date || existing.issued_date;
    const snap = await buildSnapshot(env, o, type, issued, existing.year, existing.seq);
    await db.prepare('UPDATE documents SET snapshot_json=?, issued_date=?, updated_at=? WHERE id=?').bind(JSON.stringify(snap), issued, now, existing.id).run();
    return { id: existing.id, ...snap };
  }
  return createDocument(env, o, type, date || (type === 'receipt' && o.paid_at ? bangkokDate(new Date(o.paid_at)).ymd : today));
}

async function createDocument(env, o, type, issued) {
  const db = env.DB;
  const year = +issued.slice(0, 4) + 543;
  const { last_no } = await db.prepare('INSERT INTO doc_counters(doc_type,year,last_no) VALUES(?,?,1) ON CONFLICT(doc_type,year) DO UPDATE SET last_no=last_no+1 RETURNING last_no').bind(type, year).first();
  const snap = await buildSnapshot(env, o, type, issued, year, last_no);
  const now = nowIso();
  try {
    const row = await db.prepare('INSERT INTO documents(order_id,doc_type,year,seq,issued_date,snapshot_json,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?) RETURNING id')
      .bind(o.id, type, year, last_no, issued, JSON.stringify(snap), now, now).first();
    return { id: row.id, ...snap };
  } catch (e) {
    // Issued at the same moment by another tap: return that one (the counter only skips a number).
    const other = await db.prepare('SELECT id,snapshot_json FROM documents WHERE order_id=? AND doc_type=?').bind(o.id, type).first();
    if (other) return { id: other.id, ...JSON.parse(other.snapshot_json) };
    if (String(e?.message).includes('receipt_requires_paid')) throw new AppError('ออกใบเสร็จได้หลังยืนยันการชำระเงินแล้วเท่านั้น', 409);
    throw e;
  }
}

export async function getDocument(env, id) {
  const row = await env.DB.prepare('SELECT id,snapshot_json FROM documents WHERE id=?').bind(id).first();
  if (!row) throw new AppError('ไม่พบเอกสาร', 404);
  return { id: row.id, ...JSON.parse(row.snapshot_json) };
}

// Customer: the receipt of a paid bill, from the pay link. Issued on first request with the details on file.
export async function receiptForToken(env, token) {
  const o = await loadOrder(env, 'public_token', token);
  if (!PAID.includes(o.status)) throw new AppError('ใบเสร็จจะออกได้หลังร้านยืนยันการชำระเงินแล้ว', 409);
  const existing = await env.DB.prepare("SELECT id,snapshot_json FROM documents WHERE order_id=? AND doc_type='receipt'").bind(o.id).first();
  if (existing) return { id: existing.id, ...JSON.parse(existing.snapshot_json) };
  return createDocument(env, o, 'receipt', o.paid_at ? bangkokDate(new Date(o.paid_at)).ymd : bangkokDate().ymd);
}
