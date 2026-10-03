import { AppError } from './http.js';
import { MAX_TOTAL_SATANG, toSatang } from './money.js';

export const MAX_ITEMS = 50;

export function text(value, label, max, { required = false } = {}) {
  if (value === undefined || value === null) value = '';
  if (typeof value !== 'string') throw new AppError(`${label}ไม่ถูกต้อง`);
  const v = value.trim();
  if (required && !v) throw new AppError(`กรุณากรอก${label}`);
  if (v.length > max) throw new AppError(`${label}ยาวเกิน ${max} ตัวอักษร`);
  return v;
}

function phone(value) {
  const v = text(value, 'เบอร์โทร', 30);
  if (v && (!/^\+?[\d\s()-]{8,30}$/.test(v) || v.replace(/\D/g, '').length < 9)) throw new AppError('กรุณาตรวจสอบเบอร์โทร');
  return v;
}

export function validateCustomer(c) {
  if (!c || typeof c !== 'object') throw new AppError('กรุณาระบุลูกค้า');
  if (c.id !== undefined && c.id !== null) {
    if (!Number.isSafeInteger(c.id) || c.id < 1) throw new AppError('รหัสลูกค้าไม่ถูกต้อง');
    return { id: c.id };
  }
  return { name: text(c.name, 'ชื่อลูกค้า', 200, { required: true }), phone: phone(c.phone), lineId: text(c.lineId, 'LINE ID', 100) };
}

export function validateItems(items) {
  if (!Array.isArray(items) || items.length < 1 || items.length > MAX_ITEMS) throw new AppError(`กรุณาระบุรายการงาน 1–${MAX_ITEMS} รายการ`);
  return items.map((item, i) => {
    if (!item || typeof item !== 'object') throw new AppError(`รายการที่ ${i + 1} ไม่ถูกต้อง`);
    const qty = typeof item.qty === 'string' && /^\d+$/.test(item.qty.trim()) ? Number(item.qty) : item.qty;
    if (!Number.isInteger(qty) || qty < 1 || qty > 10000) throw new AppError(`จำนวนในรายการที่ ${i + 1} ต้องเป็นจำนวนเต็ม 1–10,000`);
    const unitPrice = toSatang(item.unitPrice, `ราคาต่อหน่วยในรายการที่ ${i + 1}`);
    const amount = qty * unitPrice;
    if (!Number.isSafeInteger(amount) || amount > MAX_TOTAL_SATANG) throw new AppError(`ยอดรายการที่ ${i + 1} สูงเกินกำหนด`);
    return { position: i + 1, description: text(item.description, `รายละเอียดรายการที่ ${i + 1}`, 300, { required: true }), qty, unitPrice, amount };
  });
}

// Totals are always recomputed here from items + discount; any total sent by the browser is ignored.
export function computeTotals(items, discountInput) {
  const subtotal = items.reduce((sum, i) => sum + i.amount, 0);
  const discount = discountInput === undefined || discountInput === null || discountInput === '' ? 0 : toSatang(discountInput, 'ส่วนลด', { allowZero: true });
  if (subtotal > MAX_TOTAL_SATANG) throw new AppError('ยอดรวมต้องไม่เกิน 1,000,000 บาท');
  if (discount >= subtotal) throw new AppError('ส่วนลดต้องน้อยกว่ายอดรวม');
  return { subtotal, discount, total: subtotal - discount };
}

export function validateNewOrder(body) {
  if (!body || typeof body !== 'object') throw new AppError('ข้อมูลไม่ถูกต้อง');
  const items = validateItems(body.items);
  return {
    customer: validateCustomer(body.customer),
    title: text(body.title, 'ชื่องาน', 300) || items[0].description.slice(0, 300),
    note: text(body.note, 'หมายเหตุถึงลูกค้า', 1000),
    internalNote: text(body.internalNote, 'หมายเหตุภายใน', 1000),
    items,
    ...computeTotals(items, body.discount)
  };
}

// Edit: only the fields present are changed. Items + discount are revalidated together.
export function validateOrderEdit(body) {
  if (!body || typeof body !== 'object' || !Number.isInteger(body.version)) throw new AppError('ข้อมูลไม่ถูกต้อง');
  const edit = { version: body.version };
  if ('title' in body) edit.title = text(body.title, 'ชื่องาน', 300, { required: true });
  if ('note' in body) edit.note = text(body.note, 'หมายเหตุถึงลูกค้า', 1000);
  if ('internalNote' in body) edit.internalNote = text(body.internalNote, 'หมายเหตุภายใน', 1000);
  if ('items' in body || 'discount' in body) {
    if (!('items' in body)) throw new AppError('แก้ส่วนลดต้องส่งรายการงานมาด้วย');
    edit.items = validateItems(body.items);
    Object.assign(edit, computeTotals(edit.items, body.discount));
  }
  return edit;
}
