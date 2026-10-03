import { AppError } from './http.js';

export const MAX_TOTAL_SATANG = 100_000_000; // 1,000,000 บาท

// "1,250.50" / "1250.5" / 1250 → 125050 สตางค์. ไม่ใช้ float ในการคำนวณ: แยกส่วนบาท/สตางค์จากข้อความ
export function toSatang(value, label = 'จำนวนเงิน', { allowZero = false } = {}) {
  if (!['string', 'number'].includes(typeof value)) throw new AppError(`${label} ไม่ถูกต้อง`);
  const text = String(value).trim().replace(/,/g, '');
  const m = /^(\d{1,9})(?:\.(\d{1,2}))?$/.exec(text);
  if (!m) throw new AppError(`${label} ต้องเป็นตัวเลขไม่ติดลบ ทศนิยมไม่เกิน 2 ตำแหน่ง`);
  const satang = Number(m[1]) * 100 + Number((m[2] || '').padEnd(2, '0'));
  if (!Number.isSafeInteger(satang) || satang > MAX_TOTAL_SATANG) throw new AppError(`${label} สูงเกินกำหนด`);
  if (!allowZero && satang <= 0) throw new AppError(`${label} ต้องมากกว่าศูนย์`);
  return satang;
}

export const formatBaht = satang => (satang / 100).toLocaleString('th-TH', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
