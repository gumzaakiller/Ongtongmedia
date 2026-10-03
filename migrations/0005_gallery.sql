-- 0005: ตัวอย่างผลงาน (แกลเลอรี) — รูปเก็บใน R2 (prefix gallery/) ร้านอัปโหลดจากหลังร้าน
CREATE TABLE gallery_items (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  category TEXT NOT NULL CHECK(length(category) BETWEEN 1 AND 40),
  title TEXT NOT NULL CHECK(length(trim(title)) BETWEEN 1 AND 200),
  caption TEXT NOT NULL DEFAULT '',
  r2_key TEXT NOT NULL UNIQUE,
  sha256 TEXT NOT NULL UNIQUE,
  mime TEXT NOT NULL CHECK(mime IN ('image/png','image/jpeg','image/webp')),
  size INTEGER NOT NULL CHECK(size BETWEEN 1 AND 8388608),
  created_at TEXT NOT NULL
);
CREATE INDEX idx_gallery_category ON gallery_items(category, id DESC);
