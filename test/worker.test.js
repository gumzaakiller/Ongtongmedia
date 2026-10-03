import { test } from 'node:test';
import assert from 'node:assert/strict';
import worker from '../src/index.js';
import { makeEnv } from './helpers/fake-d1.js';

const ORIGIN = 'https://shop.test';
const PASSWORD = 'local-test-password-only-1234';

function client(env) {
  let cookie = '';
  const call = async (path, { method = 'GET', body, headers = {}, origin = ORIGIN, ip = '1.1.1.1' } = {}) => {
    const init = { method, headers: { Origin: origin, 'CF-Connecting-IP': ip, ...(cookie ? { Cookie: cookie } : {}), ...headers } };
    if (body !== undefined) { init.body = JSON.stringify(body); init.headers['Content-Type'] = 'application/json'; }
    const res = await worker.fetch(new Request(ORIGIN + path, init), env);
    const setCookie = res.headers.get('Set-Cookie');
    if (setCookie) cookie = setCookie.split(';')[0].endsWith('=') ? '' : setCookie.split(';')[0];
    const type = res.headers.get('Content-Type') || '';
    return { status: res.status, headers: res.headers, data: type.includes('json') ? await res.json() : await res.text(), setCookie };
  };
  return { call, login: () => call('/api/admin/login', { method: 'POST', body: { password: PASSWORD } }), clearCookie: () => { cookie = ''; } };
}

const newOrder = (extra = {}) => ({
  customer: { name: 'คุณสมชาย', phone: '0898765432', lineId: 'somchai' },
  title: 'งานพิมพ์ป้าย', note: 'รับของที่ร้าน', internalNote: 'ลูกค้าประจำ ให้ส่วนลด',
  items: [{ description: 'ไวนิล 2x1 ม.', qty: 2, unitPrice: '350' }, { description: 'ค่าออกแบบ', qty: 1, unitPrice: '200.50' }],
  discount: '50', total: 1, ...extra
});
const create = (c, body = newOrder(), key = crypto.randomUUID()) => c.call('/api/admin/orders', { method: 'POST', body, headers: { 'Idempotency-Key': key } });

test('auth and request safety', async t => {
  const env = makeEnv(); const c = client(env);
  await t.test('admin API needs a session', async () => {
    for (const path of ['/api/admin/orders', '/api/admin/customers', '/api/admin/orders/ONT-20261003-0001']) assert.equal((await c.call(path)).status, 401, path);
    assert.equal((await create(c)).status, 401);
  });
  await t.test('cross-site writes are refused', async () => {
    assert.equal((await c.call('/api/admin/login', { method: 'POST', body: { password: PASSWORD }, origin: 'https://evil.test' })).status, 403);
  });
  await t.test('wrong password refused, right one issues a hardened cookie', async () => {
    assert.equal((await c.call('/api/admin/login', { method: 'POST', body: { password: 'nope' }, ip: '9.9.9.9' })).status, 401);
    const ok = await c.login();
    assert.equal(ok.status, 200);
    for (const flag of [/HttpOnly/, /Secure/, /SameSite=Strict/]) assert.match(ok.setCookie, flag);
    assert.equal((await c.call('/api/admin/session')).status, 200);
  });
  await t.test('logout revokes the session', async () => {
    assert.equal((await c.call('/api/admin/logout', { method: 'POST' })).status, 200);
    assert.equal((await c.call('/api/admin/session')).status, 401);
  });
  await t.test('changing the admin password invalidates old sessions', async () => {
    await c.login();
    env.ADMIN_PASSWORD = 'a-brand-new-password-5678';
    assert.equal((await c.call('/api/admin/session')).status, 401);
    env.ADMIN_PASSWORD = PASSWORD;
  });
  await t.test('login guessing is rate limited', async () => {
    for (let i = 0; i < 5; i++) await c.call('/api/admin/login', { method: 'POST', body: { password: 'x' }, ip: '7.7.7.7' });
    assert.equal((await c.call('/api/admin/login', { method: 'POST', body: { password: 'x' }, ip: '7.7.7.7' })).status, 429);
  });
  await t.test('missing admin password fails closed', async () => {
    const env2 = makeEnv({ ADMIN_PASSWORD: '' });
    assert.equal((await client(env2).call('/api/admin/orders')).status, 503);
  });
});

test('admin creates and manages orders', async t => {
  const env = makeEnv(); const c = client(env); await c.login();
  let first;
  await t.test('create: order number, pay link, totals from the server', async () => {
    const r = await create(c);
    assert.equal(r.status, 201, JSON.stringify(r.data));
    first = r.data.order;
    assert.match(first.orderNo, /^ONT-\d{8}-0001$/);
    assert.match(first.payUrl, /^https:\/\/shop\.test\/pay\/[A-Za-z0-9_-]{43}$/);
    assert.deepEqual([first.subtotalSatang, first.discountSatang, first.totalSatang], [90050, 5000, 85050]);
    assert.equal(first.status, 'pending'); assert.equal(first.version, 1);
    assert.equal(first.items.length, 2); assert.equal(first.events[0].to, 'pending');
    assert.equal((await create(c)).data.order.orderNo.slice(-4), '0002');
  });
  await t.test('same Idempotency-Key returns the same order, also when sent concurrently', async () => {
    const key = crypto.randomUUID();
    const a = await create(c, newOrder(), key); const b = await create(c, newOrder(), key);
    assert.equal(a.status, 201); assert.equal(b.status, 200); assert.equal(a.data.order.orderNo, b.data.order.orderNo);
    const key2 = crypto.randomUUID();
    const both = await Promise.all([create(c, newOrder(), key2), create(c, newOrder(), key2)]);
    assert.equal(new Set(both.map(r => r.data.order.orderNo)).size, 1);
    assert.equal((await env.DB.prepare('SELECT count(*) n FROM orders WHERE request_key=?').bind(key2).first()).n, 1);
  });
  await t.test('existing customer can be reused; unknown customer is 404', async () => {
    const r = await create(c, newOrder({ customer: { id: first.customer.id } }));
    assert.equal(r.status, 201); assert.equal(r.data.order.customer.name, 'คุณสมชาย');
    assert.equal((await create(c, newOrder({ customer: { id: 9999 } }))).status, 404);
    const found = await c.call('/api/admin/customers?q=' + encodeURIComponent('สมชาย'));
    assert.ok(found.data.customers.length >= 1);
  });
  await t.test('invalid orders are rejected with 400', async () => {
    assert.equal((await create(c, newOrder({ items: [{ description: 'x', qty: 1, unitPrice: '-5' }] }))).status, 400);
    assert.equal((await create(c, newOrder({ discount: '9999' }))).status, 400);
    assert.equal((await c.call('/api/admin/orders', { method: 'POST', body: newOrder() })).status, 400); // no Idempotency-Key
  });
  await t.test('list, search, filter and paginate', async () => {
    const all = await c.call('/api/admin/orders');
    assert.ok(all.data.orders.length >= 5);
    assert.equal((await c.call('/api/admin/orders?q=' + first.orderNo)).data.orders.length, 1);
    assert.ok((await c.call('/api/admin/orders?q=0898765432')).data.orders.length >= 5);
    assert.equal((await c.call('/api/admin/orders?status=paid')).data.orders.length, 0);
    assert.equal((await c.call('/api/admin/orders?status=bogus')).status, 400);
    for (let i = 0; i < 31; i++) await create(c);
    const p1 = await c.call('/api/admin/orders'); assert.equal(p1.data.orders.length, 30); assert.ok(p1.data.nextCursor);
    const p2 = await c.call('/api/admin/orders?cursor=' + p1.data.nextCursor);
    const ids = [...p1.data.orders, ...p2.data.orders].map(o => o.orderNo);
    assert.equal(new Set(ids).size, ids.length);
    assert.equal(ids.length, (await env.DB.prepare('SELECT count(*) n FROM orders').first()).n);
  });
  await t.test('detail; unknown or malformed order numbers are 404', async () => {
    assert.equal((await c.call('/api/admin/orders/' + first.orderNo)).data.order.internalNote, 'ลูกค้าประจำ ให้ส่วนลด');
    assert.equal((await c.call('/api/admin/orders/ONT-19990101-0001')).status, 404);
    assert.equal((await c.call('/api/admin/orders/1%20OR%201=1')).status, 404);
  });
  await t.test('edit recomputes totals; stale versions are rejected without partial changes', async () => {
    const r = await c.call('/api/admin/orders/' + first.orderNo, { method: 'PATCH', body: { version: 1, title: 'แก้ชื่องาน', items: [{ description: 'สติ๊กเกอร์', qty: 10, unitPrice: '15' }], discount: '0' } });
    assert.equal(r.status, 200, JSON.stringify(r.data));
    assert.deepEqual([r.data.order.totalSatang, r.data.order.items.length, r.data.order.version], [15000, 1, 2]);
    const stale = await c.call('/api/admin/orders/' + first.orderNo, { method: 'PATCH', body: { version: 1, items: [{ description: 'x', qty: 1, unitPrice: '1' }] } });
    assert.equal(stale.status, 409);
    const after = (await c.call('/api/admin/orders/' + first.orderNo)).data.order;
    assert.deepEqual([after.totalSatang, after.items[0].description, after.version], [15000, 'สติ๊กเกอร์', 2]);
  });
  await t.test('amount is locked once a slip exists (DB trigger), title still editable', async () => {
    const o = (await create(c)).data.order;
    await env.DB.prepare("INSERT INTO payments(order_id,request_key,amount_satang,submitted_at) SELECT id,'pk1',total_satang,'t' FROM orders WHERE order_no=?").bind(o.orderNo).run();
    const r = await c.call('/api/admin/orders/' + o.orderNo, { method: 'PATCH', body: { version: 1, items: [{ description: 'x', qty: 1, unitPrice: '1' }] } });
    assert.equal(r.status, 409); assert.match(r.data.error, /แก้ยอดเงินไม่ได้/);
    assert.equal((await c.call('/api/admin/orders/' + o.orderNo, { method: 'PATCH', body: { version: 1, title: 'ชื่อใหม่' } })).status, 200);
  });
  await t.test('status rules: only allowed manual transitions', async () => {
    const o = (await create(c)).data.order;
    const status = (to, version) => c.call(`/api/admin/orders/${o.orderNo}/status`, { method: 'POST', body: { to, version } });
    assert.equal((await status('paid', 1)).status, 409);         // only via payment verification
    assert.equal((await status('completed', 1)).status, 409);
    assert.equal((await status('cancelled', 9)).status, 409);    // stale version
    const ok = await status('cancelled', 1);
    assert.equal(ok.status, 200); assert.equal(ok.data.order.status, 'cancelled'); assert.ok(ok.data.order.cancelledAt);
    assert.deepEqual(ok.data.order.events.map(e => e.to), ['pending', 'cancelled']);
    assert.equal((await status('pending', 2)).status, 409);       // cancelled is final
    assert.equal((await c.call('/api/admin/orders/' + o.orderNo, { method: 'PATCH', body: { version: 2, title: 'x' } })).status, 409);
  });
});

test('customer pay link', async t => {
  const env = makeEnv(); const c = client(env); await c.login();
  const order = (await create(c)).data.order;
  const token = order.payUrl.split('/pay/')[1];
  c.clearCookie();
  await t.test('shows only this order, without internal or personal data', async () => {
    const r = await c.call('/api/pay/' + token);
    assert.equal(r.status, 200);
    const text = JSON.stringify(r.data);
    assert.equal(r.data.order.orderNo, order.orderNo);
    assert.equal(r.data.order.totalSatang, 85050);
    for (const secret of ['ลูกค้าประจำ', '0898765432', 'somchai', 'customer', 'public_token', 'internal']) assert.ok(!text.includes(secret), secret);
    assert.equal(r.data.qrImageUrl, `/api/pay/${token}/qr.png`);
    assert.equal(r.data.shop.lineOaId, '@653ercqc');
    assert.equal(r.headers.get('X-Robots-Tag'), 'noindex, nofollow');
    assert.equal(r.headers.get('Cache-Control'), 'no-store');
  });
  await t.test('QR payload amount comes from D1', async () => {
    const r = await c.call('/api/pay/' + token);
    assert.ok(r.data.promptPayPayload.includes('5406850.50'));
    assert.equal(r.data.canSubmitSlip, true);
  });
  await t.test('QR image is a PNG for the D1 amount', async () => {
    const r = await worker.fetch(new Request(`${ORIGIN}/api/pay/${token}/qr.png`, { headers: { 'CF-Connecting-IP': '2.2.2.2' } }), env);
    assert.equal(r.status, 200); assert.equal(r.headers.get('Content-Type'), 'image/png');
    assert.equal(r.headers.get('Cache-Control'), 'no-store');
    const bytes = new Uint8Array(await r.arrayBuffer());
    assert.deepEqual([...bytes.slice(0, 8)], [137, 80, 78, 71, 13, 10, 26, 10]);
    assert.equal((await c.call('/api/pay/' + 'C'.repeat(43) + '/qr.png')).status, 404);
  });
  await t.test('wrong or malformed tokens get the same 404', async () => {
    const wrong = await c.call('/api/pay/' + 'A'.repeat(43));
    const malformed = await c.call('/api/pay/' + order.orderNo);
    assert.equal(wrong.status, 404); assert.equal(malformed.status, 404);
    assert.equal(wrong.data.error, malformed.data.error);
  });
  await t.test('a cancelled order shows no QR', async () => {
    await c.login();
    await c.call(`/api/admin/orders/${order.orderNo}/status`, { method: 'POST', body: { to: 'cancelled', version: 1 } });
    const r = await c.call('/api/pay/' + token);
    assert.equal(r.data.order.status, 'cancelled'); assert.equal(r.data.promptPayPayload, null); assert.equal(r.data.canSubmitSlip, false);
    assert.equal(r.data.qrImageUrl, null);
    assert.equal((await c.call('/api/pay/' + token + '/qr.png')).status, 409);
  });
  await t.test('link guessing is rate limited per IP', async () => {
    let last;
    for (let i = 0; i < 121; i++) last = await c.call('/api/pay/' + 'B'.repeat(43), { ip: '5.5.5.5' });
    assert.equal(last.status, 429);
  });
  await t.test('/pay/<token> serves the pay page without redirecting away from the token', async () => {
    const r = await c.call('/pay/' + token);
    assert.equal(r.status, 200); assert.equal(r.data, 'asset:/pay');
    assert.equal(r.headers.get('X-Robots-Tag'), 'noindex, nofollow');
  });
  await t.test('health and public config', async () => {
    assert.deepEqual((await c.call('/api/health')).data, { ok: true, paymentsConfigured: true, env: 'test' });
    assert.deepEqual(Object.keys((await c.call('/api/config')).data).sort(), ['env', 'lineOaId', 'shopName']);
  });
});
