import { test } from 'node:test';
import assert from 'node:assert/strict';
import worker from '../src/index.js';
import { makeEnv } from './helpers/fake-d1.js';
import { promptPayPayload, crc16 } from '../src/lib/promptpay.js';

const ORIGIN = 'https://shop.test';
const PASSWORD = 'local-test-password-only-1234';
const png = tag => new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 13, 73, 72, 68, 82, ...new TextEncoder().encode(`img-${tag}-padding-bytes`)]);

function setup() {
  const env = makeEnv(); let cookie = '';
  const fetchW = (path, init = {}) => worker.fetch(new Request(ORIGIN + path, { ...init, headers: { Origin: ORIGIN, 'CF-Connecting-IP': init.ip || '9.9.9.9', ...(cookie ? { Cookie: cookie } : {}), ...(init.headers || {}) } }), env)
    .then(r => { const sc = r.headers.get('Set-Cookie'); if (sc) cookie = sc.split(';')[0]; return r; });
  const multipart = async (path, fields, headers = {}, ip) => {
    const form = new FormData();
    for (const [k, v] of Object.entries(fields)) form.set(k, v instanceof Uint8Array ? new Blob([v], { type: 'image/png' }) : v, ...(v instanceof Uint8Array ? ['x.png'] : []));
    const enc = new Request(ORIGIN, { method: 'POST', body: form });
    const r = await fetchW(path, { method: 'POST', body: await enc.arrayBuffer(), ip, headers: { 'Content-Type': enc.headers.get('Content-Type'), ...headers } });
    return { status: r.status, data: await r.json() };
  };
  const login = () => fetchW('/api/admin/login', { method: 'POST', body: JSON.stringify({ password: PASSWORD }), headers: { 'Content-Type': 'application/json' } });
  const getJson = async p => { const r = await fetchW(p); return { status: r.status, data: await r.json() }; };
  return { env, fetchW, multipart, login, getJson };
}

test('PromptPay QR without an amount is a static QR', () => {
  const p = promptPayPayload('0882965924', null);
  assert.ok(p.startsWith('000201010211'));
  assert.ok(!p.includes('5406') && !/54\d\d\d/.test(p.slice(0, p.indexOf('5802'))));
  assert.equal(p.slice(-4), crc16(p.slice(0, -4)));
});

test('walk-in transfer: slip becomes a bill waiting for verification', async t => {
  const s = setup();
  await t.test('info and QR', async () => {
    const info = await s.getJson('/api/transfer');
    assert.equal(info.status, 200); assert.ok(info.data.shop.accountName !== undefined);
    const qr = await s.fetchW('/api/transfer/qr.png?amount=850.50');
    assert.equal(qr.status, 200); assert.equal(qr.headers.get('Content-Type'), 'image/png');
    assert.equal((await s.fetchW('/api/transfer/qr.png')).status, 200);
    assert.equal((await s.fetchW('/api/transfer/qr.png?amount=-5')).status, 400);
  });
  const key = crypto.randomUUID();
  let payUrl;
  await t.test('submit creates order + submitted payment with the slip', async () => {
    const r = await s.multipart('/api/transfer', { name: 'คุณเอ', phone: '0812345678', amount: '1,250.50', ref: 'ป้ายร้าน', note: 'มัดจำ', slip: png('t1') }, { 'Idempotency-Key': key });
    assert.equal(r.status, 201, JSON.stringify(r.data));
    assert.match(r.data.orderNo, /^ONT-\d{8}-\d{4}$/); payUrl = r.data.payUrl;
    await s.login();
    const d = (await s.getJson('/api/admin/orders/' + r.data.orderNo)).data.order;
    assert.equal(d.status, 'awaiting_verification');
    assert.equal(d.totalSatang, 125050);
    assert.equal(d.title, 'แจ้งโอน: ป้ายร้าน');
    assert.match(d.internalNote, /ลูกค้ากรอกยอดเอง/);
    assert.deepEqual([d.payments[0].hasSlip, d.payments[0].customerNote, d.payments[0].amountSatang], [true, 'มัดจำ', 125050]);
  });
  await t.test('retry with the same key returns the same bill', async () => {
    const r = await s.multipart('/api/transfer', { name: 'คุณเอ', phone: '0812345678', amount: '1250.50', ref: 'ป้ายร้าน', note: 'มัดจำ', slip: png('t1') }, { 'Idempotency-Key': key });
    assert.equal(r.status, 201); assert.equal(r.data.payUrl, payUrl);
    assert.equal((await s.env.DB.prepare('SELECT count(*) n FROM orders').first()).n, 1);
    assert.equal((await s.env.DB.prepare('SELECT count(*) n FROM payments').first()).n, 1);
  });
  await t.test('validation', async () => {
    const base = { name: 'คุณบี', phone: '0812345678', amount: '100', slip: png('t2') };
    assert.equal((await s.multipart('/api/transfer', { ...base, amount: '' }, { 'Idempotency-Key': crypto.randomUUID() }, '8.8.8.1')).status, 400);
    assert.equal((await s.multipart('/api/transfer', { ...base, name: '' }, { 'Idempotency-Key': crypto.randomUUID() }, '8.8.8.1')).status, 400);
    const { slip, ...noSlip } = base;
    assert.equal((await s.multipart('/api/transfer', noSlip, { 'Idempotency-Key': crypto.randomUUID() }, '8.8.8.1')).status, 400);
    assert.equal((await s.env.DB.prepare('SELECT count(*) n FROM orders').first()).n, 1, 'no bills from rejected input');
  });
});

test('gallery: admin uploads, public lists and serves, admin deletes', async t => {
  const s = setup();
  await t.test('admin only', async () => {
    assert.equal((await s.multipart('/api/admin/gallery', { category: 'vinyl', title: 'x', image: png('g') })).status, 401);
  });
  await s.login();
  let id;
  await t.test('upload', async () => {
    const r = await s.multipart('/api/admin/gallery', { category: 'vinyl', title: 'ป้ายร้านกาแฟ', caption: '3x1 ม.', image: png('g1') });
    assert.equal(r.status, 201, JSON.stringify(r.data)); id = r.data.item.id;
    assert.equal((await s.multipart('/api/admin/gallery', { category: 'vinyl', title: 'ซ้ำ', image: png('g1') })).status, 409);
    assert.equal((await s.multipart('/api/admin/gallery', { category: 'nope', title: 'x', image: png('g2') })).status, 400);
  });
  await t.test('public list and image', async () => {
    const r = await s.getJson('/api/gallery');
    assert.equal(r.data.items.length, 1);
    assert.deepEqual(r.data.categories, [{ id: 'vinyl', name: 'ป้ายไวนิล', count: 1 }]);
    const img = await s.fetchW(r.data.items[0].imageUrl);
    assert.equal(img.status, 200); assert.equal(img.headers.get('Content-Type'), 'image/png');
    assert.match(img.headers.get('Cache-Control'), /max-age/);
  });
  await t.test('delete removes row and R2 object', async () => {
    const r = await s.fetchW(`/api/admin/gallery/${id}`, { method: 'DELETE' });
    assert.equal(r.status, 200);
    assert.equal((await s.getJson('/api/gallery')).data.items.length, 0);
    assert.equal([...s.env.SLIPS.objects.keys()].filter(k => k.startsWith('gallery/')).length, 0);
    assert.equal((await s.fetchW(`/api/gallery/${id}/image`)).status, 404);
  });
});
