// Isolated, ephemeral D1/R2 preview. Never loads production bindings or secrets.
import { readFile } from 'node:fs/promises';
import { build } from 'esbuild';
import { Miniflare } from 'miniflare';
await import('./build.mjs');
const bundle=await build({entryPoints:['src/index.js'],bundle:true,write:false,format:'esm',platform:'browser'});
const assets={'/':['public/index.html','text/html; charset=utf-8'],'/styles.css':['public/styles.css','text/css'],'/app.js':['public/app.js','text/javascript'],'/shop-logo.png':['public/shop-logo.png','image/png']};
const mf=new Miniflare({host:'127.0.0.1',port:8788,modules:true,script:bundle.outputFiles[0].text,compatibilityDate:'2026-06-11',d1Databases:['DB'],r2Buckets:['SLIPS'],bindings:{SHOP_NAME:'อองตองมีเดีย · PREVIEW',ADMIN_PASSWORD:'local-preview-admin-only',PROMPTPAY_ID:'',ACCOUNT_NAME:''},serviceBindings:{ASSETS:async request=>{
  const asset=assets[new URL(request.url).pathname];
  return asset?new Response(await readFile(asset[0]),{headers:{'Content-Type':asset[1]}}):new Response('Not found',{status:404});
}}});
const db=await mf.getD1Database('DB');
for(const file of ['0001_initial.sql','0002_accounting.sql'])await db.exec((await readFile(`migrations/${file}`,'utf8')).replace(/^--.*$/gm,'').replace(/\n/g,' '));
const now=new Date().toISOString(),id='OTM-00000000-0000-4000-8000-000000000001';
await db.prepare(`INSERT INTO orders (id,request_key,request_hash,created_at,customer,phone,contact,items_json,subtotal_satang,shipping_satang,total_satang,note,slip_key,status) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).bind(id,'preview','preview',now,'ลูกค้าทดสอบ','0800000000','',JSON.stringify([{name:'งานพิมพ์ตัวอย่าง',priceSatang:25000,qty:1}]),25000,0,25000,'ข้อมูลจำลองใน D1 local','preview/slip','รอตรวจสอบการชำระเงิน').run();
const bucket=await mf.getR2Bucket('SLIPS');
await bucket.put('preview/slip',await readFile('public/shop-logo.png'),{httpMetadata:{contentType:'image/png'}});
await db.prepare(`INSERT INTO payments (id,order_id,amount_satang,method,slip_key,status,created_at) VALUES (?,?,25000,'test','preview/slip','pending',?)`).bind('PAY-preview',id,now).run();
console.log(`Preview: ${await mf.ready}\nLocal-only admin password: local-preview-admin-only\nPreview data is discarded on exit; real payments disabled.`);
for(const signal of ['SIGINT','SIGTERM'])process.on(signal,async()=>{await mf.dispose();process.exit(0);});
