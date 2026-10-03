// Small browser helpers shared by the admin and customer pages (plain ES modules, no build step).
export const $ = id => document.getElementById(id);

export const STATUS_LABEL = {
  pending: 'รอชำระเงิน',
  awaiting_verification: 'รอตรวจสลิป',
  paid: 'ชำระแล้ว',
  processing: 'กำลังดำเนินการ',
  completed: 'เสร็จสิ้น',
  cancelled: 'ยกเลิก'
};

export const baht = satang => '฿' + (satang / 100).toLocaleString('th-TH', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

// Preview-only parsing (the server recomputes everything). Mirrors src/lib/money.js.
export function toSatang(value) {
  const text = String(value ?? '').trim().replace(/,/g, '');
  if (!text) return 0;
  const m = /^(\d{1,9})(?:\.(\d{1,2}))?$/.exec(text);
  return m ? Number(m[1]) * 100 + Number((m[2] || '').padEnd(2, '0')) : NaN;
}

export function thaiDateTime(iso) {
  if (!iso) return '';
  return new Date(iso).toLocaleString('th-TH', { timeZone: 'Asia/Bangkok', day: 'numeric', month: 'short', year: '2-digit', hour: '2-digit', minute: '2-digit' });
}

export class ApiError extends Error { constructor(message, status) { super(message); this.status = status; } }

export async function api(path, { method = 'GET', body, headers = {} } = {}) {
  const init = { method, credentials: 'same-origin', headers: { ...headers } };
  if (body !== undefined) { init.body = JSON.stringify(body); init.headers['Content-Type'] = 'application/json'; }
  let res;
  try { res = await fetch(path, init); }
  catch { throw new ApiError('เชื่อมต่อไม่ได้ ตรวจสอบอินเทอร์เน็ตแล้วลองอีกครั้ง', 0); }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new ApiError(data.error || 'ระบบขัดข้อง ลองอีกครั้ง', res.status);
  return data;
}

export function show(el, message) { el.textContent = message || ''; el.hidden = !message; }

export function el(tag, props = {}, ...children) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (k === 'class') node.className = v;
    else if (k === 'text') node.textContent = v;
    else if (k.startsWith('on')) node.addEventListener(k.slice(2), v);
    else if (v !== undefined && v !== null && v !== false) node.setAttribute(k, v === true ? '' : v);
  }
  for (const c of children) if (c !== null && c !== undefined) node.append(c);
  return node;
}

let toastTimer;
export function toast(message) {
  const t = $('toast'); if (!t) return;
  t.textContent = message; t.hidden = false;
  clearTimeout(toastTimer); toastTimer = setTimeout(() => { t.hidden = true; }, 2600);
}

export async function copyText(text) {
  try { await navigator.clipboard.writeText(text); return true; }
  catch {
    // Fallback for browsers without clipboard permission (e.g. some in-app browsers).
    const ta = el('textarea', { readonly: true }); ta.value = text;
    ta.style.position = 'fixed'; ta.style.opacity = '0';
    document.body.append(ta); ta.select();
    const ok = document.execCommand('copy'); ta.remove(); return ok;
  }
}
