-- 0003: เชื่อม LINE OA — จำว่าผู้ใช้ LINE คนไหนกำลังแจ้งชำระออเดอร์ไหน
-- ลูกค้ากดปุ่ม "ส่งทาง LINE" จากหน้าชำระเงิน → ข้อความมีเลขออเดอร์ → ระบบจำไว้ → รูปสลิปที่ส่งตามมาถูกผูกกับออเดอร์นั้น
CREATE TABLE line_links (
  line_user_id TEXT PRIMARY KEY CHECK(length(line_user_id) BETWEEN 10 AND 64),
  order_id INTEGER NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  updated_at TEXT NOT NULL
);
CREATE INDEX idx_line_links_order ON line_links(order_id);
