import { test } from 'node:test';
import assert from 'node:assert/strict';
import worker from '../src/index.js';
import { makeEnv } from './helpers/fake-d1.js';
import { bangkokDate } from '../src/lib/time.js';

const ORIGIN = 'https://shop.test';
const PASSWORD = 'local-test-password-only-1234';
const TODAY = bangkokDate().ymd;

// A "PNG" whose first bytes are the real PNG signature; the tail makes each one unique.
const png = (tag = Math.random()) => new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 13, 73, 72, 68, 82, ...new TextEncoder().encode(`slip-${tag}-padding-bytes`)]);

function setup() {
  const env = makeEnv(); let cookie = '';
  const call = async (path, { method = 'GET', body, headers = {}, ip = '1.1.1.1', raw } = {}) => {
    const init = { method, headers: { Origin: ORIGIN, 'CF-Connecting-IP': ip, ...(cookie ? { Cookie: cookie } : {}), ...headers } };
    if (body !== undefined) { init.body = JSON.stringify(body); init.headers['Content-Type'] = 'application/json'; }
    const res = await worker.fetch(new Request(ORIGIN + path, init), env);
    const sc = res.headers.get('Set-Cookie'); if (sc) cookie = sc.split(';')[0];
    if (raw) return res;
    const type = res.headers.get('Content-Type') || '';
    return { status: res.status, headers: res.headers, data: type.includes('json') ? await res.json() : await res.text() };
  };
  const login = () => call('/api/admin/login', { method: 'POST', body: { password: PASSWORD } });
  const create = async (overrides = {}) => (await call('/api/admin/orders', { method: 'POST', headers: { 'Idempotency-Key': crypto.randomUUID() }, body: {
    customer: { name: 'คุณมานี มีนา', phone: '0891112222' }, title: 'โปสเตอร์ A3', items: [{ description: 'โปสเตอร์ A3 อาร์ตมัน', qty: 10, unitPrice: '25.50' }], ...overrides
  } })).data.order;
  const tokenOf = o => o.payUrl.split('/pay/')[1];
  const upload = async (token, { bytes = png(), key = crypto.randomUUID(), note = 'โอนแล้วค่ะ', ip = '3.3.3.3', type = 'image/png', skipFile = false } = {}) => {
    const form = new FormData();
    if (!skipFile) form.set('slip', new Blob([bytes], { type }), 'slip.png');
    form.set('note', note);
    const encoded = new Request(ORIGIN, { method: 'POST', body: form });
    const res = await worker.fetch(new Request(`${ORIGIN}/api/pay/${token}/slip`, { method: 'POST', body: await encoded.arrayBuffer(),
      headers: { Origin: ORIGIN, 'CF-Connecting-IP': ip, 'Idempotency-Key': key, 'Content-Type': encoded.headers.get('Content-Type') } }), env);
    return { status: res.status, data: await res.json() };
  };
  const order = no => call('/api/admin/orders/' + no).then(r => r.data.order);
  const count = async sql => (await env.DB.prepare(sql).first()).n;
  return { env, call, login, create, tokenOf, upload, order, count };
}

test('customer uploads a slip (Phase 8)', async t => {
  const s = setup(); await s.login();
  const o = await s.create(); const token = s.tokenOf(o);
  let key;
  await t.test('slip stored privately in R2, order waits for verification', async () => {
    key = crypto.randomUUID();
    const r = await s.upload(token, { key, bytes: png('a') });
    assert.equal(r.status, 201, JSON.stringify(r.data));
    const d = await s.order(o.orderNo);
    assert.equal(d.status, 'awaiting_verification');
    assert.equal(d.payments.length, 1);
    assert.deepEqual([d.payments[0].status, d.payments[0].amountSatang, d.payments[0].hasSlip, d.payments[0].customerNote], ['submitted', 25500, true, 'โอนแล้วค่ะ']);
    assert.equal(s.env.SLIPS.objects.size, 1);
    const [k, obj] = [...s.env.SLIPS.objects][0];
    assert.match(k, new RegExp(`^slips/\\d{4}/\\d{2}/${o.orderNo}/[a-f0-9]{16}\\.png$`));
    assert.equal(obj.httpMetadata.contentType, 'image/png');
  });
  await t.test('network retry with the same key is answered once', async () => {
    const r = await s.upload(token, { key, bytes: png('a') });
    assert.equal(r.status, 200);
    assert.equal(await s.count('SELECT count(*) n FROM payments'), 1);
    assert.equal(s.env.SLIPS.objects.size, 1);
  });
  await t.test('a second slip while one is being checked is refused (nothing stored)', async () => {
    const r = await s.upload(token, { bytes: png('b') });
    assert.equal(r.status, 409);
    assert.equal(s.env.SLIPS.objects.size, 1);
  });
  await t.test('customer page shows "being checked" and no QR', async () => {
    const r = await s.call('/api/pay/' + token);
    assert.equal(r.data.order.status, 'awaiting_verification');
    assert.equal(r.data.qrImageUrl, null);
    assert.equal(r.data.order.lastPayment.status, 'submitted');
  });
  await t.test('admin can view the slip; others cannot', async () => {
    const d = await s.order(o.orderNo);
    const res = await s.call(`/api/admin/payments/${d.payments[0].id}/slip`, { raw: true });
    assert.equal(res.status, 200); assert.equal(res.headers.get('Content-Type'), 'image/png');
    assert.deepEqual(new Uint8Array(await res.arrayBuffer()), png('a'));
    const anon = await worker.fetch(new Request(`${ORIGIN}/api/admin/payments/${d.payments[0].id}/slip`), s.env);
    assert.equal(anon.status, 401);
  });
  await t.test('bad files are rejected before anything is stored', async () => {
    const o2 = await s.create(); const t2 = s.tokenOf(o2);
    const before = s.env.SLIPS.objects.size;
    assert.equal((await s.upload(t2, { bytes: new TextEncoder().encode('<html>not an image</html>') })).status, 400);
    assert.equal((await s.upload(t2, { bytes: new TextEncoder().encode('%PDF-1.7 fake'), type: 'application/pdf' })).status, 400);
    assert.equal((await s.upload(t2, { skipFile: true })).status, 400);
    const big = new Uint8Array(8 * 1024 * 1024 + 10); big.set(png(), 0);
    assert.equal((await s.upload(t2, { bytes: big })).status, 413);
    assert.equal((await s.upload('Z'.repeat(43))).status, 404);
    assert.equal(s.env.SLIPS.objects.size, before);
    assert.equal((await s.order(o2.orderNo)).status, 'pending');
  });
  await t.test('if the DB write fails, the uploaded file is removed again', async () => {
    const o3 = await s.create(); const before = s.env.SLIPS.objects.size;
    const realBatch = s.env.DB.batch.bind(s.env.DB);
    s.env.DB.batch = async () => { throw new Error('D1 unavailable'); };
    const r = await s.upload(s.tokenOf(o3), { ip: '4.4.4.4' });
    s.env.DB.batch = realBatch;
    assert.equal(r.status, 500);
    assert.equal(s.env.SLIPS.objects.size, before);
  });
  await t.test('cancelled orders do not accept slips', async () => {
    const o4 = await s.create();
    await s.call(`/api/admin/orders/${o4.orderNo}/status`, { method: 'POST', body: { to: 'cancelled', version: 1 } });
    assert.equal((await s.upload(s.tokenOf(o4), { ip: '6.6.6.6' })).status, 409);
  });
  await t.test('uploads are rate limited per IP', async () => {
    let last; for (let i = 0; i < 11; i++) last = await s.upload('Q'.repeat(43), { ip: '8.8.8.8' });
    assert.equal(last.status, 429);
  });
});

test('admin verifies or rejects payments; income is recorded once (Phase 6)', async t => {
  const s = setup(); await s.login();
  const o = await s.create(); const token = s.tokenOf(o);
  await s.upload(token);
  let d = await s.order(o.orderNo); const pid = d.payments[0].id;
  await t.test('stale version refused', async () => {
    assert.equal((await s.call(`/api/admin/payments/${pid}/verify`, { method: 'POST', body: { version: 1 } })).status, 409);
  });
  await t.test('verify → paid + one income row with the D1 amount', async () => {
    const r = await s.call(`/api/admin/payments/${pid}/verify`, { method: 'POST', body: { version: d.version } });
    assert.equal(r.status, 200, JSON.stringify(r.data));
    assert.equal(r.data.order.status, 'paid'); assert.ok(r.data.order.paidAt);
    assert.equal(r.data.order.payments[0].status, 'verified');
    const inc = await s.env.DB.prepare('SELECT * FROM income').all();
    assert.equal(inc.results.length, 1);
    assert.deepEqual([inc.results[0].amount_satang, inc.results[0].received_date, inc.results[0].payment_id], [25500, TODAY, pid]);
    d = r.data.order;
  });
  await t.test('verifying again never adds a second income row', async () => {
    assert.equal((await s.call(`/api/admin/payments/${pid}/verify`, { method: 'POST', body: { version: d.version } })).status, 409);
    assert.equal(await s.count('SELECT count(*) n FROM income'), 1);
  });
  await t.test('two admins clicking verify at the same time → one income row', async () => {
    const o2 = await s.create(); await s.upload(s.tokenOf(o2), { ip: '3.3.3.4' });
    const d2 = await s.order(o2.orderNo);
    const rs = await Promise.all([1, 2].map(() => s.call(`/api/admin/payments/${d2.payments[0].id}/verify`, { method: 'POST', body: { version: d2.version } })));
    assert.deepEqual(rs.map(r => r.status).sort(), [200, 409]);
    assert.equal(await s.count(`SELECT count(*) n FROM income WHERE order_id=(SELECT id FROM orders WHERE order_no='${o2.orderNo}')`), 1);
  });
  await t.test('after payment: processing → completed', async () => {
    let r = await s.call(`/api/admin/orders/${o.orderNo}/status`, { method: 'POST', body: { to: 'processing', version: d.version } });
    assert.equal(r.data.order.status, 'processing');
    r = await s.call(`/api/admin/orders/${o.orderNo}/status`, { method: 'POST', body: { to: 'completed', version: r.data.order.version } });
    assert.equal(r.data.order.status, 'completed');
    assert.equal((await s.call('/api/pay/' + token)).data.order.status, 'completed');
  });
  await t.test('reject → back to pending, customer sees the reason and can send a new slip', async () => {
    const o3 = await s.create(); const t3 = s.tokenOf(o3); const slip = png('dup');
    await s.upload(t3, { bytes: slip, ip: '3.3.3.5' });
    const d3 = await s.order(o3.orderNo); const p3 = d3.payments[0].id;
    assert.equal((await s.call(`/api/admin/payments/${p3}/reject`, { method: 'POST', body: { version: d3.version, reason: '' } })).status, 400);
    const r = await s.call(`/api/admin/payments/${p3}/reject`, { method: 'POST', body: { version: d3.version, reason: 'ยอดในสลิปไม่ตรง' } });
    assert.equal(r.status, 200); assert.equal(r.data.order.status, 'pending');
    const pub = (await s.call('/api/pay/' + t3)).data;
    assert.deepEqual([pub.order.lastPayment.status, pub.order.lastPayment.rejectReason], ['rejected', 'ยอดในสลิปไม่ตรง']);
    assert.ok(pub.qrImageUrl);
    assert.equal((await s.upload(t3, { bytes: slip, ip: '3.3.3.6' })).status, 409);   // same file again
    assert.equal((await s.upload(t3, { bytes: png('new'), ip: '3.3.3.7' })).status, 201);
    assert.equal(await s.count(`SELECT count(*) n FROM income WHERE order_id=(SELECT id FROM orders WHERE order_no='${o3.orderNo}')`), 0);
  });
  await t.test('manual record (slip received in LINE / cash) → paid + income on the chosen date', async () => {
    const o4 = await s.create({ items: [{ description: 'นามบัตร', qty: 2, unitPrice: '300' }] });
    const bad = (body, code = 400) => s.call(`/api/admin/orders/${o4.orderNo}/payments`, { method: 'POST', body: { version: 1, method: 'cash', ...body } }).then(r => assert.equal(r.status, code, JSON.stringify(body)));
    await bad({ method: 'bitcoin' });
    await bad({ receivedDate: '2999-01-01' });
    await bad({ receivedDate: '2026-02-30' });
    await bad({ version: 5 }, 409);
    const r = await s.call(`/api/admin/orders/${o4.orderNo}/payments`, { method: 'POST', body: { version: 1, method: 'cash', receivedDate: '2026-10-01', note: 'จ่ายหน้าร้าน' } });
    assert.equal(r.status, 200, JSON.stringify(r.data)); assert.equal(r.data.order.status, 'paid');
    const inc = await s.env.DB.prepare(`SELECT i.amount_satang a, i.received_date d, p.method m FROM income i JOIN payments p ON p.id=i.payment_id WHERE i.order_id=(SELECT id FROM orders WHERE order_no='${o4.orderNo}')`).first();
    assert.deepEqual([inc.a, inc.d, inc.m], [60000, '2026-10-01', 'cash']);
    await bad({ version: r.data.order.version }, 409); // already paid
  });
  await t.test('manual record is refused while a customer slip waits for review', async () => {
    const o5 = await s.create(); await s.upload(s.tokenOf(o5), { ip: '3.3.3.8' });
    const d5 = await s.order(o5.orderNo);
    assert.equal((await s.call(`/api/admin/orders/${o5.orderNo}/payments`, { method: 'POST', body: { version: d5.version, method: 'cash' } })).status, 409);
  });
});

test('income search, CSV and dashboard (Phase 7)', async t => {
  const s = setup(); await s.login();
  const paid = async (name, price, date, method = 'bank_transfer') => {
    const o = await s.create({ customer: { name, phone: '0812223333' }, items: [{ description: 'งาน', qty: 1, unitPrice: price }] });
    await s.call(`/api/admin/orders/${o.orderNo}/payments`, { method: 'POST', body: { version: 1, method, receivedDate: date } });
    return o;
  };
  const a = await paid('ร้านกาแฟดอยตุง', '1000', '2026-09-15');
  await paid('ร้านกาแฟดอยตุง', '250.25', '2026-09-30');
  await paid('=HYPERLINK("http://evil")', '99', TODAY, 'cash');
  const b = await paid('โรงเรียนบ้านดู่', '5000', TODAY);
  await s.create(); // unpaid
  const o = await s.create(); await s.upload(s.tokenOf(o)); // awaiting

  await t.test('totals for everything, a month, a date range, and a search', async () => {
    const all = (await s.call('/api/admin/income')).data;
    assert.equal(all.totals.count, 4); assert.equal(all.totals.totalSatang, 100000 + 25025 + 9900 + 500000);
    const sep = (await s.call('/api/admin/income?month=2026-09')).data;
    assert.deepEqual([sep.totals.count, sep.totals.totalSatang], [2, 125025]);
    assert.deepEqual(sep.income.map(i => i.receivedDate), ['2026-09-30', '2026-09-15']);
    const range = (await s.call('/api/admin/income?from=2026-09-16&to=2026-09-30')).data;
    assert.equal(range.totals.count, 1);
    assert.equal((await s.call('/api/admin/income?q=' + encodeURIComponent('ดอยตุง'))).data.totals.count, 2);
    assert.equal((await s.call('/api/admin/income?q=' + a.orderNo.toLowerCase())).data.totals.count, 1);
    assert.equal((await s.call('/api/admin/income?q=' + b.orderNo)).data.income[0].customerName, 'โรงเรียนบ้านดู่');
    for (const bad of ['month=2026-13', 'from=2026-02-30', 'from=2026-10-02&to=2026-10-01']) assert.equal((await s.call('/api/admin/income?' + bad)).status, 400, bad);
  });
  await t.test('paging returns every row exactly once', async () => {
    for (let i = 0; i < 55; i++) await paid('ลูกค้า ' + i, '10', TODAY);
    const p1 = (await s.call('/api/admin/income')).data; assert.equal(p1.income.length, 50); assert.ok(p1.nextCursor);
    const p2 = (await s.call('/api/admin/income?cursor=' + p1.nextCursor)).data;
    const ids = [...p1.income, ...p2.income].map(i => i.id);
    assert.equal(new Set(ids).size, 59); assert.equal(p2.nextCursor, null);
  });
  await t.test('CSV opens in Excel (BOM), has a total row and neutralises formulas', async () => {
    const r = await s.call('/api/admin/income.csv?month=2026-09', { raw: true });
    assert.equal(r.headers.get('Content-Type'), 'text/csv; charset=utf-8');
    const bytes = new Uint8Array(await r.arrayBuffer());
    assert.deepEqual([...bytes.slice(0, 3)], [0xEF, 0xBB, 0xBF]); // UTF-8 BOM
    const text = new TextDecoder().decode(bytes);
    const lines = text.trim().split('\r\n');
    assert.equal(lines.length, 4); assert.match(lines[0], /วันที่รับเงิน/); assert.match(lines.at(-1), /รวม,1250\.25/);
    const all = new TextDecoder().decode(await (await s.call('/api/admin/income.csv', { raw: true })).arrayBuffer());
    assert.ok(all.includes(`"'=HYPERLINK(""http://evil"")"`), 'formula escaped');
    assert.equal((await worker.fetch(new Request(ORIGIN + '/api/admin/income.csv'), s.env)).status, 401);
  });
  await t.test('dashboard numbers', async () => {
    const d = (await s.call('/api/admin/dashboard')).data;
    assert.equal(d.today, TODAY);
    assert.deepEqual([d.receivedToday.count, d.receivedToday.totalSatang], [57, 9900 + 500000 + 55 * 1000]);
    assert.deepEqual([d.awaitingVerification.count, d.unpaid.count], [1, 1]);
    assert.equal(d.awaitingList[0].orderNo, o.orderNo);
    assert.equal(d.last7Days.length, 7); assert.equal(d.last7Days[6].date, TODAY);
    assert.equal(d.last7Days[6].totalSatang, d.receivedToday.totalSatang);
    assert.ok(d.ordersToday.count >= 61);
  });
});
