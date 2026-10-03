import { test } from 'node:test';
import assert from 'node:assert/strict';
import worker from '../src/index.js';
import { makeEnv } from './helpers/fake-d1.js';

const ORIGIN = 'https://shop.test';
const PASSWORD = 'local-test-password-only-1234';
const png = tag => new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 13, 73, 72, 68, 82, ...new TextEncoder().encode(`art-${tag}-padding`)]);
const pdf = new TextEncoder().encode('%PDF-1.7\n1 0 obj << >> endobj\n%%EOF');

function setup() {
  const env = makeEnv(); let cookie = '';
  const call = async (path, { method = 'GET', body, headers = {}, ip = '1.1.1.1', raw } = {}) => {
    const init = { method, headers: { Origin: ORIGIN, 'CF-Connecting-IP': ip, ...(cookie ? { Cookie: cookie } : {}), ...headers } };
    if (body !== undefined) { init.body = JSON.stringify(body); init.headers['Content-Type'] = 'application/json'; }
    const res = await worker.fetch(new Request(ORIGIN + path, init), env);
    const sc = res.headers.get('Set-Cookie'); if (sc) cookie = sc.split(';')[0];
    if (raw) return res;
    return { status: res.status, headers: res.headers, data: (res.headers.get('Content-Type') || '').includes('json') ? await res.json() : await res.text() };
  };
  const submit = async (fields = {}, { files = [], key = crypto.randomUUID(), ip = '2.2.2.2' } = {}) => {
    const form = new FormData();
    const f = { category: 'vinyl', qty: '2', width: '200', height: '100', unit: 'cm', artwork: 'have', details: 'พื้นเหลือง ตัวหนังสือดำ', name: 'ร้านกาแฟดอยตุง', phone: '081-222-3333', lineId: '', ...fields };
    for (const [k, v] of Object.entries(f)) if (Array.isArray(v)) v.forEach(x => form.append(k, x)); else form.set(k, v);
    for (const [name, bytes, type] of files) form.append('files', new Blob([bytes], { type }), name);
    const enc = new Request(ORIGIN, { method: 'POST', body: form });
    const res = await worker.fetch(new Request(ORIGIN + '/api/requests', { method: 'POST', body: await enc.arrayBuffer(),
      headers: { Origin: ORIGIN, 'CF-Connecting-IP': ip, 'Idempotency-Key': key, 'Content-Type': enc.headers.get('Content-Type') } }), env);
    return { status: res.status, data: await res.json() };
  };
  return { env, call, submit, login: () => call('/api/admin/login', { method: 'POST', body: { password: PASSWORD } }) };
}

test('customer sends a job request (สั่งงาน)', async t => {
  const s = setup();
  let first;
  await t.test('catalog lists sign-shop jobs, no shirts', async () => {
    const r = await s.call('/api/catalog');
    const names = r.data.catalog.map(c => c.name).join(' ');
    assert.match(names, /ป้ายไวนิล/); assert.doesNotMatch(names, /เสื้อ/);
  });
  await t.test('request with options and two files is saved; files kept private in R2', async () => {
    const r = await s.submit({ options: ['เจาะตาไก่', 'ไม่มีจริง'], deadline: '2099-12-31' }, { files: [['โลโก้ร้าน.png', png(1), 'image/png'], ['แบบ.pdf', pdf, 'application/pdf']] });
    assert.equal(r.status, 201, JSON.stringify(r.data));
    assert.match(r.data.requestNo, /^REQ-\d{8}-0001$/);
    assert.match(r.data.trackUrl, /^https:\/\/shop\.test\/request\/[A-Za-z0-9_-]{43}$/);
    assert.equal(s.env.SLIPS.objects.size, 2);
    for (const k of s.env.SLIPS.objects.keys()) assert.match(k, /^requests\/\d{4}\/\d{2}\/REQ-\d{8}-0001\/[a-f0-9]{16}\.(png|pdf)$/);
    first = r.data;
  });
  await t.test('tracking page shows status, never the phone number', async () => {
    const r = await s.call('/api/requests/' + first.trackUrl.split('/request/')[1]);
    assert.equal(r.status, 200);
    assert.equal(r.data.request.status, 'new');
    assert.equal(r.data.request.summary, 'ป้ายไวนิล 200×100 ซม. 2 ชิ้น');
    assert.deepEqual(r.data.request.details.options, ['เจาะตาไก่']);       // unknown option dropped
    assert.deepEqual(r.data.request.files.map(f => f.name), ['โลโก้ร้าน.png', 'แบบ.pdf']);
    assert.ok(!JSON.stringify(r.data).includes('081-222-3333'));
    assert.equal(r.data.request.bill, null);
    assert.equal(r.headers.get('X-Robots-Tag'), 'noindex, nofollow');
  });
  await t.test('same Idempotency-Key → same request', async () => {
    const key = crypto.randomUUID();
    const a = await s.submit({}, { key, ip: '2.2.2.3' }); const b = await s.submit({}, { key, ip: '2.2.2.3' });
    assert.equal(a.status, 201); assert.equal(b.status, 200); assert.equal(a.data.requestNo, b.data.requestNo);
  });
  await t.test('validation', async () => {
    const bad = async (fields, opts = {}) => (await s.submit(fields, { ip: '9.9.9.' + Math.floor(Math.random() * 200), ...opts })).status;
    assert.equal(await bad({ category: 'shirt' }), 400);
    assert.equal(await bad({ name: '' }), 400);
    assert.equal(await bad({ phone: '', lineId: '' }), 400);          // no way to contact
    assert.equal(await bad({ qty: '0' }), 400);
    assert.equal(await bad({ width: '-5' }), 400);
    assert.equal(await bad({ deadline: '2000-01-01' }), 400);
    assert.equal(await bad({ category: 'other', details: '' }), 400);
    assert.equal(await bad({}, { files: [['virus.exe', new TextEncoder().encode('MZ...'), 'application/octet-stream']] }), 400);
    const big = new Uint8Array(20 * 1024 * 1024 + 5); big.set(png(2));
    assert.equal(await bad({}, { files: [['big.png', big, 'image/png']] }), 413);
    assert.equal(await bad({}, { files: Array.from({ length: 6 }, (_, i) => [`a${i}.png`, png(i), 'image/png']) }), 400);
    assert.equal(await bad({ category: 'design', width: '', height: '', lineId: 'shop_line', phone: '' }), 201);
  });
  await t.test('requests are rate limited per IP', async () => {
    let last; for (let i = 0; i < 6; i++) last = await s.submit({}, { ip: '7.7.7.7' });
    assert.equal(last.status, 429);
  });
});

test('shop quotes a request → bill + pay link; customer sees it', async t => {
  const s = setup();
  const sent = (await s.submit({}, { files: [['art.png', png(9), 'image/png']] })).data;
  const token = sent.trackUrl.split('/request/')[1];
  await t.test('admin endpoints need login', async () => {
    assert.equal((await s.call('/api/admin/requests')).status, 401);
    assert.equal((await s.call('/api/admin/request-files/1')).status, 401);
  });
  await s.login();
  let detail;
  await t.test('list, detail, file download', async () => {
    const l = await s.call('/api/admin/requests?status=new');
    assert.equal(l.data.requests.length, 1); assert.equal(l.data.requests[0].files, 1);
    detail = (await s.call('/api/admin/requests/' + sent.requestNo)).data.request;
    assert.deepEqual([detail.customer.name, detail.customer.phone, detail.version], ['ร้านกาแฟดอยตุง', '081-222-3333', 1]);
    const f = await s.call('/api/admin/request-files/' + detail.files[0].id, { raw: true });
    assert.equal(f.status, 200); assert.equal(f.headers.get('Content-Type'), 'image/png');
    assert.deepEqual(new Uint8Array(await f.arrayBuffer()), png(9));
    assert.equal((await s.call('/api/admin/dashboard')).data.newRequests.count, 1);
  });
  const quoteBody = { requestVersion: 1, customer: { name: 'ร้านกาแฟดอยตุง', phone: '081-222-3333' }, title: 'ป้ายไวนิล 200×100 ซม.', items: [{ description: 'ไวนิล 2x1 ม. เจาะตาไก่', qty: 2, unitPrice: '300' }] };
  const quote = (body, key = crypto.randomUUID()) => s.call(`/api/admin/requests/${sent.requestNo}/quote`, { method: 'POST', body, headers: { 'Idempotency-Key': key } });
  let bill;
  await t.test('stale request version is refused and creates nothing', async () => {
    assert.equal((await quote({ ...quoteBody, requestVersion: 9 })).status, 409);
    assert.equal((await s.env.DB.prepare('SELECT count(*) n FROM orders').first()).n, 0);
  });
  await t.test('quote creates the bill and links it', async () => {
    const r = await quote(quoteBody);
    assert.equal(r.status, 201, JSON.stringify(r.data));
    bill = r.data.order;
    assert.equal(bill.totalSatang, 60000);
    assert.match(bill.events[0].note, new RegExp(sent.requestNo));
    const d = (await s.call('/api/admin/requests/' + sent.requestNo)).data.request;
    assert.deepEqual([d.status, d.bill.orderNo], ['quoted', bill.orderNo]);
  });
  await t.test('a second quote for the same request is refused', async () => {
    assert.equal((await quote({ ...quoteBody, requestVersion: 1 })).status, 409);
    assert.equal((await s.env.DB.prepare('SELECT count(*) n FROM orders').first()).n, 1);
  });
  await t.test('customer tracking page now links to the pay page', async () => {
    const r = (await s.call('/api/requests/' + token)).data.request;
    assert.equal(r.status, 'quoted');
    assert.equal(r.bill.orderNo, bill.orderNo); assert.equal(r.bill.totalSatang, 60000);
    assert.equal(r.bill.payUrl, bill.payUrl);
  });
  await t.test('cancel only works on new requests', async () => {
    assert.equal((await s.call(`/api/admin/requests/${sent.requestNo}/cancel`, { method: 'POST', body: { version: 2, reason: 'x' } })).status, 409);
    const other = (await s.submit({}, { ip: '2.2.2.9' })).data;
    const r = await s.call(`/api/admin/requests/${other.requestNo}/cancel`, { method: 'POST', body: { version: 1, reason: 'ลูกค้าเปลี่ยนใจ' } });
    assert.equal(r.status, 200); assert.equal(r.data.request.status, 'cancelled');
    const pub = (await s.call('/api/requests/' + other.trackUrl.split('/request/')[1])).data.request;
    assert.deepEqual([pub.status, pub.cancelReason], ['cancelled', 'ลูกค้าเปลี่ยนใจ']);
  });
  await t.test('/request/<token> serves the tracking page', async () => {
    const r = await s.call('/request/' + token);
    assert.equal(r.data, 'asset:/request');
  });
});
