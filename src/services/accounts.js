// Expenses and the profit summary (income − expenses) by day / month / year, all in Thai dates.
import { AppError } from '../lib/http.js';
import { toSatang } from '../lib/money.js';
import { text } from '../lib/validate.js';
import { bangkokDate, isYmd, nowIso } from '../lib/time.js';

export const EXPENSE_CATEGORIES = ['วัสดุ / หมึก / ไวนิล', 'ค่าเช่า', 'ค่าไฟ / น้ำ / เน็ต', 'ค่าแรง', 'ค่าขนส่ง', 'ซ่อม / อุปกรณ์', 'โฆษณา / การตลาด', 'อื่นๆ'];

const pad = n => String(n).padStart(2, '0');
const daysIn = (y, m) => new Date(Date.UTC(y, m, 0)).getUTCDate();

export function validateExpense(body) {
  if (!body || typeof body !== 'object') throw new AppError('ข้อมูลไม่ถูกต้อง');
  const today = bangkokDate().ymd;
  if (!isYmd(body.date) || body.date > today) throw new AppError('วันที่จ่ายไม่ถูกต้อง (ต้องไม่เกินวันนี้)');
  if (!EXPENSE_CATEGORIES.includes(body.category)) throw new AppError('กรุณาเลือกหมวดรายจ่าย');
  return {
    date: body.date, category: body.category,
    description: text(body.description, 'รายการ', 300, { required: true }),
    vendor: text(body.vendor, 'จ่ายให้ใคร', 200),
    amount: toSatang(body.amount, 'จำนวนเงิน')
  };
}

export async function addExpense(env, e) {
  const now = nowIso();
  const row = await env.DB.prepare(`INSERT INTO expenses(expense_date,category,description,vendor,amount_satang,created_at,updated_at)
    VALUES(?,?,?,?,?,?,?) RETURNING *`).bind(e.date, e.category, e.description, e.vendor, e.amount, now, now).first();
  return expenseOut(row);
}

export async function deleteExpense(env, id) {
  const row = await env.DB.prepare('DELETE FROM expenses WHERE id=? RETURNING id').bind(id).first();
  if (!row) throw new AppError('ไม่พบรายการรายจ่าย', 404);
  return { ok: true };
}

const expenseOut = r => ({ id: r.id, date: r.expense_date, category: r.category, description: r.description, vendor: r.vendor, amountSatang: r.amount_satang });

// view=day   → every day of month (YYYY-MM)
// view=month → every month of year (YYYY)
// view=year  → the 5 years up to year (YYYY)
export function summaryRange(view, period) {
  const now = bangkokDate().ymd;
  if (view === 'day') {
    const p = period || now.slice(0, 7);
    if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(p)) throw new AppError('เดือนไม่ถูกต้อง');
    const y = +p.slice(0, 4), m = +p.slice(5, 7);
    const keys = Array.from({ length: daysIn(y, m) }, (_, i) => `${p}-${pad(i + 1)}`);
    return { view, period: p, keyLen: 10, from: keys[0], to: keys.at(-1), keys };
  }
  if (view === 'month') {
    const p = period || now.slice(0, 4);
    if (!/^\d{4}$/.test(p)) throw new AppError('ปีไม่ถูกต้อง');
    const keys = Array.from({ length: 12 }, (_, i) => `${p}-${pad(i + 1)}`);
    return { view, period: p, keyLen: 7, from: `${p}-01-01`, to: `${p}-12-31`, keys };
  }
  if (view === 'year') {
    const p = period || now.slice(0, 4);
    if (!/^\d{4}$/.test(p)) throw new AppError('ปีไม่ถูกต้อง');
    const keys = Array.from({ length: 5 }, (_, i) => String(+p - 4 + i));
    return { view, period: p, keyLen: 4, from: `${keys[0]}-01-01`, to: `${p}-12-31`, keys };
  }
  throw new AppError('มุมมองไม่ถูกต้อง');
}

export async function profitSummary(env, view, period) {
  const r = summaryRange(view, period);
  const db = env.DB;
  const [inc, exp, cats, list] = await db.batch([
    db.prepare(`SELECT substr(received_date,1,?) AS k, sum(amount_satang) AS s, count(*) AS n FROM income WHERE received_date BETWEEN ? AND ? GROUP BY k`).bind(r.keyLen, r.from, r.to),
    db.prepare(`SELECT substr(expense_date,1,?) AS k, sum(amount_satang) AS s, count(*) AS n FROM expenses WHERE expense_date BETWEEN ? AND ? GROUP BY k`).bind(r.keyLen, r.from, r.to),
    db.prepare(`SELECT category, sum(amount_satang) AS s, count(*) AS n FROM expenses WHERE expense_date BETWEEN ? AND ? GROUP BY category ORDER BY s DESC`).bind(r.from, r.to),
    db.prepare(`SELECT * FROM expenses WHERE expense_date BETWEEN ? AND ? ORDER BY expense_date DESC, id DESC LIMIT 200`).bind(r.from, r.to)
  ]);
  const im = Object.fromEntries(inc.results.map(x => [x.k, x])), em = Object.fromEntries(exp.results.map(x => [x.k, x]));
  const buckets = r.keys.map(k => {
    const income = im[k]?.s || 0, expense = em[k]?.s || 0;
    return { key: k, incomeSatang: income, expenseSatang: expense, profitSatang: income - expense, incomeCount: im[k]?.n || 0, expenseCount: em[k]?.n || 0 };
  });
  const sum = f => buckets.reduce((a, b) => a + b[f], 0);
  return {
    view: r.view, period: r.period, from: r.from, to: r.to, today: bangkokDate().ymd,
    totals: { incomeSatang: sum('incomeSatang'), expenseSatang: sum('expenseSatang'), profitSatang: sum('profitSatang'), incomeCount: sum('incomeCount'), expenseCount: sum('expenseCount') },
    buckets,
    expenseByCategory: cats.results.map(c => ({ category: c.category, totalSatang: c.s, count: c.n })),
    expenses: list.results.map(expenseOut),
    categories: EXPENSE_CATEGORIES
  };
}
