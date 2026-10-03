// Minimal Cloudflare D1 stand-in on Node's built-in SQLite, for tests only.
// Runs the real migrations, so CHECKs, FKs, triggers and SQL behave like D1.
import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';

class Statement {
  constructor(db, sql, params = []) { this.db = db; this.sql = sql; this.params = params; }
  bind(...params) {
    for (const p of params) if (p === undefined || typeof p === 'boolean') throw new TypeError(`D1_TYPE_ERROR: unsupported bind value ${p}`);
    return new Statement(this.db, this.sql, params);
  }
  exec() {
    const stmt = this.db.prepare(this.sql);
    const results = stmt.all(...this.params);
    const changes = this.db.prepare('SELECT changes() AS c').get().c;
    return { success: true, results, meta: { changes } };
  }
  async first(column) { const row = this.exec().results[0] ?? null; return column && row ? row[column] : row; }
  async all() { return this.exec(); }
  async run() { return this.exec(); }
}

export class FakeD1 {
  constructor() {
    this.db = new DatabaseSync(':memory:');
    this.db.exec('PRAGMA foreign_keys=ON');
    for (const f of ['0001_initial.sql', '0002_payment_system.sql']) this.db.exec(readFileSync(new URL(`../../migrations/${f}`, import.meta.url), 'utf8'));
  }
  prepare(sql) { return new Statement(this.db, sql); }
  // D1 batches run as one transaction: any failure rolls back every statement.
  async batch(statements) {
    this.db.exec('BEGIN');
    try { const out = statements.map(s => s.exec()); this.db.exec('COMMIT'); return out; }
    catch (e) { this.db.exec('ROLLBACK'); throw e; }
  }
}

export function makeEnv(overrides = {}) {
  return {
    DB: new FakeD1(),
    ASSETS: { fetch: async req => new Response(`asset:${new URL(req.url).pathname}`, { headers: { 'Content-Type': 'text/html' } }) },
    SHOP_NAME: 'ทดสอบ', PROMPTPAY_ID: '0812345678', ACCOUNT_NAME: 'บัญชีทดสอบ', BANK_NAME: 'ธนาคารทดสอบ', ACCOUNT_NO: '123',
    LINE_OA_ID: '@653ercqc', APP_ENV: 'test', ADMIN_PASSWORD: 'local-test-password-only-1234',
    ...overrides
  };
}
