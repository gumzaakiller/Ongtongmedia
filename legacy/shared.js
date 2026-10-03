export const STATUSES = ['รอชำระเงิน','รอตรวจสอบการชำระเงิน','ชำระแล้ว','กำลังดำเนินการ','เสร็จสิ้น','ยกเลิก'];
export const MAX_SLIP = 8 * 1024 * 1024;
export class AppError extends Error {
  constructor(message, status = 400) { super(message); this.status = status; }
}
function text(value, label, max, required = false) {
  if (typeof value !== 'string' || value.trim().length > max || (required && !value.trim())) throw new AppError(`${label}ไม่ถูกต้อง`);
  return value.trim();
}
export function money(value, label = 'จำนวนเงิน') {
  if (!['string','number'].includes(typeof value) || !/^\d+(?:\.\d{1,2})?$/.test(String(value))) throw new AppError(`${label}ต้องเป็นจำนวนเงินไม่ติดลบและมีทศนิยมไม่เกิน 2 ตำแหน่ง`);
  const result = Math.round(Number(value) * 100);
  if (!Number.isSafeInteger(result) || result > 100000000) throw new AppError(`${label}สูงเกินกำหนด`);
  return result;
}
export function validateOrder(p) {
  if (!p || !Array.isArray(p.items) || !p.items.length || p.items.length > 50) throw new AppError('กรุณาระบุสินค้า 1–50 รายการ');
  const items = p.items.map(i => {
    if (!i || !Number.isInteger(i.qty) || i.qty < 1 || i.qty > 10000) throw new AppError('จำนวนสินค้าต้องเป็นจำนวนเต็ม 1–10,000');
    const priceSatang = money(i.price, 'ราคาสินค้า');
    if (priceSatang <= 0) throw new AppError('ราคาสินค้าต้องมากกว่าศูนย์');
    return { name: text(i.name, 'ชื่อสินค้า', 200, true), priceSatang, qty: i.qty };
  });
  const subtotal = items.reduce((s, i) => s + i.priceSatang * i.qty, 0);
  const shipping = money(p.shipping ?? 0, 'ค่าจัดส่ง');
  const total = subtotal + shipping;
  if (!Number.isSafeInteger(total) || total > 100000000) throw new AppError('ยอดรวมต้องไม่เกิน 1,000,000 บาท');
  const phone = text(p.phone, 'เบอร์โทร', 30, true);
  if (!/^\+?[\d\s()-]{8,30}$/.test(phone) || phone.replace(/\D/g,'').length < 8) throw new AppError('กรุณาตรวจสอบเบอร์โทร');
  return { customer: text(p.customer, 'ชื่อลูกค้า', 200, true), phone, contact: text(p.contact ?? '', 'ช่องทางติดต่อ', 300), note: text(p.note ?? '', 'หมายเหตุ', 1000), items, subtotal, shipping, total };
}
export function validPromptPay(target) { return /^(0\d{9}|\d{13})$/.test(target || ''); }
function tlv(id, value) { return id + String(value.length).padStart(2, '0') + value; }
export function crc16(str) {
  let crc = 0xffff;
  for (let c = 0; c < str.length; c++) {
    crc ^= str.charCodeAt(c) << 8;
    for (let i = 0; i < 8; i++) crc = (crc & 0x8000) ? ((crc << 1) ^ 0x1021) : crc << 1;
    crc &= 0xffff;
  }
  return crc.toString(16).toUpperCase().padStart(4, '0');
}
export function promptPayPayload(target, satang) {
  if (!validPromptPay(target) || !Number.isSafeInteger(satang) || satang <= 0) throw new AppError('ข้อมูลพร้อมเพย์หรือยอดเงินไม่ถูกต้อง');
  const account = target.length === 10 ? tlv('01', '0066' + target.slice(1)) : tlv('02', target);
  const payload = tlv('00','01') + tlv('01','12') + tlv('29',tlv('00','A000000677010111') + account) + tlv('58','TH') + tlv('53','764') + tlv('54',(satang / 100).toFixed(2)) + '6304';
  return payload + crc16(payload);
}
