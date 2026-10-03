import { AppError } from '../lib/http.js';
import { randomHex, randomToken } from '../lib/crypto.js';
import { bangkokDate, isYmd, nowIso } from '../lib/time.js';
import { text } from '../lib/validate.js';
import { CATALOG, catalogById } from '../catalog.js';
import { payUrl } from './orders.js';

export const MAX_FILE_BYTES = 20 * 1024 * 1024;
export const MAX_FILES = 5;
export const REQUEST_NO_RE = /^REQ-\d{8}-\d{4,7}$/;
const FILE_EXT = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp', 'application/pdf': 'pdf' };
export const requestUrl = (origin, token) => `${origin}/request/${token}`;

// Type from the file's bytes: images (PNG/JPG/WEBP) and PDF only.
export function fileType(bytes) {
  if (bytes.length >= 24 && [137, 80, 78, 71, 13, 10, 26, 10].every((b, i) => bytes[i] === b)) return 'image/png';
  if (bytes.length >= 4 && bytes[0] === 0xFF && bytes[1] === 0xD8 && bytes[2] === 0xFF) return 'image/jpeg';
  if (bytes.length >= 16 && String.fromCharCode(...bytes.slice(0, 4)) === 'RIFF' && String.fromCharCode(...bytes.slice(8, 12)) === 'WEBP') return 'image/webp';
  if (bytes.length >= 8 && String.fromCharCode(...bytes.slice(0, 5)) === '%PDF-') return 'application/pdf';
  throw new AppError('แนบได้เฉพาะรูปภาพ (JPG, PNG, WEBP) หรือ PDF');
}

const num = (v, label, { min, max, int = false }) => {
  if (v === undefined || v === null || v === '') return null;
  const s = String(v).trim();
  if (!(int ? /^\d{1,6}$/ : /^\d{1,6}(\.\d{1,2})?$/).test(s)) throw new AppError(`${label} ไม่ถูกต้อง`);
  const n = Number(s);
  if (n < min || n > max) throw new AppError(`${label} ต้องอยู่ระหว่าง ${min}–${max}`);
  return n;
};

export function validateRequest(f) {
  const cat = catalogById(f.category);
  if (!cat) throw new AppError('กรุณาเลือกประเภทงาน');
  const details = {
    qty: num(f.qty, 'จำนวน', { min: 1, max: 100000, int: true }) ?? 1,
    options: [],
    artwork: ['have', 'need_design', 'edit'].includes(f.artwork) ? f.artwork : 'have',
    deadline: '',
    details: text(f.details, 'รายละเอียดงาน', 2000)
  };
  if (cat.size) {
    details.width = num(f.width, 'ความกว้าง', { min: 0.1, max: 100000 });
    details.height = num(f.height, 'ความสูง', { min: 0.1, max: 100000 });
    details.unit = ['cm', 'm'].includes(f.unit) ? f.unit : 'cm';
  }
  const opts = Array.isArray(f.options) ? f.options : [];
  for (const o of opts) if (cat.options.includes(o) && !details.options.includes(o)) details.options.push(o);
  if (f.deadline) {
    if (!isYmd(f.deadline) || f.deadline < bangkokDate().ymd) throw new AppError('วันที่ต้องการรับงานไม่ถูกต้อง');
    details.deadline = f.deadline;
  }
  if (cat.id === 'other' && !details.details) throw new AppError('กรุณาบอกรายละเอียดงาน');
  const phone = text(f.phone, 'เบอร์โทร', 30);
  if (phone && (!/^\+?[\d\s()-]{8,30}$/.test(phone) || phone.replace(/\D/g, '').length < 9)) throw new AppError('กรุณาตรวจสอบเบอร์โทร');
  const line = text(f.lineId, 'LINE ID', 100);
  if (!phone && !line) throw new AppError('กรุณาใส่เบอร์โทร หรือ LINE ID อย่างน้อยหนึ่งช่อง เพื่อให้ร้านติดต่อกลับ');
  return { category: cat.id, details, name: text(f.name, 'ชื่อ', 200, { required: true }), phone, line };
}

export function describeRequest(category, d) {
  const cat = catalogById(category);
  const parts = [cat ? cat.name : category];
  if (d.width && d.height) parts.push(`${d.width}×${d.height} ${d.unit === 'm' ? 'ม.' : 'ซม.'}`);
  parts.push(`${d.qty} ชิ้น`);
  return parts.join(' ');
}

const ARTWORK = { have: 'มีไฟล์งานแล้ว', need_design: 'ให้ร้านออกแบบ', edit: 'มีแบบ ให้ร้านปรับแก้' };
const serialize = (r, files, origin, extra = {}) => {
  const d = JSON.parse(r.details_json);
  return {
    requestNo: r.request_no, status: r.status, category: r.category, categoryName: catalogById(r.category)?.name || r.category,
    summary: describeRequest(r.category, d), details: { ...d, artworkLabel: ARTWORK[d.artwork] },
    files: files.map(f => ({ id: f.id, name: f.file_name, mime: f.mime, size: f.size })),
    createdAt: r.created_at, cancelReason: r.cancel_reason, ...extra
  };
};

export async function createRequest(env, input, files, requestKey, origin) {
  const db = env.DB;
  const prev = await db.prepare('SELECT public_token,request_no FROM job_requests WHERE request_key=?').bind(requestKey).first();
  if (prev) return { created: false, requestNo: prev.request_no, trackUrl: requestUrl(origin, prev.public_token) };

  const now = nowIso(); const { compact, ymd } = bangkokDate();
  const { last_no } = await db.prepare('INSERT INTO request_counters(day,last_no) VALUES(?,1) ON CONFLICT(day) DO UPDATE SET last_no=last_no+1 RETURNING last_no').bind(compact).first();
  const requestNo = `REQ-${compact}-${String(last_no).padStart(4, '0')}`;
  const token = randomToken();

  // Files first (private R2); removed again if the database write fails.
  const stored = [];
  try {
    for (const f of files) {
      const key = `requests/${ymd.slice(0, 7).replace('-', '/')}/${requestNo}/${randomHex(8)}.${FILE_EXT[f.mime]}`;
      await env.SLIPS.put(key, f.bytes, { httpMetadata: { contentType: f.mime }, customMetadata: { requestNo } });
      stored.push({ ...f, key });
    }
    const stmts = [db.prepare(`INSERT INTO job_requests(request_no,public_token,request_key,category,details_json,customer_name,customer_phone,customer_line,created_at,updated_at)
      VALUES(?,?,?,?,?,?,?,?,?,?)`).bind(requestNo, token, requestKey, input.category, JSON.stringify(input.details), input.name, input.phone, input.line, now, now)];
    for (const f of stored) {
      stmts.push(db.prepare('INSERT INTO request_files(request_id,r2_key,file_name,mime,size,created_at) SELECT id,?,?,?,?,? FROM job_requests WHERE request_no=?')
        .bind(f.key, f.name, f.mime, f.bytes.length, now, requestNo));
    }
    await db.batch(stmts);
  } catch (e) {
    for (const f of stored) await env.SLIPS.delete(f.key).catch(() => {});
    const raced = await db.prepare('SELECT public_token,request_no FROM job_requests WHERE request_key=?').bind(requestKey).first();
    if (raced) return { created: false, requestNo: raced.request_no, trackUrl: requestUrl(origin, raced.public_token) };
    throw e;
  }
  return { created: true, requestNo, trackUrl: requestUrl(origin, token) };
}

// Customer tracking page: no phone/LINE shown back, files listed by name only.
export async function getPublicRequest(env, token, origin) {
  const db = env.DB;
  const r = await db.prepare('SELECT * FROM job_requests WHERE public_token=?').bind(token).first();
  if (!r) return null;
  const files = (await db.prepare('SELECT id,file_name,mime,size FROM request_files WHERE request_id=? ORDER BY id').bind(r.id).all()).results;
  let bill = null;
  if (r.order_id) {
    const o = await db.prepare('SELECT order_no,public_token,status,total_satang FROM orders WHERE id=?').bind(r.order_id).first();
    if (o) bill = { orderNo: o.order_no, status: o.status, totalSatang: o.total_satang, payUrl: payUrl(origin, o.public_token) };
  }
  const out = serialize(r, files, origin, { bill });
  out.files = out.files.map(({ name, mime }) => ({ name, mime }));
  return out;
}

export async function listRequests(env, { status, cursor, limit = 30 }) {
  const where = []; const params = [];
  if (status) {
    if (!['new', 'quoted', 'cancelled'].includes(status)) throw new AppError('สถานะไม่ถูกต้อง');
    where.push('status=?'); params.push(status);
  }
  if (cursor) { where.push('id<?'); params.push(cursor); }
  const { results } = await env.DB.prepare(`SELECT id,request_no,category,details_json,customer_name,customer_phone,status,created_at,
    (SELECT count(*) FROM request_files f WHERE f.request_id=job_requests.id) AS files
    FROM job_requests ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY id DESC LIMIT ?`).bind(...params, limit + 1).all();
  const page = results.slice(0, limit);
  return {
    requests: page.map(r => ({ requestNo: r.request_no, status: r.status, customerName: r.customer_name, customerPhone: r.customer_phone,
      summary: describeRequest(r.category, JSON.parse(r.details_json)), files: r.files, createdAt: r.created_at })),
    nextCursor: results.length > limit ? page.at(-1).id : null
  };
}

export async function getRequestDetail(env, requestNo, origin) {
  const db = env.DB;
  const r = await db.prepare('SELECT * FROM job_requests WHERE request_no=?').bind(requestNo).first();
  if (!r) throw new AppError('ไม่พบคำขอ', 404);
  const files = (await db.prepare('SELECT id,file_name,mime,size FROM request_files WHERE request_id=? ORDER BY id').bind(r.id).all()).results;
  const order = r.order_id ? await db.prepare('SELECT order_no,status,total_satang FROM orders WHERE id=?').bind(r.order_id).first() : null;
  return serialize(r, files, origin, {
    id: r.id, version: r.version, trackUrl: requestUrl(origin, r.public_token),
    customer: { name: r.customer_name, phone: r.customer_phone, lineId: r.customer_line },
    bill: order ? { orderNo: order.order_no, status: order.status, totalSatang: order.total_satang } : null
  });
}

export async function cancelRequest(env, requestNo, { version, reason }, origin) {
  const res = await env.DB.prepare("UPDATE job_requests SET status='cancelled', cancel_reason=?, version=version+1, updated_at=? WHERE request_no=? AND version=? AND status='new'")
    .bind(reason, nowIso(), requestNo, version).run();
  if (!res.meta.changes) {
    const r = await env.DB.prepare('SELECT status FROM job_requests WHERE request_no=?').bind(requestNo).first();
    if (!r) throw new AppError('ไม่พบคำขอ', 404);
    throw new AppError('คำขอนี้ถูกเสนอราคา ยกเลิก หรือแก้ไขไปแล้ว กรุณาโหลดข้อมูลใหม่', 409);
  }
  return getRequestDetail(env, requestNo, origin);
}

export async function getRequestFile(env, fileId) {
  const row = await env.DB.prepare('SELECT r2_key,file_name,mime FROM request_files WHERE id=?').bind(fileId).first();
  if (!row) throw new AppError('ไม่พบไฟล์', 404);
  const obj = await env.SLIPS.get(row.r2_key);
  if (!obj) throw new AppError('ไม่พบไฟล์', 404);
  const ascii = row.file_name.replace(/[^\x20-\x7E]/g, '_').replace(/["\\]/g, '_');
  return new Response(obj.body, { headers: {
    'Content-Type': row.mime,
    'Content-Disposition': `inline; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(row.file_name)}`
  } });
}

export const publicCatalog = () => CATALOG.map(({ id, name, hint, size, options, fileNote = '', sizes = [] }) => ({ id, name, hint, size, options, fileNote,
  sizes: sizes.map(([w, h, label]) => ({ width: w, height: h, label: `${label ? label + ' ' : ''}${w} × ${h} ซม.` })) }));
