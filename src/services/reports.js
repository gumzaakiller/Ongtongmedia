import { AppError } from '../lib/http.js';
import { bangkokDate, bangkokDayRange, isYmd } from '../lib/time.js';

const addDays = (ymd, n) => new Date(Date.parse(ymd + 'T00:00:00Z') + n * 86400000).toISOString().slice(0, 10);

export async function dashboard(env) {
  const db = env.DB;
  const today = bangkokDate().ymd;
  const monthStart = today.slice(0, 8) + '01';
  const weekStart = addDays(today, -6);
  const [dayStart, dayEnd] = bangkokDayRange(today);
  const [created, received, month, byStatus, week, awaiting] = await db.batch([
    db.prepare("SELECT count(*) AS n, coalesce(sum(total_satang),0) AS s FROM orders WHERE created_at>=? AND created_at<? AND status<>'cancelled'").bind(dayStart, dayEnd),
    db.prepare('SELECT count(*) AS n, coalesce(sum(amount_satang),0) AS s FROM income WHERE received_date=?').bind(today),
    db.prepare('SELECT count(*) AS n, coalesce(sum(amount_satang),0) AS s FROM income WHERE received_date>=? AND received_date<=?').bind(monthStart, today),
    db.prepare("SELECT status, count(*) AS n, coalesce(sum(total_satang),0) AS s FROM orders WHERE status IN ('pending','awaiting_verification','paid','processing') GROUP BY status"),
    db.prepare('SELECT received_date AS d, sum(amount_satang) AS s FROM income WHERE received_date>=? AND received_date<=? GROUP BY received_date').bind(weekStart, today),
    db.prepare(`SELECT o.order_no,o.title,o.total_satang,o.updated_at,c.name AS customer_name FROM orders o JOIN customers c ON c.id=o.customer_id
      WHERE o.status='awaiting_verification' ORDER BY o.updated_at LIMIT 10`)
  ]);
  const status = Object.fromEntries(byStatus.results.map(r => [r.status, { count: r.n, totalSatang: r.s }]));
  const zero = { count: 0, totalSatang: 0 };
  const weekMap = Object.fromEntries(week.results.map(r => [r.d, r.s]));
  return {
    today,
    ordersToday: { count: created.results[0].n, totalSatang: created.results[0].s },
    receivedToday: { count: received.results[0].n, totalSatang: received.results[0].s },
    receivedThisMonth: { count: month.results[0].n, totalSatang: month.results[0].s, from: monthStart },
    awaitingVerification: status.awaiting_verification || zero,
    unpaid: status.pending || zero,
    inProgress: { count: (status.paid?.count || 0) + (status.processing?.count || 0) },
    last7Days: Array.from({ length: 7 }, (_, i) => { const d = addDays(weekStart, i); return { date: d, totalSatang: weekMap[d] || 0 }; }),
    awaitingList: awaiting.results.map(r => ({ orderNo: r.order_no, title: r.title, totalSatang: r.total_satang, customerName: r.customer_name, since: r.updated_at }))
  };
}

// Income filters: month=YYYY-MM, or from/to=YYYY-MM-DD (Thai dates), q = order number / customer name / phone.
export function parseIncomeFilters(sp) {
  let from = sp.get('from') || '', to = sp.get('to') || '';
  const month = sp.get('month') || '';
  if (month) {
    if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(month)) throw new AppError('เดือนไม่ถูกต้อง');
    from = month + '-01';
    to = addDays(new Date(Date.UTC(+month.slice(0, 4), +month.slice(5), 1)).toISOString().slice(0, 10), -1);
  }
  if (from && !isYmd(from)) throw new AppError('วันที่เริ่มต้นไม่ถูกต้อง');
  if (to && !isYmd(to)) throw new AppError('วันที่สิ้นสุดไม่ถูกต้อง');
  if (from && to && from > to) throw new AppError('วันที่เริ่มต้นต้องไม่เกินวันที่สิ้นสุด');
  const q = (sp.get('q') || '').trim();
  if (q.length > 50) throw new AppError('คำค้นหายาวเกินไป');
  return { from, to, q };
}

function incomeWhere({ from, to, q }) {
  const where = []; const params = [];
  if (from) { where.push('i.received_date>=?'); params.push(from); }
  if (to) { where.push('i.received_date<=?'); params.push(to); }
  if (q) {
    where.push('(instr(o.order_no, ?)>0 OR instr(c.name, ?)>0 OR instr(c.phone, ?)>0)');
    const term = q.toUpperCase().startsWith('ONT') ? q.toUpperCase() : q;
    params.push(term, q, q);
  }
  return { sql: where.length ? 'WHERE ' + where.join(' AND ') : '', params };
}
const INCOME_FROM = 'FROM income i JOIN orders o ON o.id=i.order_id JOIN customers c ON c.id=i.customer_id JOIN payments p ON p.id=i.payment_id';
const incomeRow = r => ({ id: r.id, receivedDate: r.received_date, orderNo: r.order_no, title: r.title, customerName: r.customer_name, customerPhone: r.customer_phone, method: r.method, amountSatang: r.amount_satang, note: r.note, createdAt: r.created_at });
const SELECT_COLS = 'SELECT i.id,i.received_date,i.amount_satang,i.note,i.created_at,o.order_no,o.title,c.name AS customer_name,c.phone AS customer_phone,p.method';

export async function listIncome(env, filters, { cursor = null, limit = 50 } = {}) {
  const db = env.DB; const w = incomeWhere(filters);
  // Keyset paging on (received_date DESC, id DESC).
  let page = w.sql, pageParams = [...w.params];
  if (cursor) {
    const m = /^(\d{4}-\d{2}-\d{2})_(\d+)$/.exec(cursor);
    if (!m) throw new AppError('หน้ารายการไม่ถูกต้อง');
    page += (page ? ' AND ' : 'WHERE ') + '(i.received_date<? OR (i.received_date=? AND i.id<?))';
    pageParams.push(m[1], m[1], Number(m[2]));
  }
  const [rows, totals] = await db.batch([
    db.prepare(`${SELECT_COLS} ${INCOME_FROM} ${page} ORDER BY i.received_date DESC, i.id DESC LIMIT ?`).bind(...pageParams, limit + 1),
    db.prepare(`SELECT count(*) AS n, coalesce(sum(i.amount_satang),0) AS s ${INCOME_FROM} ${w.sql}`).bind(...w.params)
  ]);
  const list = rows.results.slice(0, limit); const last = list.at(-1);
  return {
    income: list.map(incomeRow),
    totals: { count: totals.results[0].n, totalSatang: totals.results[0].s },
    nextCursor: rows.results.length > limit ? `${last.received_date}_${last.id}` : null
  };
}

const METHOD_TH = { promptpay: 'พร้อมเพย์', bank_transfer: 'โอนเข้าบัญชี', cash: 'เงินสด', other: 'อื่นๆ' };
const csvCell = v => {
  let s = String(v ?? '');
  if (/^[=+\-@\t\r]/.test(s)) s = "'" + s; // stop spreadsheet formula injection
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};
export async function incomeCsv(env, filters) {
  const w = incomeWhere(filters);
  const { results } = await env.DB.prepare(`${SELECT_COLS} ${INCOME_FROM} ${w.sql} ORDER BY i.received_date, i.id LIMIT 20000`).bind(...w.params).all();
  const lines = [['วันที่รับเงิน', 'เลขออเดอร์', 'ลูกค้า', 'เบอร์โทร', 'รายการ', 'ช่องทาง', 'จำนวนเงิน (บาท)', 'หมายเหตุ'].map(csvCell).join(',')];
  let total = 0;
  for (const r of results) {
    total += r.amount_satang;
    lines.push([r.received_date, r.order_no, r.customer_name, r.customer_phone, r.title, METHOD_TH[r.method] || r.method, (r.amount_satang / 100).toFixed(2), r.note].map(csvCell).join(','));
  }
  lines.push(['', '', '', '', '', 'รวม', (total / 100).toFixed(2), ''].map(csvCell).join(','));
  return '﻿' + lines.join('\r\n') + '\r\n'; // BOM so Excel reads Thai correctly
}
