import { test } from 'node:test';
import assert from 'node:assert/strict';
import worker from '../src/index.js';
import { makeEnv } from './helpers/fake-d1.js';
import { bangkokDate } from '../src/lib/time.js';
import { bahtText } from '../src/lib/thaitext.js';

const ORIGIN = 'https://shop.test';
const TODAY = bangkokDate().ymd;
const BE = String(+TODAY.slice(0, 4) + 543);

function setup() {
  const env = makeEnv(); let cookie = '';
  const call = async (path, { method = 'GET', body, headers = {} } = {}) => {
    const init = { method, headers: { Origin: ORIGIN, 'CF-Connecting-IP': '6.6.6.6', ...(cookie ? { Cookie: cookie } : {}), ...headers } };
    if (body !== undefined) { init.body = JSON.stringify(body); init.headers['Content-Type'] = 'application/json'; }
    const res = await worker.fetch(new Request(ORIGIN + path, init), env);
    const sc = res.headers.get('Set-Cookie'); if (sc) cookie = sc.split(';')[0];
    return { status: res.status, data: await res.json() };
  };
  return { env, call };
}

test('Thai amount in words', () => {
  assert.equal(bahtText(50000), 'ห้าร้อยบาทถ้วน');
  assert.equal(bahtText(2100), 'ยี่สิบเอ็ดบาทถ้วน');
  assert.equal(bahtText(1000100), 'หนึ่งหมื่นเอ็ดบาทถ้วน');
  assert.equal(bahtText(150025), 'หนึ่งพันห้าร้อยบาทยี่สิบห้าสตางค์');
  assert.equal(bahtText(100000100), 'หนึ่งล้านเอ็ดบาทถ้วน');
  assert.equal(bahtText(5), 'ห้าสตางค์');
});

test('invoice, delivery note and receipt', async t => {
  const s = setup();
  await s.call('/api/admin/login', { method: 'POST', body: { password: 'local-test-password-only-1234' } });
  const o = (await s.call('/api/admin/orders', { method: 'POST', headers: { 'Idempotency-Key': crypto.randomUUID() }, body: { customer: { name: 'โรงเรียนบ้านแม่แรม', phone: '0612651888' }, title: 'ป้าย', items: [{ description: 'สติ๊กเกอร์+โฟมบอร์ด', qty: 1, unitPrice: '500' }] } })).data.order;
  const token = o.payUrl.split('/pay/')[1];
  const issue = (type, extra = {}) => s.call(`/api/admin/orders/${o.orderNo}/documents`, { method: 'POST', body: { type, ...extra } });

  await t.test('shop header settings', async () => {
    assert.equal((await s.call('/api/admin/doc-settings', { method: 'PUT', body: { address: 'ที่อยู่ร้าน', phone: '080', taxId: '123', signer: 'ผู้ลงนาม' } })).status, 400);
    const r = await s.call('/api/admin/doc-settings', { method: 'PUT', body: { address: '114/2 หมู่ที่ 4', phone: '080-4938357', taxId: '1-2345-67890-12-3', signer: 'นางสาวทดสอบ' } });
    assert.equal(r.status, 200); assert.equal(r.data.settings.taxId, '1234567890123');
  });
  await t.test('receipt is refused before payment (also for the customer)', async () => {
    assert.equal((await issue('receipt')).status, 409);
    assert.equal((await s.call(`/api/pay/${token}/receipt`)).status, 409);
  });
  let delivery;
  await t.test('invoice and delivery note with customer details saved', async () => {
    const inv = await issue('invoice', { customer: { name: 'โรงเรียนบ้านแม่แรม', address: 'หมู่ที่ 12 ตำบลเตาปูน', phone: '061-2651888', taxId: '' } });
    assert.equal(inv.status, 201, JSON.stringify(inv.data));
    const d = inv.data.document;
    assert.deepEqual([d.title, d.book, d.number, d.issuedDate, d.amountText, d.totalSatang], ['ใบแจ้งหนี้', BE.slice(-2), '0001', TODAY, 'ห้าร้อยบาทถ้วน', 50000]);
    assert.equal(d.customer.address, 'หมู่ที่ 12 ตำบลเตาปูน');
    assert.equal(d.shop.taxId, '1234567890123'); assert.equal(d.shop.signer, 'นางสาวทดสอบ');
    delivery = (await issue('delivery')).data.document;
    assert.equal(delivery.number, '0001', 'numbers run per document type');
    const again = (await issue('invoice')).data.document;
    assert.equal(again.number, '0001', 're-issue keeps the number');
    assert.equal(again.customer.address, 'หมู่ที่ 12 ตำบลเตาปูน', 'customer record kept the address');
  });
  await t.test('receipt after payment references the delivery note; customer gets the same one', async () => {
    const d0 = (await s.call(`/api/admin/orders/${o.orderNo}`)).data.order;
    await s.call(`/api/admin/orders/${o.orderNo}/payments`, { method: 'POST', body: { version: d0.version, method: 'cash', receivedDate: TODAY } });
    const pub = await s.call(`/api/pay/${token}/receipt`);
    assert.equal(pub.status, 200, JSON.stringify(pub.data));
    const r = pub.data.document;
    assert.deepEqual([r.title, r.number, r.paymentMethod], ['ใบเสร็จรับเงิน', '0001', 'เงินสด']);
    assert.deepEqual(r.deliveryRef, { book: delivery.book, number: delivery.number });
    assert.equal(r.id, undefined);
    const adm = (await issue('receipt')).data.document;
    assert.equal(adm.number, '0001');
    assert.equal((await s.env.DB.prepare("SELECT count(*) n FROM documents WHERE doc_type='receipt'").first()).n, 1);
    const detail = (await s.call(`/api/admin/orders/${o.orderNo}`)).data.order;
    assert.deepEqual(detail.documents.map(x => x.type).sort(), ['delivery', 'invoice', 'receipt']);
    const doc = await s.call(`/api/admin/documents/${detail.documents[0].id}`);
    assert.equal(doc.status, 200);
  });
  await t.test('second bill gets the next number; bad input refused', async () => {
    const o2 = (await s.call('/api/admin/orders', { method: 'POST', headers: { 'Idempotency-Key': crypto.randomUUID() }, body: { customer: { name: 'ลูกค้า 2' }, items: [{ description: 'ป้าย', qty: 2, unitPrice: '150.50' }] } })).data.order;
    const r = await s.call(`/api/admin/orders/${o2.orderNo}/documents`, { method: 'POST', body: { type: 'invoice' } });
    assert.equal(r.data.document.number, '0002');
    assert.equal(r.data.document.amountText, 'สามร้อยเอ็ดบาทถ้วน');
    assert.equal((await s.call(`/api/admin/orders/${o2.orderNo}/documents`, { method: 'POST', body: { type: 'quote' } })).status, 400);
    assert.equal((await s.call(`/api/admin/orders/${o2.orderNo}/documents`, { method: 'POST', body: { type: 'invoice', date: '2999-01-01' } })).status, 400);
    assert.equal((await s.call(`/api/admin/orders/${o2.orderNo}/documents`, { method: 'POST', body: { type: 'invoice', customer: { name: 'x', taxId: '12' } } })).status, 400);
    assert.equal((await s.call('/api/admin/documents/999')).status, 404);
  });
});
