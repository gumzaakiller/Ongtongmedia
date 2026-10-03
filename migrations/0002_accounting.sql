-- Matches the existing production schema. Additive bootstrap for fresh databases.
-- Never drops tables or rewrites existing rows.
CREATE TABLE IF NOT EXISTS expenses (
  id TEXT PRIMARY KEY,
  amount_satang INTEGER NOT NULL CHECK(amount_satang > 0),
  category TEXT NOT NULL,
  description TEXT NOT NULL,
  expense_date TEXT NOT NULL,
  receipt_key TEXT,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS payments (
  id TEXT PRIMARY KEY,
  order_id TEXT NOT NULL,
  amount_satang INTEGER NOT NULL CHECK(amount_satang > 0),
  method TEXT NOT NULL,
  slip_key TEXT,
  status TEXT NOT NULL DEFAULT 'pending',
  paid_at TEXT,
  created_at TEXT NOT NULL,
  UNIQUE(order_id),
  FOREIGN KEY(order_id) REFERENCES orders(id)
);
CREATE TABLE IF NOT EXISTS income (
  id TEXT PRIMARY KEY,
  order_id TEXT NOT NULL UNIQUE,
  amount_satang INTEGER NOT NULL CHECK(amount_satang > 0),
  category TEXT NOT NULL DEFAULT 'sales',
  received_at TEXT NOT NULL,
  note TEXT,
  created_at TEXT NOT NULL,
  FOREIGN KEY(order_id) REFERENCES orders(id)
);
CREATE INDEX IF NOT EXISTS expenses_expense_date ON expenses(expense_date);
