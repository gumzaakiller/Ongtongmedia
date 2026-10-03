// Amount in Thai words for receipts: 1500.25 baht → "หนึ่งพันห้าร้อยบาทยี่สิบห้าสตางค์", 500 → "ห้าร้อยบาทถ้วน".
const DIGITS = ['', 'หนึ่ง', 'สอง', 'สาม', 'สี่', 'ห้า', 'หก', 'เจ็ด', 'แปด', 'เก้า'];
const PLACES = ['', 'สิบ', 'ร้อย', 'พัน', 'หมื่น', 'แสน'];

function underMillion(n, afterMillion = false) {
  const s = String(n); let out = '';
  for (let i = 0; i < s.length; i++) {
    const d = +s[i], place = s.length - 1 - i;
    if (!d) continue;
    if (place === 1 && d === 1) out += 'สิบ';
    else if (place === 1 && d === 2) out += 'ยี่สิบ';
    else if (place === 0 && d === 1 && (s.length > 1 || afterMillion)) out += 'เอ็ด';
    else out += DIGITS[d] + PLACES[place];
  }
  return out;
}
function words(n) {
  if (n === 0) return 'ศูนย์';
  const millions = Math.floor(n / 1e6), rest = n % 1e6;
  return (millions ? words(millions) + 'ล้าน' : '') + underMillion(rest, millions > 0);
}
export function bahtText(satang) {
  if (!Number.isSafeInteger(satang) || satang < 0) throw new RangeError('amount');
  const baht = Math.floor(satang / 100), st = satang % 100;
  if (!st) return `${words(baht)}บาทถ้วน`;
  return `${baht ? words(baht) + 'บาท' : ''}${words(st)}สตางค์`;
}
