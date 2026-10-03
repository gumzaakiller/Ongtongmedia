-- 0006: ใบแจ้งหนี้ / ใบส่งของ / ใบเสร็จรับเงิน
-- เลขที่เอกสารรันแยกตามประเภทและปี พ.ศ. · เอกสารเก็บ "ภาพ" ข้อมูล ณ วันออก (snapshot) ไว้ จึงไม่เปลี่ยนตามบิลที่แก้ภายหลัง
-- ข้อมูลหัวเอกสารของร้าน (ที่อยู่ เลขผู้เสียภาษี ผู้ลงนาม) เก็บใน settings ไม่เก็บใน git
ALTER TABLE customers ADD COLUMN address TEXT NOT NULL DEFAULT '';
ALTER TABLE customers ADD COLUMN tax_id TEXT NOT NULL DEFAULT '';

CREATE TABLE doc_counters (
  doc_type TEXT NOT NULL CHECK(doc_type IN ('invoice','delivery','receipt')),
  year INTEGER NOT NULL CHECK(year BETWEEN 2500 AND 2700),
  last_no INTEGER NOT NULL CHECK(last_no >= 1),
  PRIMARY KEY (doc_type, year)
);

CREATE TABLE documents (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  order_id INTEGER NOT NULL REFERENCES orders(id) ON DELETE RESTRICT,
  doc_type TEXT NOT NULL CHECK(doc_type IN ('invoice','delivery','receipt')),
  year INTEGER NOT NULL,
  seq INTEGER NOT NULL CHECK(seq >= 1),
  issued_date TEXT NOT NULL CHECK(length(issued_date) = 10 AND date(issued_date) IS issued_date),
  snapshot_json TEXT NOT NULL CHECK(json_valid(snapshot_json)),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(order_id, doc_type),
  UNIQUE(doc_type, year, seq)
);
CREATE INDEX idx_documents_order ON documents(order_id);

-- ใบเสร็จออกได้เฉพาะบิลที่ยืนยันการชำระแล้ว (บังคับที่ฐานข้อมูลด้วย)
CREATE TRIGGER trg_receipt_requires_paid BEFORE INSERT ON documents
WHEN NEW.doc_type = 'receipt' AND (SELECT status FROM orders WHERE id = NEW.order_id) NOT IN ('paid','processing','completed')
BEGIN SELECT RAISE(ABORT, 'receipt_requires_paid'); END;
