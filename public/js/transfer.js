// /transfer — pay the shop without a bill link (from the LINE OA rich menu), then send the slip.
import { $, api, baht, copyText, show, toast, toSatang } from './util.js';
import { iab, leaveLineBrowser, showInAppHelp, renderBankButtons, qrSaver } from './paytools.js';
import { rememberRecent } from './recent.js';

leaveLineBrowser();
if (iab === 'facebook') showInAppHelp(false);
renderBankButtons($('bankApps'));
const qr = qrSaver($('qrSave'), $('qrImg'));

function makeQr() {
  const raw = $('qrAmountInput').value.trim().replace(/,/g, '');
  const satang = toSatang(raw);
  if (raw && (!Number.isFinite(satang) || satang <= 0)) { toast('กรุณาใส่ยอดเป็นตัวเลข เช่น 850 หรือ 850.50'); return; }
  const amount = raw ? (satang / 100).toFixed(2) : '';
  $('qrAmount').textContent = raw ? baht(satang) : 'ใส่ยอดเองในแอปธนาคาร';
  qr.load(`/api/transfer/qr.png${amount ? `?amount=${amount}` : ''}`, `QR-อองตองมีเดีย${amount ? '-' + amount : ''}.png`);
  if (amount && !$('tAmount').value) $('tAmount').value = amount;
}
$('qrMake').addEventListener('click', makeQr);
$('qrAmountInput').addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); makeQr(); } });

$('copyAccount').addEventListener('click', async () => toast(await copyText($('accountNo').textContent.replace(/\D/g, '')) ? 'คัดลอกเลขบัญชีแล้ว' : 'คัดลอกไม่สำเร็จ'));
$('copyPromptPay').addEventListener('click', async () => toast(await copyText($('promptPayId').textContent) ? 'คัดลอกเลขพร้อมเพย์แล้ว' : 'คัดลอกไม่สำเร็จ'));
$('qrImg').addEventListener('error', () => toast('โหลดรูป QR ไม่สำเร็จ ใช้การโอนเข้าบัญชีแทนได้'));

// ---- slip form ----
const MAX_SLIP = 8 * 1024 * 1024;
const TYPES = ['image/png', 'image/jpeg', 'image/webp'];
let key = null, sending = false;
$('slipFile').addEventListener('change', () => {
  const f = $('slipFile').files[0]; show($('formError'), ''); key = null;
  if (!f) { $('slipPreview').hidden = true; $('fileLabel').textContent = 'แตะเพื่อเลือกรูปสลิป'; return; }
  if (!TYPES.includes(f.type)) show($('formError'), 'กรุณาเลือกไฟล์รูปภาพ PNG, JPG หรือ WEBP');
  else if (f.size > MAX_SLIP) show($('formError'), 'รูปมีขนาดเกิน 8 MB กรุณาแคปหน้าจอสลิปใหม่');
  $('fileLabel').textContent = `เลือกแล้ว: ${f.name}  (แตะเพื่อเปลี่ยน)`;
  if ($('slipPreview').src) URL.revokeObjectURL($('slipPreview').src);
  $('slipPreview').src = URL.createObjectURL(f); $('slipPreview').hidden = false;
});
for (const id of ['tName', 'tPhone', 'tAmount', 'tRef', 'tNote']) $(id).addEventListener('input', () => { key = null; });

$('transferForm').addEventListener('submit', async e => {
  e.preventDefault(); if (sending) return;
  const f = $('slipFile').files[0];
  const amount = toSatang($('tAmount').value);
  const problem = !$('tName').value.trim() ? 'กรุณากรอกชื่อผู้โอน'
    : $('tPhone').value.replace(/\D/g, '').length < 9 ? 'กรุณากรอกเบอร์โทรให้ถูกต้อง'
    : !Number.isFinite(amount) || amount <= 0 ? 'กรุณากรอกยอดที่โอน เช่น 850 หรือ 850.50'
    : !f ? 'กรุณาแนบรูปสลิป'
    : !TYPES.includes(f.type) || f.size > MAX_SLIP ? 'รูปสลิปต้องเป็น PNG, JPG หรือ WEBP ขนาดไม่เกิน 8 MB' : '';
  if (problem) { show($('formError'), problem); return; }
  key ||= crypto.randomUUID(); // same key on retry → the shop never gets the slip twice
  const form = new FormData();
  form.set('slip', f); form.set('name', $('tName').value); form.set('phone', $('tPhone').value);
  form.set('amount', (amount / 100).toFixed(2)); form.set('ref', $('tRef').value); form.set('note', $('tNote').value);
  sending = true; $('submitBtn').disabled = true; $('submitBtn').textContent = 'กำลังส่ง...'; show($('formError'), '');
  try {
    const res = await fetch('/api/transfer', { method: 'POST', body: form, headers: { 'Idempotency-Key': key } });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) { const err = new Error(data.error || 'ส่งไม่สำเร็จ ลองอีกครั้ง'); err.status = res.status; throw err; }
    key = null;
    const path = new URL(data.payUrl).pathname;
    rememberRecent(data.orderNo, `แจ้งโอน ${baht(amount)}`, path);
    $('doneNo').textContent = data.orderNo; $('doneLink').href = path;
    for (const id of ['slipCard']) $(id).hidden = true;
    $('doneCard').hidden = false; $('doneCard').scrollIntoView({ behavior: 'smooth', block: 'start' });
  } catch (err) {
    if (err.status && err.status < 500 && err.status !== 429) key = null;
    show($('formError'), err.status ? err.message : 'เชื่อมต่อไม่ได้ ตรวจสอบอินเทอร์เน็ตแล้วกดส่งอีกครั้ง (ไม่ส่งซ้ำ)');
  } finally { sending = false; $('submitBtn').disabled = false; $('submitBtn').textContent = 'ส่งสลิปให้ร้าน'; }
});

api('/api/transfer').then(({ shop }) => {
  $('shopName').textContent = shop.name;
  $('bankName').textContent = shop.bankName || '—';
  $('accountName').textContent = shop.accountName;
  $('accountNo').textContent = shop.accountNo;
  $('accountNoLabel').hidden = $('accountNoRow').hidden = !shop.accountNo;
  $('promptPayId').textContent = shop.promptPayId;
  makeQr();
  $('loading').hidden = true; $('content').hidden = false;
}).catch(e => { $('loading').hidden = true; show($('errorBox'), e.message); });
