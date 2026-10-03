import { test } from 'node:test';
import assert from 'node:assert/strict';
import worker from '../src/index.js';
import { makeEnv } from './helpers/fake-d1.js';
import { bangkokDate } from '../src/lib/time.js';
import { summaryRange } from '../src/services/accounts.js';

const ORIGIN = 'https://shop.test';
const TODAY = bangkokDate().ymd;

function setup() {
  const env = makeEnv(); let cookie = '';
  const call = async (path, { method = 'GET', body, headers = {} } = {}) => {
    const init = { method, headers: { Origin: ORIGIN, 'CF-Connecting-IP': '5.5.5.5', ...(cookie ? { Cookie: cookie } : {}), ...headers } };
    if (body !== undefined) { init.body = JSON.stringify(body); init.headers['Content-Type'] = 'application/json'; }
    const res = await worker.fetch(new Request(ORIGIN + path, init), env);
    const sc = res.headers.get('Set-Cookie'); if (sc) cookie = sc.split(';')[0];
    return { status: res.status, data: await res.json() };
  };
  return { env, call };
}

test('summary ranges', () => {
  assert.equal(summaryRange('day', '2026-02').keys.length, 28);
  assert.equal(summaryRange('day', '2028-02').keys.length, 29);
  assert.deepEqual(summaryRange('month', '2026').keys.slice(0, 2), ['2026-01', '2026-02']);
  assert.deepEqual(summaryRange('year', '2026').keys, ['2022', '2023', '2024', '2025', '2026']);
  assert.throws(() => summaryRange('week', '2026'));
  assert.throws(() => summaryRange('day', '2026-13'));
});

test('expenses and profit by day / month / year', async t => {
  const s = setup();
  assert.equal((await s.call('/api/admin/summary')).status, 401);
  await s.call('/api/admin/login', { method: 'POST', body: { password: 'local-test-password-only-1234' } });

  // one paid bill of 1,000.00 today
  const o = (await s.call('/api/admin/orders', { method: 'POST', headers: { 'Idempotency-Key': crypto.randomUUID() }, body: { customer: { name: 'ลูกค้า' }, title: 'ป้าย', items: [{ description: 'ป้าย', qty: 1, unitPrice: '1000' }] } })).data.order;
  await s.call(`/api/admin/orders/${o.orderNo}/payments`, { method: 'POST', body: { version: o.version, method: 'cash', receivedDate: TODAY } });

  let id;
  await t.test('add / validate expenses', async () => {
    const r = await s.call('/api/admin/expenses', { method: 'POST', body: { date: TODAY, category: 'วัสดุ / หมึก / ไวนิล', description: 'ไวนิล 1 ม้วน', vendor: 'ร้านส่ง', amount: '350.25' } });
    assert.equal(r.status, 201, JSON.stringify(r.data)); id = r.data.expense.id;
    assert.equal(r.data.expense.amountSatang, 35025);
    await s.call('/api/admin/expenses', { method: 'POST', body: { date: TODAY, category: 'ค่าไฟ / น้ำ / เน็ต', description: 'ค่าไฟ', amount: '100' } });
    assert.equal((await s.call('/api/admin/expenses', { method: 'POST', body: { date: '2999-01-01', category: 'ค่าเช่า', description: 'x', amount: '1' } })).status, 400);
    assert.equal((await s.call('/api/admin/expenses', { method: 'POST', body: { date: TODAY, category: 'ไม่มี', description: 'x', amount: '1' } })).status, 400);
    assert.equal((await s.call('/api/admin/expenses', { method: 'POST', body: { date: TODAY, category: 'ค่าเช่า', description: 'x', amount: '-1' } })).status, 400);
  });
  await t.test('day / month / year views agree', async () => {
    for (const [view, period] of [['day', TODAY.slice(0, 7)], ['month', TODAY.slice(0, 4)], ['year', TODAY.slice(0, 4)]]) {
      const r = (await s.call(`/api/admin/summary?view=${view}&period=${period}`)).data;
      assert.deepEqual([r.totals.incomeSatang, r.totals.expenseSatang, r.totals.profitSatang], [100000, 45025, 54975], view);
      const key = { day: TODAY, month: TODAY.slice(0, 7), year: TODAY.slice(0, 4) }[view];
      const b = r.buckets.find(x => x.key === key);
      assert.deepEqual([b.incomeSatang, b.expenseSatang, b.profitSatang], [100000, 45025, 54975]);
    }
    const r = (await s.call(`/api/admin/summary?view=day`)).data;
    assert.equal(r.expenseByCategory[0].category, 'วัสดุ / หมึก / ไวนิล');
    assert.equal(r.expenses.length, 2);
  });
  await t.test('delete expense', async () => {
    assert.equal((await s.call(`/api/admin/expenses/${id}`, { method: 'DELETE' })).status, 200);
    assert.equal((await s.call(`/api/admin/expenses/${id}`, { method: 'DELETE' })).status, 404);
    const r = (await s.call(`/api/admin/summary?view=year`)).data;
    assert.equal(r.totals.profitSatang, 90000);
  });
});
