import { AppError, MAX_SLIP, STATUSES, validateOrder, validPromptPay } from './shared.js';

const encoder = new TextEncoder();
const SESSION_SECONDS = 8 * 60 * 60;
const MAX_BODY = MAX_SLIP + 128 * 1024;
const json = (data, status = 200, headers = {}) => Response.json(data, { status, headers });
export async function digest(value) {
  const bytes = typeof value === 'string' ? encoder.encode(value) : value;
  return [...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))].map(b => b.toString(16).padStart(2,'0')).join('');
}
function shopConfig(env) {
  const ready = validPromptPay(env.PROMPTPAY_ID) && !!env.ACCOUNT_NAME?.trim();
  return { shopName: env.SHOP_NAME || 'อองตองมีเดีย', promptPayId: env.PROMPTPAY_ID || '', bankName: env.BANK_NAME || '', accountName: env.ACCOUNT_NAME || '', accountNo: env.ACCOUNT_NO || '', ready, statuses: STATUSES };
}
function sameOrigin(request) {
  if (request.headers.get('Origin') !== new URL(request.url).origin) throw new AppError('คำขอไม่ได้มาจากเว็บไซต์นี้', 403);
}
async function readBody(request, max) {
  if (Number(request.headers.get('content-length')) > max) throw new AppError('ข้อมูลมีขนาดใหญ่เกินกำหนด', 413);
  const reader = request.body?.getReader();
  if (!reader) throw new AppError('ไม่มีข้อมูล');
  const chunks = []; let length = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    length += value.length;
    if (length > max) { await reader.cancel(); throw new AppError('ข้อมูลมีขนาดใหญ่เกินกำหนด', 413); }
    chunks.push(value);
  }
  const bytes = new Uint8Array(length); let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
  return bytes;
}
async function readJson(request) {
  if (!request.headers.get('content-type')?.startsWith('application/json')) throw new AppError('รูปแบบข้อมูลไม่ถูกต้อง', 415);
  try { return JSON.parse(new TextDecoder().decode(await readBody(request, 16384))); }
  catch (e) { if (e instanceof AppError) throw e; throw new AppError('ข้อมูล JSON ไม่ถูกต้อง'); }
}
async function rateLimit(request, env, bucket, max, seconds) {
  const now = Math.floor(Date.now() / 1000);
  const ip = request.headers.get('CF-Connecting-IP') || 'local';
  const key = `${bucket}:${await digest(ip)}:${Math.floor(now / seconds)}`;
  const row = await env.DB.prepare('INSERT INTO rate_limits (key,count,expires_at) VALUES (?,1,?) ON CONFLICT(key) DO UPDATE SET count=count+1 RETURNING count')
    .bind(key, now + seconds).first();
  if (row.count > max) throw new AppError('ทำรายการบ่อยเกินไป กรุณารอสักครู่แล้วลองใหม่', 429);
}
function cookie(request, token, age = SESSION_SECONDS) {
  return `otm_session=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${age}${new URL(request.url).protocol === 'https:' ? '; Secure' : ''}`;
}
function sessionToken(request) { return request.headers.get('Cookie')?.match(/(?:^|;\s*)otm_session=([a-f0-9]{64})(?:;|$)/)?.[1]; }
function passwordReady(env) { return typeof env.ADMIN_PASSWORD === 'string' && env.ADMIN_PASSWORD.length >= 16 && env.ADMIN_PASSWORD.length <= 256; }
async function requireAdmin(request, env) {
  if (!passwordReady(env)) throw new AppError('ยังไม่ได้ตั้งค่าบัญชีผู้ดูแล', 503);
  const token = sessionToken(request);
  if (!token) throw new AppError('กรุณาเข้าสู่ระบบผู้ดูแล', 401);
  const session = await env.DB.prepare('SELECT token_hash FROM sessions WHERE token_hash=? AND expires_at>? AND password_version=?')
    .bind(await digest(token), Math.floor(Date.now() / 1000), await digest(env.ADMIN_PASSWORD)).first();
  if (!session) throw new AppError('หมดเวลาเข้าสู่ระบบ กรุณาเข้าสู่ระบบอีกครั้ง', 401);
}
async function login(request, env) {
  if (!passwordReady(env)) throw new AppError('ยังไม่ได้ตั้งค่าบัญชีผู้ดูแล', 503);
  await rateLimit(request, env, 'login', 5, 900);
  const body = await readJson(request);
  const supplied = typeof body?.password === 'string' ? body.password : '';
  // HMAC verify avoids data-dependent string comparison of the password.
  const key = await crypto.subtle.importKey('raw', encoder.encode(env.ADMIN_PASSWORD), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign','verify']);
  const signature = await crypto.subtle.sign('HMAC', key, encoder.encode(env.ADMIN_PASSWORD));
  if (!await crypto.subtle.verify('HMAC', key, signature, encoder.encode(supplied))) throw new AppError('รหัสผ่านไม่ถูกต้อง', 401);
  const token = [...crypto.getRandomValues(new Uint8Array(32))].map(b => b.toString(16).padStart(2,'0')).join('');
  const now = Math.floor(Date.now() / 1000);
  await env.DB.batch([
    env.DB.prepare('DELETE FROM sessions WHERE expires_at<=?').bind(now),
    env.DB.prepare('DELETE FROM rate_limits WHERE expires_at<=?').bind(now),
    env.DB.prepare('INSERT INTO sessions VALUES (?,?,?)').bind(await digest(token), now + SESSION_SECONDS, await digest(env.ADMIN_PASSWORD))
  ]);
  return json({ ok: true }, 200, { 'Set-Cookie': cookie(request, token) });
}
export function imageType(bytes) {
  if (bytes.length >= 24 && [137,80,78,71,13,10,26,10].every((b,i) => bytes[i] === b)) return 'image/png';
  if (bytes.length >= 4 && bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255) return 'image/jpeg';
  if (bytes.length >= 16 && new TextDecoder().decode(bytes.slice(0,4)) === 'RIFF' && new TextDecoder().decode(bytes.slice(8,12)) === 'WEBP') return 'image/webp';
  throw new AppError('รองรับสลิปเฉพาะภาพ PNG, JPG หรือ WEBP');
}
function orderResponse(row) { return { orderId: row.id, status: row.status, totalSatang: row.total_satang }; }
function replay(row, hash) {
  if (row.request_hash !== hash) throw new AppError('ข้อมูลเปลี่ยนระหว่างส่ง กรุณาเริ่มคำสั่งซื้อใหม่', 409);
  return json(orderResponse(row));
}
async function createOrder(request, env) {
  if (!shopConfig(env).ready) throw new AppError('ร้านยังไม่ได้ตั้งค่าข้อมูลรับชำระเงิน', 503);
  await rateLimit(request, env, 'order', 20, 600);
  const requestKey = request.headers.get('Idempotency-Key');
  if (!/^[a-f0-9-]{36}$/i.test(requestKey || '')) throw new AppError('รหัสคำขอไม่ถูกต้อง');
  const type = request.headers.get('content-type') || '';
  if (!type.startsWith('multipart/form-data;')) throw new AppError('รูปแบบข้อมูลไม่ถูกต้อง', 415);
  let form;
  try { form = await new Response(await readBody(request, MAX_BODY), { headers: { 'Content-Type': type } }).formData(); }
  catch(e) { if (e instanceof AppError) throw e; throw new AppError('ข้อมูลแบบฟอร์มไม่ถูกต้อง'); }
  let payload;
  try { payload = JSON.parse(form.get('order')); } catch { throw new AppError('ข้อมูลคำสั่งซื้อไม่ถูกต้อง'); }
  const order = validateOrder(payload);
  const file = form.get('slip'); let bytes = null; let mime = null;
  if (file !== null) {
    if (typeof file === 'string' || !file.size || file.size > MAX_SLIP) throw new AppError('ไฟล์สลิปต้องเป็นรูปภาพขนาดไม่เกิน 8 MB');
    bytes = new Uint8Array(await file.arrayBuffer()); mime = imageType(bytes);
    if (file.type !== mime) throw new AppError('ชนิดไฟล์สลิปไม่ตรงกับข้อมูลภาพ');
  }
  const hash = await digest(JSON.stringify(order) + (bytes ? await digest(bytes) : ''));
  const find = () => env.DB.prepare('SELECT * FROM orders WHERE request_key=?').bind(requestKey).first();
  const previous = await find();
  if (previous) return replay(previous, hash);
  const id = `OTM-${crypto.randomUUID()}`;
  const slipKey = bytes ? `slips/${id}` : null;
  const status = bytes ? STATUSES[1] : STATUSES[0];
  if (bytes) await env.SLIPS.put(slipKey, bytes, { httpMetadata: { contentType: mime } });
  try {
    await env.DB.prepare(`INSERT INTO orders (id,request_key,request_hash,created_at,customer,phone,contact,items_json,subtotal_satang,shipping_satang,total_satang,note,slip_key,status) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
      .bind(id, requestKey, hash, new Date().toISOString(), order.customer, order.phone, order.contact, JSON.stringify(order.items), order.subtotal, order.shipping, order.total, order.note, slipKey, status).run();
  } catch (error) {
    // Resolve a concurrent duplicate or ambiguous DB response before deleting any slip.
    const saved = await find();
    if (slipKey && saved?.id !== id) await env.SLIPS.delete(slipKey);
    if (saved) return replay(saved, hash);
    throw error;
  }
  return json({ orderId: id, status, totalSatang: order.total }, 201);
}
async function listOrders(request, env) {
  const url = new URL(request.url);
  const cursor = url.searchParams.get('cursor');
  let statement;
  if (cursor) {
    let parts;
    try { parts = JSON.parse(cursor); } catch { throw new AppError('หน้ารายการไม่ถูกต้อง'); }
    if (!Array.isArray(parts) || parts.length !== 2 || parts.some(p => typeof p !== 'string' || p.length > 80)) throw new AppError('หน้ารายการไม่ถูกต้อง');
    statement = env.DB.prepare('SELECT * FROM orders WHERE (created_at,id)<(?,?) ORDER BY created_at DESC,id DESC LIMIT 31').bind(...parts);
  } else statement = env.DB.prepare('SELECT * FROM orders ORDER BY created_at DESC,id DESC LIMIT 31');
  const { results } = await statement.all();
  const page = results.slice(0,30); const last = page.at(-1);
  return json({ orders: page.map(({request_key,request_hash,slip_key,items_json,...row}) => ({...row, items: JSON.parse(items_json), hasSlip: !!slip_key})), nextCursor: results.length > 30 ? JSON.stringify([last.created_at,last.id]) : null });
}
async function route(request, env) {
  const url = new URL(request.url); const path = url.pathname;
  if (path.startsWith('/api/') && !['GET','HEAD'].includes(request.method)) sameOrigin(request);
  if (path === '/api/health' && request.method === 'GET') {
    await env.DB.prepare('SELECT 1 FROM orders LIMIT 1').first();
    return json({ ok: true, paymentsConfigured: shopConfig(env).ready });
  }
  if (path === '/api/config' && request.method === 'GET') return json(shopConfig(env));
  if (path === '/api/orders' && request.method === 'POST') return createOrder(request, env);
  if (path === '/api/admin/login' && request.method === 'POST') return login(request, env);
  if (path.startsWith('/api/admin/')) {
    await requireAdmin(request, env);
    if (path === '/api/admin/session' && request.method === 'GET') return json({ ok: true });
    if (path === '/api/admin/logout' && request.method === 'POST') {
      await env.DB.prepare('DELETE FROM sessions WHERE token_hash=?').bind(await digest(sessionToken(request))).run();
      return json({ ok: true }, 200, { 'Set-Cookie': cookie(request, '', 0) });
    }
    if (path === '/api/admin/orders' && request.method === 'GET') return listOrders(request, env);
    const match = path.match(/^\/api\/admin\/orders\/(OTM-[a-f0-9-]{36})\/(status|slip)$/);
    if (match && match[2] === 'status' && request.method === 'PATCH') {
      const body = await readJson(request);
      if (!STATUSES.includes(body?.status) || !Number.isInteger(body?.version)) throw new AppError('สถานะไม่ถูกต้อง');
      const result = await env.DB.prepare('UPDATE orders SET status=?,version=version+1 WHERE id=? AND version=? RETURNING status,version').bind(body.status, match[1], body.version).first();
      if (!result) throw new AppError('รายการถูกแก้ไขแล้ว กรุณาโหลดรายการใหม่', 409);
      return json(result);
    }
    if (match && match[2] === 'slip' && request.method === 'GET') {
      const row = await env.DB.prepare('SELECT slip_key FROM orders WHERE id=?').bind(match[1]).first();
      if (!row?.slip_key) throw new AppError('ไม่พบสลิป', 404);
      const object = await env.SLIPS.get(row.slip_key);
      if (!object) throw new AppError('ไม่พบไฟล์สลิป', 404);
      return new Response(object.body, { headers: { 'Content-Type': object.httpMetadata?.contentType || 'application/octet-stream', 'Content-Disposition': `inline; filename="${match[1]}.image"` } });
    }
  }
  if (path.startsWith('/api/')) throw new AppError('ไม่พบ API หรือวิธีเรียกไม่ถูกต้อง', 404);
  if (!['GET','HEAD'].includes(request.method)) throw new AppError('ไม่รองรับคำขอนี้', 405);
  return env.ASSETS.fetch(request);
}
export default {
  async fetch(request, env) {
    let response;
    try { response = await route(request, env); }
    catch (e) {
      if (!(e instanceof AppError)) console.error('Request failed', e.name);
      response = json({ error: e instanceof AppError ? e.message : 'ระบบขัดข้องชั่วคราว กรุณาลองใหม่อีกครั้ง' }, e instanceof AppError ? e.status : 500);
    }
    const result = new Response(response.body, response);
    result.headers.set('X-Content-Type-Options','nosniff');
    result.headers.set('Referrer-Policy','same-origin');
    result.headers.set('X-Frame-Options','DENY');
    result.headers.set('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'");
    if (new URL(request.url).pathname.startsWith('/api/')) result.headers.set('Cache-Control','no-store');
    return result;
  }
};
