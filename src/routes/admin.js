import { AppError, json, readJson } from '../lib/http.js';
import { login, logout, requireAdmin } from '../lib/auth.js';
import { validateNewOrder, validateOrderEdit, text } from '../lib/validate.js';
import { ORDER_NO_RE, changeStatus, createOrder, editOrder, getOrderDetail, listOrders, mapDbError, searchCustomers } from '../services/orders.js';

const IDEMPOTENCY_RE = /^[A-Za-z0-9-]{16,64}$/;

export async function handleAdmin(request, env, path) {
  const method = request.method;
  const origin = new URL(request.url).origin;
  if (path === '/api/admin/login' && method === 'POST') return login(request, env);

  await requireAdmin(request, env);
  if (path === '/api/admin/session' && method === 'GET') return json({ ok: true });
  if (path === '/api/admin/logout' && method === 'POST') return logout(request, env);

  if (path === '/api/admin/customers' && method === 'GET') {
    const q = text(new URL(request.url).searchParams.get('q') || '', 'คำค้นหา', 50);
    return json({ customers: await searchCustomers(env, q) });
  }

  if (path === '/api/admin/orders' && method === 'GET') {
    const sp = new URL(request.url).searchParams;
    const cursorRaw = sp.get('cursor');
    const cursor = cursorRaw ? Number(cursorRaw) : null;
    if (cursorRaw && (!Number.isSafeInteger(cursor) || cursor < 1)) throw new AppError('หน้ารายการไม่ถูกต้อง');
    return json(await listOrders(env, { status: sp.get('status') || null, q: text(sp.get('q') || '', 'คำค้นหา', 50), cursor }));
  }

  if (path === '/api/admin/orders' && method === 'POST') {
    const key = request.headers.get('Idempotency-Key');
    if (!IDEMPOTENCY_RE.test(key || '')) throw new AppError('รหัสคำขอไม่ถูกต้อง');
    const input = validateNewOrder(await readJson(request, 64 * 1024));
    try {
      const { created, order } = await createOrder(env, input, key, origin);
      return json({ order }, created ? 201 : 200);
    } catch (e) { throw mapDbError(e) || e; }
  }

  const m = path.match(/^\/api\/admin\/orders\/([^/]+)(\/status)?$/);
  if (m) {
    const orderNo = decodeURIComponent(m[1]);
    if (!ORDER_NO_RE.test(orderNo)) throw new AppError('ไม่พบออเดอร์', 404);
    if (!m[2] && method === 'GET') return json({ order: await getOrderDetail(env, orderNo, origin) });
    if (!m[2] && method === 'PATCH') return json({ order: await editOrder(env, orderNo, validateOrderEdit(await readJson(request, 64 * 1024)), origin) });
    if (m[2] && method === 'POST') {
      const body = await readJson(request);
      return json({ order: await changeStatus(env, orderNo, { to: body?.to, version: body?.version, note: text(body?.note, 'หมายเหตุ', 500) }, origin) });
    }
  }
  throw new AppError('ไม่พบ API หรือวิธีเรียกไม่ถูกต้อง', 404);
}
