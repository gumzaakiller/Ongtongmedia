CREATE TABLE orders (
  id TEXT PRIMARY KEY,
  request_key TEXT NOT NULL UNIQUE,
  request_hash TEXT NOT NULL,
  created_at TEXT NOT NULL,
  customer TEXT NOT NULL,
  phone TEXT NOT NULL,
  contact TEXT NOT NULL,
  items_json TEXT NOT NULL,
  subtotal_satang INTEGER NOT NULL CHECK(subtotal_satang > 0),
  shipping_satang INTEGER NOT NULL CHECK(shipping_satang >= 0),
  total_satang INTEGER NOT NULL CHECK(total_satang = subtotal_satang + shipping_satang),
  note TEXT NOT NULL,
  slip_key TEXT,
  status TEXT NOT NULL CHECK(status IN ('รอชำระเงิน','รอตรวจสอบการชำระเงิน','ชำระแล้ว','กำลังดำเนินการ','เสร็จสิ้น','ยกเลิก')),
  version INTEGER NOT NULL DEFAULT 1
);
CREATE INDEX orders_created ON orders(created_at DESC, id DESC);
CREATE TABLE sessions (token_hash TEXT PRIMARY KEY, expires_at INTEGER NOT NULL, password_version TEXT NOT NULL);
CREATE INDEX sessions_expiry ON sessions(expires_at);
CREATE TABLE rate_limits (key TEXT PRIMARY KEY, count INTEGER NOT NULL, expires_at INTEGER NOT NULL);
CREATE INDEX rate_limits_expiry ON rate_limits(expires_at);
