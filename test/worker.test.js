import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { build } from 'esbuild';
import { Miniflare } from 'miniflare';
test('Cloudflare D1 + R2 order and admin integration',async t=>{
  const bundle=await build({entryPoints:['src/index.js'],bundle:true,write:false,format:'esm',platform:'browser'});
  const config=JSON.parse(await readFile('wrangler.jsonc','utf8'));
  const mf=new Miniflare({modules:true,script:bundle.outputFiles[0].text,compatibilityDate:config.compatibility_date,d1Databases:['DB'],r2Buckets:['SLIPS'],bindings:{SHOP_NAME:'Test shop',PROMPTPAY_ID:'0812345678',ACCOUNT_NAME:'Local test only',ADMIN_PASSWORD:'local-integration-test-password-only'}});
  t.after(()=>mf.dispose());
  const db=await mf.getD1Database('DB');
  await db.exec((await readFile('migrations/0001_initial.sql','utf8')).replace(/\n/g,' '));
  const request=(path,init={})=>mf.dispatchFetch('https://shop.test'+path,{...init,headers:{Origin:'https://shop.test',...init.headers}});
  const payload={customer:'ทดสอบ <img src=x>',phone:'0812345678',contact:'LINE test',items:[{name:'สินค้า',price:'100.25',qty:2}],shipping:'10.50',total:1,note:'=1+1'};
  const png=Uint8Array.from(Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=','base64'));
  const submit=async(key,data=payload,slip=png)=>{
    const form=new FormData();form.set('order',JSON.stringify(data));if(slip)form.set('slip',new Blob([slip],{type:'image/png'}),'slip.png');
    // Serialize with Node's native Request: Miniflare uses a different FormData implementation.
    const encoded=new Request('https://shop.test/api/orders',{method:'POST',body:form});
    return request('/api/orders',{method:'POST',headers:{'Idempotency-Key':key,'Content-Type':encoded.headers.get('Content-Type')},body:await encoded.arrayBuffer()});
  };
  let order,cookie;
  await t.test('private admin and slips reject anonymous access',async()=>{
    assert.equal((await request('/api/admin/orders')).status,401);
    assert.equal((await request('/api/admin/orders/OTM-'+crypto.randomUUID()+'/slip')).status,401);
  });
  await t.test('cross-origin writes are rejected',async()=>{
    const response=await request('/api/admin/login',{method:'POST',headers:{Origin:'https://evil.test','Content-Type':'application/json'},body:'{}'});
    assert.equal(response.status,403);
  });
  await t.test('order upload stores recomputed totals and supports exact retries',async()=>{
    const key=crypto.randomUUID();const first=await submit(key);assert.equal(first.status,201);order=await first.json();
    assert.equal(order.totalSatang,21100);assert.equal(order.status,'รอตรวจสอบการชำระเงิน');
    const retry=await submit(key);assert.equal(retry.status,200);assert.deepEqual(await retry.json(),order);
    assert.equal((await submit(key,{...payload,shipping:0})).status,409);
    assert.equal((await db.prepare('SELECT COUNT(*) n FROM orders').first()).n,1);
  });
  await t.test('concurrent retries produce one order and one retained slip',async()=>{
    const key=crypto.randomUUID();const responses=await Promise.all([submit(key),submit(key)]);
    assert.ok(responses.every(r=>[200,201].includes(r.status)));
    const bodies=await Promise.all(responses.map(r=>r.json()));assert.equal(bodies[0].orderId,bodies[1].orderId);
    const bucket=await mf.getR2Bucket('SLIPS');assert.equal((await bucket.list()).objects.length,2);
  });
  await t.test('invalid rows and fake images are rejected',async()=>{
    assert.equal((await submit(crypto.randomUUID(),{...payload,items:[{name:'x',price:'NaN',qty:1}]})).status,400);
    assert.equal((await submit(crypto.randomUUID(),payload,new TextEncoder().encode('not an image'))).status,400);
  });
  await t.test('admin login issues protected cookie and can read private slip',async()=>{
    const login=await request('/api/admin/login',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({password:'local-integration-test-password-only'})});
    assert.equal(login.status,200);cookie=login.headers.get('set-cookie');assert.match(cookie,/HttpOnly/);assert.match(cookie,/Secure/);assert.match(cookie,/SameSite=Strict/);cookie=cookie.split(';')[0];
    const list=await request('/api/admin/orders',{headers:{Cookie:cookie}});assert.equal(list.status,200);assert.equal((await list.json()).orders.length,2);
    const slip=await request(`/api/admin/orders/${order.orderId}/slip`,{headers:{Cookie:cookie}});assert.equal(slip.status,200);assert.equal(slip.headers.get('Content-Type'),'image/png');assert.equal(slip.headers.get('Cache-Control'),'no-store');assert.deepEqual(new Uint8Array(await slip.arrayBuffer()),png);
  });
  await t.test('status updates reject stale versions',async()=>{
    const update=version=>request(`/api/admin/orders/${order.orderId}/status`,{method:'PATCH',headers:{Cookie:cookie,'Content-Type':'application/json'},body:JSON.stringify({status:'ชำระแล้ว',version})});
    const result=await update(1);assert.equal(result.status,200);assert.deepEqual(await result.json(),{status:'ชำระแล้ว',version:2});assert.equal((await update(1)).status,409);
  });
  await t.test('cursor pagination has no duplicate or missing orders',async()=>{
    const row=await db.prepare('SELECT * FROM orders LIMIT 1').first();
    await db.batch(Array.from({length:32},()=>db.prepare('INSERT INTO orders (id,request_key,request_hash,created_at,customer,phone,contact,items_json,subtotal_satang,shipping_satang,total_satang,note,status) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)').bind('OTM-'+crypto.randomUUID(),crypto.randomUUID(),'test',row.created_at,'Test','0812345678','',row.items_json,1,0,1,'','รอชำระเงิน')));
    const first=await(await request('/api/admin/orders',{headers:{Cookie:cookie}})).json();assert.equal(first.orders.length,30);assert.ok(first.nextCursor);
    const second=await(await request('/api/admin/orders?cursor='+encodeURIComponent(first.nextCursor),{headers:{Cookie:cookie}})).json();assert.equal(second.orders.length,4);assert.equal(second.nextCursor,null);assert.equal(new Set([...first.orders,...second.orders].map(o=>o.id)).size,34);
  });
  await t.test('logout revokes session',async()=>{
    assert.equal((await request('/api/admin/logout',{method:'POST',headers:{Cookie:cookie}})).status,200);
    assert.equal((await request('/api/admin/orders',{headers:{Cookie:cookie}})).status,401);
  });
  await t.test('login guessing is rate limited',async()=>{
    for(let i=0;i<5;i++)await request('/api/admin/login',{method:'POST',headers:{'Content-Type':'application/json'},body:'{"password":"wrong"}'});
    assert.equal((await request('/api/admin/login',{method:'POST',headers:{'Content-Type':'application/json'},body:'{"password":"wrong"}'})).status,429);
  });
});
