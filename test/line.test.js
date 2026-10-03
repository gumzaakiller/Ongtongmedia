import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import worker from '../src/index.js';
import { makeEnv } from './helpers/fake-d1.js';
import { BANK_APPS, bankLink, platform } from '../public/js/banks.js';

const ORIGIN = 'https://shop.test';
const SECRET = 'line-channel-secret-for-tests';
const USER = 'U' + 'a'.repeat(32);
const jpeg = tag => new Uint8Array([0xFF, 0xD8, 0xFF, 0xE0, ...new TextEncoder().encode(`jpeg-${tag}-bytes`)]);

function setup() {
  const env = makeEnv({ LINE_CHANNEL_SECRET: SECRET, LINE_CHANNEL_ACCESS_TOKEN: 'test-access-token' });
  const replies = []; const images = new Map();
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url, init = {}) => {
    const u = String(url);
    if (u === 'https://api.line.me/v2/bot/message/reply') { replies.push(JSON.parse(init.body).messages[0].text); return new Response('{}'); }
    const m = u.match(/^https:\/\/api-data\.line\.me\/v2\/bot\/message\/([^/]+)\/content$/);
    if (m) { assert.equal(init.headers.Authorization, 'Bearer test-access-token'); const b = images.get(m[1]); return b ? new Response(b) : new Response('', { status: 404 }); }
    return realFetch(url, init);
  };
  let cookie = '';
  const admin = async (path, body) => {
    const r = await worker.fetch(new Request(ORIGIN + path, { method: body ? 'POST' : 'GET', headers: { Origin: ORIGIN, 'Content-Type': 'application/json', 'Idempotency-Key': crypto.randomUUID(), ...(cookie ? { Cookie: cookie } : {}) }, body: body && JSON.stringify(body) }), env);
    const sc = r.headers.get('Set-Cookie'); if (sc) cookie = sc.split(';')[0];
    return r.json();
  };
  const webhook = async (events, { signature, secret = SECRET } = {}) => {
    const body = JSON.stringify({ destination: 'Uxxx', events });
    const sig = signature ?? createHmac('sha256', secret).update(body).digest('base64');
    return worker.fetch(new Request(ORIGIN + '/api/line/webhook', { method: 'POST', headers: { 'Content-Type': 'application/json', 'x-line-signature': sig }, body }), env);
  };
  const text = (t, userId = USER) => ({ type: 'message', replyToken: 'r' + Math.random(), source: { type: 'user', userId }, message: { type: 'text', id: String(Math.random()), text: t } });
  const image = (id, userId = USER) => ({ type: 'message', replyToken: 'r' + Math.random(), source: { type: 'user', userId }, message: { type: 'image', id } });
  return { env, replies, images, admin, webhook, text, image, restore: () => { globalThis.fetch = realFetch; } };
}

test('LINE webhook is off until both secrets are set', async () => {
  const env = makeEnv();
  const r = await worker.fetch(new Request(ORIGIN + '/api/line/webhook', { method: 'POST', body: '{}' }), env);
  assert.equal(r.status, 404);
});

test('LINE OA: order number + slip image → awaiting verification', async t => {
  const s = setup(); t.after(s.restore);
  await s.admin('/api/admin/login', { password: s.env.ADMIN_PASSWORD });
  const order = (await s.admin('/api/admin/orders', { customer: { name: 'คุณเอ' }, items: [{ description: 'ป้าย', qty: 1, unitPrice: '500' }] })).order;

  await t.test('bad or missing signature is rejected', async () => {
    assert.equal((await s.webhook([s.text(order.orderNo)], { signature: 'AAAA' })).status, 401);
    assert.equal((await s.webhook([s.text(order.orderNo)], { secret: 'wrong' })).status, 401);
    assert.equal((await s.webhook([s.text(order.orderNo)], { signature: '' })).status, 401);
    assert.equal(s.replies.length, 0);
  });
  await t.test('LINE "verify" call with no events is accepted', async () => {
    assert.equal((await s.webhook([])).status, 200);
  });
  await t.test('image before any order number asks for the number', async () => {
    s.images.set('m0', jpeg(0));
    await s.webhook([s.image('m0')]);
    assert.match(s.replies.at(-1), /พิมพ์เลขที่รายการ/);
  });
  await t.test('ordinary chat is left for the shop (no reply)', async () => {
    const before = s.replies.length;
    await s.webhook([s.text('สวัสดีค่ะ มีป้ายขนาดอื่นไหม')]);
    assert.equal(s.replies.length, before);
  });
  await t.test('the prefilled message links the chat to the order; reply has no amount or name', async () => {
    await s.webhook([s.text(`แจ้งชำระเงิน\nเลขที่ ${order.orderNo.toLowerCase()}\nยอด ฿500.00`)]);
    assert.match(s.replies.at(-1), new RegExp(order.orderNo));
    assert.doesNotMatch(s.replies.at(-1), /500|คุณเอ/);
  });
  await t.test('slip image is stored and the order waits for review', async () => {
    s.images.set('m1', jpeg(1));
    assert.equal((await s.webhook([s.image('m1')])).status, 200);
    assert.match(s.replies.at(-1), /ได้รับสลิป/);
    const d = (await s.admin('/api/admin/orders/' + order.orderNo)).order;
    assert.equal(d.status, 'awaiting_verification');
    assert.deepEqual([d.payments[0].hasSlip, d.payments[0].customerNote, d.payments[0].slipMime], [true, 'ส่งทาง LINE', 'image/jpeg']);
    assert.equal(d.events.at(-1).note, 'ลูกค้าส่งสลิปทาง LINE');
    assert.equal(s.env.SLIPS.objects.size, 1);
  });
  await t.test('LINE redelivering the same message does not create a second payment', async () => {
    await s.webhook([s.image('m1')]);
    const n = await s.env.DB.prepare('SELECT count(*) n FROM payments').first();
    assert.equal(n.n, 1);
  });
  await t.test('another image while waiting gets a "being checked" reply', async () => {
    s.images.set('m2', jpeg(2));
    await s.webhook([s.image('m2')]);
    assert.match(s.replies.at(-1), /กำลังตรวจสอบ/);
    assert.equal(s.env.SLIPS.objects.size, 1);
  });
  await t.test('a non-image file is refused', async () => {
    const o2 = (await s.admin('/api/admin/orders', { customer: { name: 'คุณบี' }, items: [{ description: 'x', qty: 1, unitPrice: '10' }] })).order;
    const other = 'U' + 'b'.repeat(32);
    await s.webhook([s.text(o2.orderNo, other)]);
    s.images.set('m3', new TextEncoder().encode('%PDF-1.4 not an image'));
    await s.webhook([s.image('m3', other)]);
    assert.match(s.replies.at(-1), /ใช้เป็นสลิปไม่ได้/);
  });
  await t.test('unknown order number', async () => {
    await s.webhook([s.text('ONT-19990101-0001')]);
    assert.match(s.replies.at(-1), /ไม่พบเลขที่รายการ/);
  });
  await t.test('slip from LINE appears in the admin dashboard', async () => {
    const d = await s.admin('/api/admin/dashboard');
    assert.equal(d.awaitingVerification.count, 1);
  });
});

test('bank app links', () => {
  assert.equal(platform('Mozilla/5.0 (Linux; Android 14; SM-A546E) Chrome/129'), 'android');
  assert.equal(platform('Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) Line/14.0'), 'ios');
  const kplus = BANK_APPS.find(b => b.id === 'kplus');
  const a = bankLink(kplus, 'android');
  assert.match(a, /^intent:\/\/#Intent;.*package=com\.kasikorn\.retail\.mbanking\.wap;.*S\.browser_fallback_url=https%3A%2F%2Fplay\.google\.com/);
  assert.equal(bankLink(kplus, 'ios'), 'https://apps.apple.com/th/app/id361170631');
  assert.match(bankLink(BANK_APPS.find(b => b.id === 'baac'), 'android'), /^https:\/\/play\.google\.com\/store\/search\?q=BAAC/);
  for (const b of BANK_APPS) { assert.match(b.ios, /^\d+$/); assert.ok(b.android || b.androidSearch); }
});
