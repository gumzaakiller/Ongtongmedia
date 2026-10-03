import { AppError, json, readBody, readJson } from '../lib/http.js';
import { MAX_SLIP_BYTES } from '../lib/image.js';
import { addGalleryItem, deleteGalleryItem } from '../services/gallery.js';
import { addExpense, deleteExpense, profitSummary, validateExpense } from '../services/accounts.js';
import { login, logout, requireAdmin } from '../lib/auth.js';
import { validateNewOrder, validateOrderEdit, text } from '../lib/validate.js';
import { ORDER_NO_RE, changeStatus, createOrder, editOrder, getOrderDetail, listOrders, mapDbError, searchCustomers } from '../services/orders.js';
import { getSlip, recordManualPayment, rejectPayment, verifyPayment } from '../services/payments.js';
import { dashboard, incomeCsv, listIncome, parseIncomeFilters } from '../services/reports.js';
import { bangkokDate } from '../lib/time.js';
import { REQUEST_NO_RE, cancelRequest, getRequestDetail, getRequestFile, listRequests } from '../services/requests.js';

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

  if (path === '/api/admin/requests' && method === 'GET') {
    const sp = new URL(request.url).searchParams;
    const cursorRaw = sp.get('cursor'); const cursor = cursorRaw ? Number(cursorRaw) : null;
    if (cursorRaw && (!Number.isSafeInteger(cursor) || cursor < 1)) throw new AppError('หน้ารายการไม่ถูกต้อง');
    return json(await listRequests(env, { status: sp.get('status') || null, cursor }));
  }
  const fm = path.match(/^\/api\/admin\/request-files\/(\d{1,12})$/);
  if (fm && method === 'GET') return getRequestFile(env, Number(fm[1]));
  const rm = path.match(/^\/api\/admin\/requests\/([^/]+)(\/quote|\/cancel)?$/);
  if (rm) {
    const requestNo = decodeURIComponent(rm[1]);
    if (!REQUEST_NO_RE.test(requestNo)) throw new AppError('ไม่พบคำขอ', 404);
    if (!rm[2] && method === 'GET') return json({ request: await getRequestDetail(env, requestNo, origin) });
    if (rm[2] === '/cancel' && method === 'POST') {
      const body = await readJson(request);
      if (!Number.isInteger(body?.version)) throw new AppError('ข้อมูลไม่ถูกต้อง');
      return json({ request: await cancelRequest(env, requestNo, { version: body.version, reason: text(body?.reason, 'เหตุผล', 300) }, origin) });
    }
    if (rm[2] === '/quote' && method === 'POST') {
      // Quote = create the bill (same validation as a normal bill) and link it to the request in one transaction.
      const key = request.headers.get('Idempotency-Key');
      if (!IDEMPOTENCY_RE.test(key || '')) throw new AppError('รหัสคำขอไม่ถูกต้อง');
      const body = await readJson(request, 64 * 1024);
      if (!Number.isInteger(body?.requestVersion)) throw new AppError('ข้อมูลไม่ถูกต้อง');
      const r = await env.DB.prepare('SELECT id,request_no FROM job_requests WHERE request_no=?').bind(requestNo).first();
      if (!r) throw new AppError('ไม่พบคำขอ', 404);
      const input = validateNewOrder(body);
      try {
        const { created, order } = await createOrder(env, input, key, origin, { id: r.id, version: body.requestVersion, requestNo: r.request_no });
        return json({ order }, created ? 201 : 200);
      } catch (e) { throw mapDbError(e) || e; }
    }
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

  if (path === '/api/admin/summary' && method === 'GET') {
    const sp = new URL(request.url).searchParams;
    return json(await profitSummary(env, sp.get('view') || 'day', sp.get('period') || ''));
  }
  if (path === '/api/admin/expenses' && method === 'POST') return json({ expense: await addExpense(env, validateExpense(await readJson(request))) }, 201);
  const em = path.match(/^\/api\/admin\/expenses\/(\d{1,9})$/);
  if (em && method === 'DELETE') return json(await deleteExpense(env, Number(em[1])));

  if (path === '/api/admin/gallery' && method === 'POST') {
    const type = request.headers.get('content-type') || '';
    if (!type.startsWith('multipart/form-data')) throw new AppError('รูปแบบข้อมูลไม่ถูกต้อง', 415);
    let form;
    try { form = await new Response(await readBody(request, MAX_SLIP_BYTES + 64 * 1024), { headers: { 'Content-Type': type } }).formData(); }
    catch (e) { if (e instanceof AppError) throw e; throw new AppError('ข้อมูลที่ส่งมาไม่ถูกต้อง'); }
    return json({ item: await addGalleryItem(env, form) }, 201);
  }
  const gm = path.match(/^\/api\/admin\/gallery\/(\d{1,9})$/);
  if (gm && method === 'DELETE') return json(await deleteGalleryItem(env, Number(gm[1])));

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
