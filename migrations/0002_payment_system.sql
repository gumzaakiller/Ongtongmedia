-- 0002: ระบบเรียกเก็บเงิน/รายรับของอองตองมีเดีย
-- หมายเหตุ: D1 จำกัดความยาว pattern ของ GLOB/LIKE จึงตรวจรูปแบบด้วย length/substr แทน
-- เงินทุกช่องเป็น INTEGER หน่วยสตางค์ · เวลาเป็น ISO-8601 UTC · วันที่ทางบัญชี (YYYY-MM-DD) เป็นเวลาไทย
-- ข้อมูลเดิมไม่ถูกลบ: ตารางเดิมเปลี่ยนชื่อเป็น legacy_*

-- ---------------------------------------------------------------------------
-- 1) เก็บตารางเดิมเป็น legacy_*
--    payments/income/expenses บน production ถูกสร้างด้วยมือนอก migration
--    สร้างแบบ IF NOT EXISTS ก่อน เพื่อให้ฐานข้อมูลใหม่ (staging/local) มีโครงสร้างเท่ากัน แล้วจึงเปลี่ยนชื่อ
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS expenses (
  id TEXT PRIMARY KEY,
  amount_satang INTEGER NOT NULL CHECK(amount_satang > 0),
  category TEXT NOT NULL,
  description TEXT NOT NULL,
  expense_date TEXT NOT NULL,
  receipt_key TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS expenses_expense_date ON expenses(expense_date);
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

ALTER TABLE orders RENAME TO legacy_orders;
ALTER TABLE payments RENAME TO legacy_payments;
ALTER TABLE income RENAME TO legacy_income;
ALTER TABLE expenses RENAME TO legacy_expenses;

-- ---------------------------------------------------------------------------
-- 2) ตารางใหม่
-- ---------------------------------------------------------------------------
CREATE TABLE customers (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL CHECK(length(trim(name)) BETWEEN 1 AND 200),
  phone TEXT NOT NULL DEFAULT '',
  line_id TEXT NOT NULL DEFAULT '',
  note TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX idx_customers_name ON customers(name);
CREATE INDEX idx_customers_phone ON customers(phone);

-- เลขรันรายวันสำหรับ ONT-YYYYMMDD-NNNN (เพิ่มแบบ atomic ด้วย INSERT ... ON CONFLICT ... RETURNING)
CREATE TABLE order_counters (
  day TEXT PRIMARY KEY CHECK(length(day) = 8 AND day NOT GLOB '*[^0-9]*'),
  last_no INTEGER NOT NULL CHECK(last_no >= 1)
);

CREATE TABLE orders (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  order_no TEXT NOT NULL UNIQUE CHECK(length(order_no) BETWEEN 17 AND 20 AND substr(order_no,1,4) = 'ONT-' AND substr(order_no,13,1) = '-'
    AND substr(order_no,5,8) NOT GLOB '*[^0-9]*' AND substr(order_no,14) NOT GLOB '*[^0-9]*'),
  public_token TEXT NOT NULL UNIQUE CHECK(length(public_token) >= 43),
  request_key TEXT UNIQUE,                         -- idempotency ของการสร้างออเดอร์จากหน้า admin
  customer_id INTEGER NOT NULL REFERENCES customers(id) ON DELETE RESTRICT,
  title TEXT NOT NULL CHECK(length(trim(title)) BETWEEN 1 AND 300),
  note TEXT NOT NULL DEFAULT '',                   -- หมายเหตุที่ลูกค้าเห็น
  internal_note TEXT NOT NULL DEFAULT '',          -- หมายเหตุภายในร้าน
  subtotal_satang INTEGER NOT NULL CHECK(subtotal_satang > 0),
  discount_satang INTEGER NOT NULL DEFAULT 0 CHECK(discount_satang >= 0),
  total_satang INTEGER NOT NULL CHECK(total_satang > 0 AND total_satang <= 100000000 AND total_satang = subtotal_satang - discount_satang),
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK(status IN ('pending','awaiting_verification','paid','processing','completed','cancelled')),
  version INTEGER NOT NULL DEFAULT 1,
  paid_at TEXT,
  cancelled_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  CHECK((status IN ('paid','processing','completed')) = (paid_at IS NOT NULL))
);
CREATE INDEX idx_orders_created ON orders(created_at DESC, id DESC);
CREATE INDEX idx_orders_status_created ON orders(status, created_at DESC);
CREATE INDEX idx_orders_customer ON orders(customer_id, created_at DESC);

CREATE TABLE order_items (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  order_id INTEGER NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  position INTEGER NOT NULL CHECK(position >= 1),
  description TEXT NOT NULL CHECK(length(trim(description)) BETWEEN 1 AND 300),
  qty INTEGER NOT NULL CHECK(qty BETWEEN 1 AND 10000),
  unit_price_satang INTEGER NOT NULL CHECK(unit_price_satang > 0),
  amount_satang INTEGER NOT NULL CHECK(amount_satang = qty * unit_price_satang),
  UNIQUE(order_id, position)
);

-- หลักฐานการชำระ 1 แถวต่อการส่ง 1 ครั้ง (ส่งใหม่ได้หลังถูกปฏิเสธ)
CREATE TABLE payments (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  order_id INTEGER NOT NULL REFERENCES orders(id) ON DELETE RESTRICT,
  request_key TEXT NOT NULL UNIQUE,                -- Idempotency-Key จากเบราว์เซอร์
  amount_satang INTEGER NOT NULL CHECK(amount_satang > 0),  -- คัดลอกจาก orders.total_satang ฝั่ง server
  method TEXT NOT NULL DEFAULT 'promptpay' CHECK(method IN ('promptpay','bank_transfer','cash','other')),
  slip_key TEXT UNIQUE,                            -- key ใน R2 (private)
  slip_sha256 TEXT,
  slip_mime TEXT CHECK(slip_mime IS NULL OR slip_mime IN ('image/png','image/jpeg','image/webp')),
  slip_size INTEGER CHECK(slip_size IS NULL OR slip_size BETWEEN 1 AND 8388608),
  customer_note TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'submitted' CHECK(status IN ('submitted','verified','rejected')),
  reject_reason TEXT NOT NULL DEFAULT '',
  submitted_at TEXT NOT NULL,
  reviewed_at TEXT,
  UNIQUE(order_id, slip_sha256)                    -- สลิปไฟล์เดียวกันส่งซ้ำในออเดอร์เดิมไม่ได้
);
CREATE INDEX idx_payments_order ON payments(order_id, submitted_at DESC);
CREATE INDEX idx_payments_status ON payments(status, submitted_at DESC);
-- ต่อออเดอร์มีสลิปรอตรวจได้ครั้งละ 1 รายการ และยืนยันได้ครั้งเดียว
CREATE UNIQUE INDEX uq_payments_one_open ON payments(order_id) WHERE status = 'submitted';
CREATE UNIQUE INDEX uq_payments_one_verified ON payments(order_id) WHERE status = 'verified';

-- รายรับ: สร้างอัตโนมัติเมื่อยืนยันการชำระ · UNIQUE order_id/payment_id ป้องกันลงซ้ำ
CREATE TABLE income (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  order_id INTEGER NOT NULL UNIQUE REFERENCES orders(id) ON DELETE RESTRICT,
  payment_id INTEGER NOT NULL UNIQUE REFERENCES payments(id) ON DELETE RESTRICT,
  customer_id INTEGER NOT NULL REFERENCES customers(id) ON DELETE RESTRICT,
  amount_satang INTEGER NOT NULL CHECK(amount_satang > 0),
  category TEXT NOT NULL DEFAULT 'sales',
  received_date TEXT NOT NULL CHECK(length(received_date) = 10 AND date(received_date) IS received_date),
  note TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL
);
CREATE INDEX idx_income_date ON income(received_date DESC, id DESC);
CREATE INDEX idx_income_customer ON income(customer_id, received_date DESC);

-- กฎที่ฐานข้อมูลบังคับเอง (ไม่พึ่งโค้ด Worker อย่างเดียว)
-- รับหลักฐานการชำระได้เฉพาะออเดอร์ที่ยังรอชำระ
CREATE TRIGGER trg_payments_order_open BEFORE INSERT ON payments
WHEN (SELECT status FROM orders WHERE id = NEW.order_id) NOT IN ('pending','awaiting_verification')
BEGIN SELECT RAISE(ABORT, 'order_not_payable'); END;
-- ยอดต้องตรงกับยอดออเดอร์ใน D1 เสมอ
CREATE TRIGGER trg_payments_amount_match BEFORE INSERT ON payments
WHEN NEW.amount_satang IS NOT (SELECT total_satang FROM orders WHERE id = NEW.order_id)
BEGIN SELECT RAISE(ABORT, 'amount_mismatch'); END;
-- ห้ามแก้ยอดเงินเมื่อมีการส่งหลักฐานการชำระแล้ว หรือออเดอร์ไม่อยู่ในสถานะ pending
CREATE TRIGGER trg_orders_lock_amount BEFORE UPDATE OF subtotal_satang, discount_satang, total_satang ON orders
WHEN OLD.status <> 'pending' OR EXISTS (SELECT 1 FROM payments WHERE order_id = OLD.id)
BEGIN SELECT RAISE(ABORT, 'amount_locked'); END;
-- รายรับต้องมาจากสลิปที่ยืนยันแล้ว ของออเดอร์เดียวกัน และยอดตรงกัน
CREATE TRIGGER trg_income_from_verified BEFORE INSERT ON income
WHEN NOT EXISTS (SELECT 1 FROM payments p JOIN orders o ON o.id = p.order_id
  WHERE p.id = NEW.payment_id AND p.order_id = NEW.order_id AND p.status = 'verified'
    AND o.status = 'paid' AND p.amount_satang = NEW.amount_satang AND o.customer_id = NEW.customer_id)
BEGIN SELECT RAISE(ABORT, 'income_requires_verified_payment'); END;

-- รายจ่าย (โครงสร้างสำหรับเฟสหลัง)
CREATE TABLE expenses (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  expense_date TEXT NOT NULL CHECK(length(expense_date) = 10 AND date(expense_date) IS expense_date),
  category TEXT NOT NULL CHECK(length(trim(category)) BETWEEN 1 AND 100),
  description TEXT NOT NULL CHECK(length(trim(description)) BETWEEN 1 AND 300),
  vendor TEXT NOT NULL DEFAULT '',
  amount_satang INTEGER NOT NULL CHECK(amount_satang > 0),
  receipt_key TEXT UNIQUE,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX idx_expenses_date ON expenses(expense_date DESC, id DESC);
CREATE INDEX idx_expenses_category ON expenses(category, expense_date DESC);

-- ประวัติการเปลี่ยนสถานะ
CREATE TABLE order_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  order_id INTEGER NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  from_status TEXT,
  to_status TEXT NOT NULL,
  note TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL
);
CREATE INDEX idx_order_events_order ON order_events(order_id, id);

-- ค่าตั้งค่าที่ไม่ใช่ข้อมูลบัญชีรับเงิน (ข้อมูลรับเงินอยู่ใน vars ของ wrangler เท่านั้น)
CREATE TABLE settings (
  key TEXT PRIMARY KEY CHECK(length(key) BETWEEN 1 AND 64),
  value TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
INSERT INTO settings (key, value, updated_at) VALUES
  ('line_oa_id', '@653ercqc', strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  ('order_prefix', 'ONT', strftime('%Y-%m-%dT%H:%M:%fZ','now'));
