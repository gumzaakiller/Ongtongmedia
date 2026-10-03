import { AppError, json, readJson } from '../lib/http.js';
import { login, logout, requireAdmin } from '../lib/auth.js';
import { validateNewOrder, validateOrderEdit, text } from '../lib/validate.js';
import { ORDER_NO_RE, changeStatus, createOrder, editOrder, getOrderDetail, listOrders, mapDbError, searchCustomers } from '../services/orders.js';
import { getSlip, recordManualPayment, rejectPayment, verifyPayment } from '../services/payments.js';
import { dashboard, incomeCsv, listIncome, parseIncomeFilters } from '../services/reports.js';
import { bangkokDate } from '../lib/time.js';

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

  if (path === '/api/admin/dashboard' && method === 'GET') return json(await dashboard(env));

  if ((path === '/api/admin/income' || path === '/api/admin/income.csv') && method === 'GET') {
    const sp = new URL(request.url).searchParams;
    const filters = parseIncomeFilters(sp);
    if (path.endsWith('.csv')) {
      const name = `income-${filters.from || 'all'}${filters.to ? '_' + filters.to : ''}.csv`;
      return new Response(await incomeCsv(env, filters), { headers: { 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': `attachment; filename="${name}"` } });
    }
    return json(await listIncome(env, filters, { cursor: sp.get('cursor') }));
  }

  const pm = path.match(/^\/api\/admin\/payments\/(\d{1,12})\/(verify|reject|slip)$/);
  if (pm) {
    const id = Number(pm[1]);
    if (pm[2] === 'slip' && method === 'GET') return getSlip(env, id);
    if (pm[2] !== 'slip' && method === 'POST') {
      const body = await readJson(request);
      if (!Number.isInteger(body?.version)) throw new AppError('ข้อมูลไม่ถูกต้อง');
      if (pm[2] === 'verify') return json({ order: await verifyPayment(env, id, { version: body.version }, origin) });
      const reason = text(body?.reason, 'เหตุผล', 300, { required: true });
      return json({ order: await rejectPayment(env, id, { version: body.version, reason }, origin) });
    }
  }

  const om = path.match(/^\/api\/admin\/orders\/([^/]+)\/payments$/);
  if (om && method === 'POST') {
    const orderNo = decodeURIComponent(om[1]);
    if (!ORDER_NO_RE.test(orderNo)) throw new AppError('ไม่พบออเดอร์', 404);
    const body = await readJson(request);
    return json({ order: await recordManualPayment(env, orderNo, {
      version: body?.version, method: body?.method, receivedDate: body?.receivedDate || bangkokDate().ymd, note: text(body?.note, 'หมายเหตุ', 300)
    }, origin) });
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
