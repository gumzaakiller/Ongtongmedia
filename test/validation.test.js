import test from 'node:test';
import assert from 'node:assert/strict';
import { validateOrder, money, crc16, promptPayPayload } from '../src/shared.js';
import worker, { imageType } from '../src/index.js';
import { bangkokPeriods } from '../src/accounting.js';
test('Bangkok periods handle midnight, month lengths and new year',()=>{
  const feb=bangkokPeriods(new Date('2026-01-31T17:00:00Z'));
  assert.equal(feb.date,'2026-02-01');assert.equal(feb.start,'2026-01-31T17:00:00.000Z');assert.equal(feb.end,'2026-02-28T17:00:00.000Z');
  assert.equal(bangkokPeriods(new Date('2026-12-31T17:00:00Z')).month,'2027-01');
});
const sample = () => ({ customer:'ทดสอบ',phone:'0812345678',items:[{name:'งานพิมพ์',price:'100.25',qty:3}],shipping:'10.50' });
test('server computes integer satang and ignores forged totals',()=>{
  const order=validateOrder({...sample(),subtotal:1,total:1});
  assert.equal(order.subtotal,30075);assert.equal(order.total,31125);
});
test('invalid prices, quantities and incomplete rows are rejected',()=>{
  for(const price of ['NaN','Infinity','-1','1.001','',null,true]) assert.throws(()=>validateOrder({...sample(),items:[{name:'x',price,qty:1}]}));
  for(const qty of [0,-1,1.5,10001,'2']) assert.throws(()=>validateOrder({...sample(),items:[{name:'x',price:1,qty}]}));
  assert.throws(()=>validateOrder({...sample(),items:[{name:'',price:1,qty:1}]}));
  assert.throws(()=>validateOrder({...sample(),shipping:-1}));
  assert.throws(()=>validateOrder({...sample(),phone:'x'}));
  assert.throws(()=>validateOrder({...sample(),items:[]}));
  assert.equal(money('0.29'),29);
});
test('PromptPay encodes telephone, exact amount and CRC',()=>{
  assert.equal(crc16('123456789'),'29B1');
  const payload=promptPayPayload('0812345678',31125);
  assert.ok(payload.includes('01130066812345678'));
  assert.ok(payload.includes('5406311.25'));
  assert.equal(payload.slice(-4),crc16(payload.slice(0,-4)));
  assert.throws(()=>promptPayPayload('123',100));
  assert.throws(()=>promptPayPayload('0812345678',0));
});
test('rejects a non-image disguised as a slip',()=>{
  assert.throws(()=>imageType(new TextEncoder().encode('<html>not a png</html>')));
});
test('missing shop or admin configuration fails closed',async()=>{
  const request=path=>new Request('https://shop.test'+path,{method:'POST',headers:{Origin:'https://shop.test'}});
  const env={};
  assert.equal((await worker.fetch(request('/api/orders'),env)).status,503);
  assert.equal((await worker.fetch(request('/api/admin/login'),env)).status,503);
  assert.equal((await worker.fetch(new Request('https://shop.test/api/admin/orders'),{ADMIN_PASSWORD:'1234'})).status,503);
});
