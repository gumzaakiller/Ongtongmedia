import { AppError } from './http.js';

// Thai QR / PromptPay (EMVCo) payload. Amount always comes from D1, never from the browser.
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
  if (!validPromptPay(target) || !Number.isSafeInteger(satang) || satang <= 0) throw new AppError('ข้อมูลพร้อมเพย์หรือยอดเงินไม่ถูกต้อง', 500);
  const account = target.length === 10 ? tlv('01', '0066' + target.slice(1)) : tlv('02', target);
  const amount = `${Math.floor(satang / 100)}.${String(satang % 100).padStart(2, '0')}`;
  const payload = tlv('00', '01') + tlv('01', '12') + tlv('29', tlv('00', 'A000000677010111') + account) + tlv('58', 'TH') + tlv('53', '764') + tlv('54', amount) + '6304';
  return payload + crc16(payload);
}
