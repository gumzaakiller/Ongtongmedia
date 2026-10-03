// ตรวจ migration 0002 ด้วย SQLite ในตัวของ Node 22 (node:sqlite)
// จำลองทั้งฐานข้อมูล production เดิม (มีตารางที่สร้างด้วยมือ) และฐานข้อมูลใหม่
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';

const m1 = readFileSync('migrations/0001_initial.sql', 'utf8');
const m2 = readFileSync('migrations/0002_payment_system.sql', 'utf8');
const productionManual = `
CREATE TABLE expenses (id TEXT PRIMARY KEY, amount_satang INTEGER NOT NULL CHECK(amount_satang > 0), category TEXT NOT NULL, description TEXT NOT NULL, expense_date TEXT NOT NULL, receipt_key TEXT, created_at TEXT NOT NULL);
CREATE INDEX expenses_expense_date ON expenses(expense_date);
CREATE TABLE payments (id TEXT PRIMARY KEY, order_id TEXT NOT NULL, amount_satang INTEGER NOT NULL CHECK(amount_satang > 0), method TEXT NOT NULL, slip_key TEXT, status TEXT NOT NULL DEFAULT 'pending', paid_at TEXT, created_at TEXT NOT NULL, UNIQUE(order_id), FOREIGN KEY(order_id) REFERENCES orders(id));
CREATE TABLE income (id TEXT PRIMARY KEY, order_id TEXT NOT NULL UNIQUE, amount_satang INTEGER NOT NULL CHECK(amount_satang > 0), category TEXT NOT NULL DEFAULT 'sales', received_at TEXT NOT NULL, note TEXT, created_at TEXT NOT NULL, FOREIGN KEY(order_id) REFERENCES orders(id));
INSERT INTO orders VALUES ('OTM-a','k1','h','2026-10-03T01:49:46Z','x','0800000000','','[]',600,0,600,'',NULL,'รอชำระเงิน',1);`;

const NOW = '2026-10-03T09:00:00Z';
function open(withProductionTables) {
  const db = new DatabaseSync(':memory:');
  db.exec('PRAGMA foreign_keys=ON');
  db.exec(m1);
  if (withProductionTables) db.exec(productionManual);
  db.exec(m2);
  return db;
}
const rejects = (db, sql, params = [], pattern) => assert.throws(() => db.prepare(sql).run(...params), pattern);
const newOrder = (db, no, token, total = 150000) => db.prepare(
  'INSERT INTO orders(order_no,public_token,customer_id,title,subtotal_satang,total_satang,created_at,updated_at) VALUES(?,?,1,?,?,?,?,?)'
).run(no, token, 'งานพิมพ์', total, total, NOW, NOW);

for (const [label, withProd] of [['production-like database', true], ['fresh database', false]]) {
  test(`migration 0002 on ${label}`, async t => {
    const db = open(withProd);
    await t.test('keeps old data as legacy_* and passes integrity checks', () => {
      assert.equal(db.prepare('SELECT count(*) n FROM legacy_orders').get().n, withProd ? 1 : 0);
      assert.equal(db.prepare('PRAGMA integrity_check').get().integrity_check, 'ok');
      assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(), []);
      assert.match(db.prepare("SELECT sql FROM sqlite_master WHERE name='legacy_payments'").get().sql, /legacy_orders/);
    });

    db.prepare('INSERT INTO customers(name,created_at,updated_at) VALUES(?,?,?)').run('คุณเอ', NOW, NOW);
    newOrder(db, 'ONT-20261003-0001', 'A'.repeat(43));

    await t.test('order number, token and money rules', () => {
      for (const bad of ['ONT-2026103-0001', 'XNT-20261003-0001', 'ONT-2026100A-0001', 'ONT-20261003-00A1'])
        assert.throws(() => newOrder(db, bad, 'Z'.repeat(43)), /CHECK/);
      assert.throws(() => newOrder(db, 'ONT-20261003-0002', 'A'.repeat(43)), /UNIQUE/);
      assert.throws(() => newOrder(db, 'ONT-20261003-0003', 'short'), /CHECK/);
      rejects(db, 'INSERT INTO order_items(order_id,position,description,qty,unit_price_satang,amount_satang) VALUES(1,1,?,2,100,999)', ['x'], /CHECK/);
      rejects(db, "UPDATE orders SET status='paid' WHERE id=1", [], /CHECK/);
      rejects(db, "UPDATE orders SET status='ชำระแล้ว' WHERE id=1", [], /CHECK/);
    });

    await t.test('daily counter increments atomically', () => {
      const next = db.prepare("INSERT INTO order_counters(day,last_no) VALUES('20261003',1) ON CONFLICT(day) DO UPDATE SET last_no=last_no+1 RETURNING last_no");
      assert.deepEqual([1, 2, 3].map(() => next.get().last_no), [1, 2, 3]);
    });

    const pay = db.prepare('INSERT INTO payments(order_id,request_key,amount_satang,slip_sha256,submitted_at) VALUES(?,?,?,?,?)');
    await t.test('payment rules', () => {
      assert.throws(() => pay.run(1, 'r0', 1, 'h0', NOW), /amount_mismatch/);
      pay.run(1, 'r1', 150000, 'h1', NOW);
      assert.throws(() => pay.run(1, 'r2', 150000, 'h2', NOW), /UNIQUE/); // มีสลิปรอตรวจอยู่แล้ว
      rejects(db, 'UPDATE orders SET subtotal_satang=1,total_satang=1 WHERE id=1', [], /amount_locked/);
      rejects(db, "INSERT INTO income(order_id,payment_id,customer_id,amount_satang,received_date,created_at) VALUES(1,1,1,150000,'2026-10-03',?)", [NOW], /income_requires_verified_payment/);
    });

    const verify = () => {
      db.exec('BEGIN');
      try {
        db.prepare("UPDATE orders SET status='paid',paid_at=?,version=version+1,updated_at=? WHERE id=1 AND status IN ('pending','awaiting_verification')").run(NOW, NOW);
        db.prepare("UPDATE payments SET status='verified',reviewed_at=? WHERE id=1").run(NOW);
        db.prepare("INSERT INTO income(order_id,payment_id,customer_id,amount_satang,received_date,created_at) SELECT id,1,customer_id,total_satang,'2026-10-03',? FROM orders WHERE id=1 AND status='paid'").run(NOW);
        db.exec('COMMIT');
      } catch (e) { db.exec('ROLLBACK'); throw e; }
    };
    await t.test('verification records income exactly once', () => {
      verify();
      assert.throws(verify, /UNIQUE/);
      assert.equal(db.prepare('SELECT count(*) n FROM income').get().n, 1);
      assert.equal(db.prepare('SELECT amount_satang a FROM income').get().a, 150000);
      assert.throws(() => pay.run(1, 'r9', 150000, 'h9', NOW), /order_not_payable/);
      rejects(db, 'DELETE FROM orders WHERE id=1', [], /FOREIGN KEY/);
    });

    await t.test('accounting dates must be real dates', () => {
      const add = db.prepare("INSERT INTO expenses(expense_date,category,description,amount_satang,created_at,updated_at) VALUES(?,'วัสดุ','กระดาษ',100,?,?)");
      for (const bad of ['2026-13-01', '2026-02-30', '2026-1-01', '20261003']) assert.throws(() => add.run(bad, NOW, NOW), /CHECK/);
      add.run('2026-10-03', NOW, NOW);
    });
    db.close();
  });
}
