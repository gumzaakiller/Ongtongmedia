import { AppError, money } from './shared.js';

const json = data => Response.json(data);
const paidOrderStatuses = ['ชำระแล้ว', 'กำลังดำเนินการ', 'เสร็จสิ้น'];

export async function createPayment(db, orderId) {
  const order = await db.prepare('SELECT * FROM orders WHERE id=?').bind(orderId).first();
  if (!order) throw new AppError('ไม่พบคำสั่งซื้อ', 404);
  if (order.status === 'ยกเลิก') throw new AppError('คำสั่งซื้อถูกยกเลิก', 409);
  // The order is the only authority for amount and slip; repeated requests reuse it.
  await db.prepare(`INSERT INTO payments (id,order_id,amount_satang,method,slip_key,status,created_at)
    SELECT ?,id,total_satang,'PromptPay/โอนเงิน',slip_key,'pending',? FROM orders
    WHERE id=? AND status!='ยกเลิก' ON CONFLICT(order_id) DO NOTHING`)
    .bind(`PAY-${crypto.randomUUID()}`, new Date().toISOString(), orderId).run();
  const payment = await db.prepare('SELECT * FROM payments WHERE order_id=?').bind(orderId).first();
  if (!payment) throw new AppError('คำสั่งซื้อถูกแก้ไข กรุณาโหลดใหม่', 409);
  return payment;
}

export async function confirmPayment(db, id) {
  const payment = await db.prepare(`SELECT p.*,o.status order_status,o.total_satang
    FROM payments p JOIN orders o ON o.id=p.order_id WHERE p.id=?`).bind(id).first();
  if (!payment) throw new AppError('ไม่พบรายการชำระเงิน', 404);
  if (!['pending','paid'].includes(payment.status) || payment.order_status === 'ยกเลิก')
    throw new AppError('ไม่สามารถยืนยันรายการนี้ได้', 409);
  if (payment.amount_satang !== payment.total_satang) throw new AppError('ยอดชำระไม่ตรงกับคำสั่งซื้อ', 409);
  const now = new Date().toISOString();
  // D1 batch is atomic. All predicates are repeated inside the transaction to
  // protect against cancellation, concurrent confirmations and retries.
  const results = await db.batch([
    db.prepare(`UPDATE payments SET status='paid',paid_at=COALESCE(paid_at,?)
      WHERE id=? AND status IN ('pending','paid') AND EXISTS
      (SELECT 1 FROM orders WHERE id=payments.order_id AND status!='ยกเลิก' AND total_satang=payments.amount_satang)
      RETURNING *`).bind(now,id),
    db.prepare(`INSERT INTO income (id,order_id,amount_satang,category,received_at,note,created_at)
      SELECT ?,p.order_id,o.total_satang,'sales',p.paid_at,'ยืนยันการชำระจากคำสั่งซื้อ',?
      FROM payments p JOIN orders o ON o.id=p.order_id
      WHERE p.id=? AND p.status='paid' AND o.status!='ยกเลิก' AND p.amount_satang=o.total_satang
      ON CONFLICT(order_id) DO UPDATE SET amount_satang=
        CASE WHEN income.amount_satang=excluded.amount_satang THEN income.amount_satang ELSE NULL END`)
      .bind(`INC-${crypto.randomUUID()}`,now,id),
    db.prepare(`UPDATE orders SET status='ชำระแล้ว',version=version+1
      WHERE status IN ('รอชำระเงิน','รอตรวจสอบการชำระเงิน') AND id IN
      (SELECT order_id FROM payments WHERE id=? AND status='paid' AND amount_satang=orders.total_satang)`)
      .bind(id)
  ]);
  const confirmed = results[0].results[0];
  if (!confirmed) throw new AppError('รายการถูกแก้ไข กรุณาโหลดใหม่',409);
  return confirmed;
}

export function bangkokPeriods(now = new Date()) {
  const date = new Date(now.getTime() + 7 * 3600000).toISOString().slice(0,10);
  const month = date.slice(0,7);
  const start = new Date(`${month}-01T00:00:00+07:00`);
  const [year,monthNumber]=month.split('-').map(Number);
  const next = new Date(Date.UTC(year,monthNumber,1)-7*3600000);
  const today = new Date(`${date}T00:00:00+07:00`);
  return { date,month,today:today.toISOString(),tomorrow:new Date(today.getTime()+86400000).toISOString(),start:start.toISOString(),end:next.toISOString(),nextMonth:new Date(next.getTime()+7*3600000).toISOString().slice(0,10) };
}

async function dashboard(db) {
  const p = bangkokPeriods();
  const rows = await db.batch([
    db.prepare(`SELECT COALESCE(SUM(total_satang),0) amount FROM orders WHERE created_at>=? AND created_at<? AND status!='ยกเลิก'`).bind(p.today,p.tomorrow),
    db.prepare(`SELECT COALESCE(SUM(amount_satang),0) amount FROM payments WHERE status='paid'`),
    db.prepare(`SELECT COUNT(*) count,COALESCE(SUM(p.amount_satang),0) amount FROM payments p JOIN orders o ON o.id=p.order_id WHERE p.status='pending' AND o.status!='ยกเลิก'`),
    db.prepare(`SELECT COALESCE(SUM(amount_satang),0) amount FROM income WHERE received_at>=? AND received_at<?`).bind(p.start,p.end),
    db.prepare(`SELECT COALESCE(SUM(amount_satang),0) amount FROM expenses WHERE expense_date>=? AND expense_date<?`).bind(p.month+'-01',p.nextMonth)
  ]);
  const [sales,paid,pending,income,expenses] = rows.map(r=>r.results[0]);
  return { timezone:'Asia/Bangkok',date:p.date,month:p.month,salesTodaySatang:sales.amount,paidSatang:paid.amount,pendingCount:pending.count,pendingSatang:pending.amount,incomeMonthSatang:income.amount,expensesMonthSatang:expenses.amount,netProfitSatang:income.amount-expenses.amount };
}

async function list(db, url, type) {
  const offset = Number(url.searchParams.get('offset') || 0);
  if (!Number.isSafeInteger(offset) || offset<0 || offset>1000000) throw new AppError('หน้ารายการไม่ถูกต้อง');
  // Queries are fixed, never interpolate table names or values from the request.
  const queries = {
    income:'SELECT * FROM income ORDER BY received_at DESC,id DESC LIMIT 51 OFFSET ?',
    expenses:'SELECT * FROM expenses ORDER BY expense_date DESC,id DESC LIMIT 51 OFFSET ?',
    pending:`SELECT p.*,o.customer FROM payments p JOIN orders o ON o.id=p.order_id WHERE p.status='pending' AND o.status!='ยกเลิก' ORDER BY p.created_at DESC,p.id DESC LIMIT 51 OFFSET ?`
  };
  const { results } = await db.prepare(queries[type]).bind(offset).all();
  return { items:results.slice(0,50).map(({slip_key,receipt_key,...row})=>({...row,hasSlip:!!slip_key})),nextOffset:results.length>50?offset+50:null };
}

export async function accountingRoute(request, env, readJson) {
  const url = new URL(request.url), path = url.pathname, db = env.DB;
  if (path === '/api/admin/dashboard' && request.method==='GET') return json(await dashboard(db));
  for (const name of ['income','expenses']) {
    if (path===`/api/admin/${name}` && request.method==='GET') return json(await list(db,url,name));
  }
  if (path==='/api/admin/payments/pending' && request.method==='GET') return json(await list(db,url,'pending'));
  if (path==='/api/admin/payments' && request.method==='POST') {
    const body = await readJson(request);
    if (typeof body?.orderId!=='string' || body.orderId.length>100) throw new AppError('เลขคำสั่งซื้อไม่ถูกต้อง');
    return json(await createPayment(db,body.orderId));
  }
  const confirm = path.match(/^\/api\/admin\/payments\/([a-zA-Z0-9-]{1,100})\/confirm$/);
  if (confirm && request.method==='POST') return json(await confirmPayment(db,confirm[1]));
  const slip = path.match(/^\/api\/admin\/payments\/([a-zA-Z0-9-]{1,100})\/slip$/);
  if (slip && request.method==='GET') {
    const payment=await db.prepare('SELECT slip_key FROM payments WHERE id=?').bind(slip[1]).first();
    if(!payment?.slip_key)throw new AppError('ไม่พบสลิป',404);
    const object=await env.SLIPS.get(payment.slip_key);
    if(!object)throw new AppError('ไม่พบไฟล์สลิป',404);
    return new Response(object.body,{headers:{'Content-Type':object.httpMetadata?.contentType || 'application/octet-stream','Content-Disposition':'inline'}});
  }
  if (path==='/api/admin/expenses' && request.method==='POST') {
    const body = await readJson(request);
    const amount = money(body?.amount,'รายจ่าย');
    if (!amount || typeof body?.category!=='string' || !body.category.trim() || body.category.length>100 ||
      typeof body.description!=='string' || !body.description.trim() || body.description.length>1000 ||
      !/^\d{4}-\d{2}-\d{2}$/.test(body.expenseDate || '') || !Number.isFinite(Date.parse(body.expenseDate)) ||
      new Date(body.expenseDate).toISOString().slice(0,10)!==body.expenseDate) throw new AppError('ข้อมูลรายจ่ายไม่ถูกต้อง');
    // Client-generated stable ID makes retries safe without changing production schema.
    if (!/^[a-f0-9-]{36}$/i.test(body.requestId || '')) throw new AppError('รหัสคำขอไม่ถูกต้อง');
    const id=`EXP-${body.requestId}`;
    await db.prepare(`INSERT INTO expenses (id,amount_satang,category,description,expense_date,created_at)
      VALUES (?,?,?,?,?,?) ON CONFLICT(id) DO NOTHING`).bind(id,amount,body.category.trim(),body.description.trim(),body.expenseDate,new Date().toISOString()).run();
    const row=await db.prepare('SELECT * FROM expenses WHERE id=?').bind(id).first();
    if (row.amount_satang!==amount || row.category!==body.category.trim() || row.description!==body.description.trim() || row.expense_date!==body.expenseDate)
      throw new AppError('ข้อมูลเปลี่ยนระหว่างส่ง กรุณาโหลดใหม่',409);
    return json(row);
  }
  return null;
}

export { paidOrderStatuses };
