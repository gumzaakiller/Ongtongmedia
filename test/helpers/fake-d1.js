// Minimal Cloudflare D1 stand-in on Node's built-in SQLite, for tests only.
// Runs the real migrations, so CHECKs, FKs, triggers and SQL behave like D1.
import { readFileSync, readdirSync } from 'node:fs';
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
    const dir = new URL('../../migrations/', import.meta.url);
    for (const f of readdirSync(dir).filter(f => f.endsWith('.sql')).sort()) this.db.exec(readFileSync(new URL(f, dir), 'utf8'));
  }
  prepare(sql) { return new Statement(this.db, sql); }
  // D1 batches run as one transaction: any failure rolls back every statement.
  async batch(statements) {
    this.db.exec('BEGIN');
    try { const out = statements.map(s => s.exec()); this.db.exec('COMMIT'); return out; }
    catch (e) { this.db.exec('ROLLBACK'); throw e; }
  }
}

// In-memory R2 bucket with the subset of the API the Worker uses.
export class FakeR2 {
  constructor() { this.objects = new Map(); }
  async put(key, value, opts = {}) { this.objects.set(key, { bytes: new Uint8Array(value), httpMetadata: opts.httpMetadata || {}, customMetadata: opts.customMetadata || {} }); return { key }; }
  async get(key) { const o = this.objects.get(key); return o ? { body: new Blob([o.bytes]).stream(), httpMetadata: o.httpMetadata, customMetadata: o.customMetadata } : null; }
  async delete(key) { this.objects.delete(key); }
}

export function makeEnv(overrides = {}) {
  return {
    DB: new FakeD1(),
    SLIPS: new FakeR2(),
    ASSETS: { fetch: async req => new Response(`asset:${new URL(req.url).pathname}`, { headers: { 'Content-Type': 'text/html' } }) },
    SHOP_NAME: 'ทดสอบ', PROMPTPAY_ID: '0812345678', ACCOUNT_NAME: 'บัญชีทดสอบ', BANK_NAME: 'ธนาคารทดสอบ', ACCOUNT_NO: '123',
    LINE_OA_ID: '@653ercqc', APP_ENV: 'test', ADMIN_PASSWORD: 'local-test-password-only-1234',
    ...overrides
  };
}
