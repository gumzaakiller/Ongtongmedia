// Job types shown on the "สั่งงาน" menu. Edit this list to change the menu (no database change needed).
// options: extra checkboxes for that job type. size: whether to ask width × height.
export const CATALOG = [
  { id: 'vinyl',    name: 'ป้ายไวนิล',                hint: 'ป้ายหน้าร้าน ป้ายงานอีเวนต์ ป้ายโฆษณา',  size: true,  options: ['เจาะตาไก่', 'พับขอบเย็บ', 'ใส่โครงไม้', 'ใส่โครงเหล็ก'] },
  { id: 'sticker',  name: 'สติ๊กเกอร์',                hint: 'ติดกระจก ไดคัท ติดรถ ฉลากสินค้า',       size: true,  options: ['ไดคัทตามรูป', 'เคลือบด้าน', 'เคลือบเงา', 'สติ๊กเกอร์ใส', 'ติดตั้งให้'] },
  { id: 'acrylic',  name: 'ป้ายอะคริลิก / ป้ายร้าน',     hint: 'ป้ายชื่อร้าน ป้ายตัวอักษร ป้ายสำนักงาน', size: true,  options: ['ตัวอักษรนูน', 'มีไฟ LED', 'ติดตั้งให้'] },
  { id: 'board',    name: 'ป้ายฟิวเจอร์บอร์ด / โฟมบอร์ด', hint: 'ป้ายตั้งโต๊ะ ป้ายบอกทาง ป้ายถ่ายรูป',    size: true,  options: ['ไดคัทตามรูป', 'มีขาตั้ง'] },
  { id: 'standee',  name: 'โรลอัพ / X-Stand',          hint: 'ป้ายตั้งพื้นพร้อมขา',                    size: true,  options: ['รวมขาตั้ง', 'เปลี่ยนเฉพาะแผ่นป้าย'] },
  { id: 'lightbox', name: 'ป้ายไฟ / กล่องไฟ',          hint: 'ป้ายหน้าร้านแบบมีไฟ',                    size: true,  options: ['หน้าเดียว', 'สองหน้า', 'ติดตั้งให้'] },
  { id: 'print3d',  name: 'งานพิมพ์ 3D',               hint: 'โมเดล ของที่ระลึก ชิ้นส่วน ป้ายนูน 3 มิติ', size: true,  options: ['เส้น PLA', 'เส้น PETG', 'เรซิ่น (ละเอียดสูง)', 'ทำสี / เก็บผิว', 'ให้ร้านออกแบบโมเดล'],
    fileNote: 'ไฟล์โมเดล STL / 3MF / OBJ ส่งทาง LINE หลังส่งคำขอ' },
  { id: 'design',   name: 'ออกแบบงาน',                hint: 'ให้ร้านออกแบบโลโก้ ป้าย หรือสื่อต่างๆ',   size: false, options: [] },
  { id: 'other',    name: 'งานอื่นๆ',                  hint: 'บอกรายละเอียดได้เลย',                   size: false, options: [] }
];
export const catalogById = id => CATALOG.find(c => c.id === id);
