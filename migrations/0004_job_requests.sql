-- 0004: คำขอสั่งงานจากลูกค้า (ร้านป้าย) → ร้านเสนอราคา → กลายเป็นบิล (orders) เดิม
CREATE TABLE request_counters (
  day TEXT PRIMARY KEY CHECK(length(day) = 8 AND day NOT GLOB '*[^0-9]*'),
  last_no INTEGER NOT NULL CHECK(last_no >= 1)
);

CREATE TABLE job_requests (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  request_no TEXT NOT NULL UNIQUE CHECK(length(request_no) BETWEEN 17 AND 20 AND substr(request_no,1,4) = 'REQ-' AND substr(request_no,13,1) = '-'
    AND substr(request_no,5,8) NOT GLOB '*[^0-9]*' AND substr(request_no,14) NOT GLOB '*[^0-9]*'),
  public_token TEXT NOT NULL UNIQUE CHECK(length(public_token) >= 43),   -- ลิงก์ติดตามสถานะของลูกค้า
  request_key TEXT NOT NULL UNIQUE,                                       -- Idempotency-Key
  category TEXT NOT NULL CHECK(length(category) BETWEEN 1 AND 40),
  details_json TEXT NOT NULL CHECK(json_valid(details_json)),
  customer_name TEXT NOT NULL CHECK(length(trim(customer_name)) BETWEEN 1 AND 200),
  customer_phone TEXT NOT NULL DEFAULT '',
  customer_line TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'new' CHECK(status IN ('new','quoted','cancelled')),
  cancel_reason TEXT NOT NULL DEFAULT '',
  order_id INTEGER UNIQUE REFERENCES orders(id) ON DELETE RESTRICT,       -- บิลที่ออกจากคำขอนี้
  version INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  CHECK((status = 'quoted') = (order_id IS NOT NULL))
);
CREATE INDEX idx_job_requests_status ON job_requests(status, created_at DESC);
CREATE INDEX idx_job_requests_created ON job_requests(created_at DESC, id DESC);

CREATE TABLE request_files (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  request_id INTEGER NOT NULL REFERENCES job_requests(id) ON DELETE CASCADE,
  r2_key TEXT NOT NULL UNIQUE,
  file_name TEXT NOT NULL,
  mime TEXT NOT NULL CHECK(mime IN ('image/png','image/jpeg','image/webp','application/pdf')),
  size INTEGER NOT NULL CHECK(size BETWEEN 1 AND 20971520),
  created_at TEXT NOT NULL
);
CREATE INDEX idx_request_files_request ON request_files(request_id);
