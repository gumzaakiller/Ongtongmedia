import test from 'node:test';
import assert from 'node:assert/strict';
import { toSatang } from '../src/lib/money.js';
import { crc16, promptPayPayload } from '../src/lib/promptpay.js';
import { validateNewOrder, validateOrderEdit } from '../src/lib/validate.js';
import { bangkokDate, bangkokDayRange } from '../src/lib/time.js';
import { randomToken, TOKEN_RE } from '../src/lib/crypto.js';

const order = () => ({ customer: { name: 'คุณเอ', phone: '081-234-5678' }, title: 'ป้ายไวนิล', items: [{ description: 'ไวนิล 1x2 ม.', qty: 3, unitPrice: '100.25' }], discount: '10.50' });

test('money parses to integer satang without float drift', () => {
  assert.equal(toSatang('0.29'), 29);
  assert.equal(toSatang('1,250.50'), 125050);
  assert.equal(toSatang('1250.5'), 125050);
  assert.equal(toSatang(19.99), 1999);
  assert.equal(toSatang('0', 'x', { allowZero: true }), 0);
  for (const bad of ['NaN', 'Infinity', '-1', '1.001', '', ' ', null, true, '1e3', '0x10', '1000000.01']) assert.throws(() => toSatang(bad), String(bad));
  assert.throws(() => toSatang('0'));
});

test('server recomputes totals and ignores totals sent by the browser', () => {
  const v = validateNewOrder({ ...order(), subtotal: 1, total: 1, totalSatang: 1 });
  assert.deepEqual([v.subtotal, v.discount, v.total], [30075, 1050, 29025]);
  assert.equal(v.items[0].amount, 30075);
});

test('order validation rejects bad input', () => {
  const bad = [
    { items: [] },
    { items: Array.from({ length: 51 }, () => ({ description: 'x', qty: 1, unitPrice: 1 })) },
    { items: [{ description: '', qty: 1, unitPrice: 1 }] },
    { items: [{ description: 'x', qty: 0, unitPrice: 1 }] },
    { items: [{ description: 'x', qty: 1.5, unitPrice: 1 }] },
    { items: [{ description: 'x', qty: 1, unitPrice: '0' }] },
    { items: [{ description: 'x', qty: 10000, unitPrice: '100000' }] },   // > 1,000,000 baht
    { discount: '301' },                                                  // discount ≥ subtotal (300.75)
    { customer: {} },
    { customer: { name: 'x', phone: 'abc' } },
    { customer: { id: -1 } }
  ];
  for (const patch of bad) assert.throws(() => validateNewOrder({ ...order(), ...patch }), JSON.stringify(patch).slice(0, 60));
  assert.equal(validateNewOrder({ ...order(), title: '' }).title, 'ไวนิล 1x2 ม.');
  assert.throws(() => validateOrderEdit({ title: 'x' }));                     // version required
  assert.throws(() => validateOrderEdit({ version: 1, discount: '1' }));      // discount needs items
});

test('PromptPay payload encodes phone, exact amount and CRC', () => {
  assert.equal(crc16('123456789'), '29B1');
  const p = promptPayPayload('0812345678', 31125);
  assert.ok(p.includes('01130066812345678'));
  assert.ok(p.includes('5406311.25'));
  assert.ok(promptPayPayload('0812345678', 5).includes('54040.05'));
  assert.equal(p.slice(-4), crc16(p.slice(0, -4)));
  assert.throws(() => promptPayPayload('123', 100));
  assert.throws(() => promptPayPayload('0812345678', 0));
});

test('Thai calendar day and day range', () => {
  assert.equal(bangkokDate(new Date('2026-10-02T17:30:00Z')).ymd, '2026-10-03');
  assert.equal(bangkokDate(new Date('2026-10-02T16:59:59Z')).compact, '20261002');
  assert.deepEqual(bangkokDayRange('2026-10-03'), ['2026-10-02T17:00:00.000Z', '2026-10-03T17:00:00.000Z']);
});

test('pay-link tokens are 43-char base64url and unique', () => {
  const tokens = new Set(Array.from({ length: 500 }, randomToken));
  assert.equal(tokens.size, 500);
  for (const t of tokens) assert.match(t, TOKEN_RE);
});

test('QR matrix encodes PromptPay payloads (decode check done with OpenCV during development)', async () => {
  const { qrMatrix, qrPng } = await import('../src/lib/qr.js');
  const p = promptPayPayload('0882965924', 85050);
  const m = qrMatrix(p);
  assert.ok(m.size >= 25 && m.size <= 45, `size ${m.size}`);
  // finder pattern corners are dark
  assert.ok(m.dark(0, 0) && m.dark(m.size - 1, 0) && m.dark(0, m.size - 1));
  const png = await qrPng(p);
  assert.equal(new DataView(png.buffer).getUint32(16), (m.size + 8) * 8); // IHDR width
});
