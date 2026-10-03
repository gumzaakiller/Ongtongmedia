import { $, STATUS_LABEL, api, baht, copyText, el, show, toast } from './util.js';
import { BANK_APPS, bankLink, platform } from './banks.js';

// Customer-facing wording per status (what happened + what to do next).
const STATUS_MESSAGE = {
  pending: '',
  awaiting_verification: 'ร้านได้รับหลักฐานการชำระแล้ว กำลังตรวจสอบยอดเงิน',
  paid: 'ชำระเงินเรียบร้อยแล้ว ขอบคุณที่ใช้บริการอองตองมีเดีย',
  processing: 'ชำระเงินเรียบร้อยแล้ว ร้านกำลังดำเนินงานของคุณ',
  completed: 'งานเสร็จเรียบร้อย ขอบคุณที่ใช้บริการอองตองมีเดีย',
  cancelled: 'รายการนี้ถูกยกเลิกแล้ว กรุณาอย่าโอนเงินตามรายการนี้ หากมีข้อสงสัยติดต่อร้าน'
};

const token = decodeURIComponent(location.pathname.split('/').filter(Boolean)[1] || '');

function lineUrl(lineOaId, data) {
  const text = data.order.status === 'pending'
    ? `แจ้งชำระเงิน\nเลขที่ ${data.order.orderNo}\nยอด ${baht(data.order.totalSatang)}\n(แนบรูปสลิปในแชทนี้)`
    : `สอบถามรายการ ${data.order.orderNo}`;
  return `https://line.me/R/oaMessage/${encodeURIComponent(lineOaId)}/?${encodeURIComponent(text)}`;
}

function render(data) {
  const { order, shop } = data;
  document.title = `${order.orderNo} | ${shop.name}`;
  $('shopName').textContent = shop.name;

  // status
  let msg = STATUS_MESSAGE[order.status];
  if (order.status === 'pending' && order.lastPayment?.status === 'rejected') {
    msg = `หลักฐานการชำระครั้งก่อนตรวจสอบไม่ผ่าน${order.lastPayment.rejectReason ? `: ${order.lastPayment.rejectReason}` : ''}\nกรุณาตรวจสอบยอดแล้วชำระหรือแจ้งร้านอีกครั้ง`;
  }
  $('statusBox').textContent = msg; $('statusBox').hidden = !msg;
  $('statusBox').className = `status-box ${order.status}`;

  // ticket
  $('orderNo').textContent = order.orderNo;
  $('orderTitle').textContent = order.title;
  $('statusBadge').className = `badge ${order.status}`; $('statusBadge').textContent = STATUS_LABEL[order.status];
  $('lines').replaceChildren(...order.items.map(i => el('tr', {},
    el('td', {}, i.description, el('div', { class: 'q', text: `${i.qty} × ${baht(i.unitPriceSatang)}` })),
    el('td', { text: baht(i.amountSatang) }))));
  $('subRow').hidden = $('discRow').hidden = !order.discountSatang;
  $('sub').textContent = baht(order.subtotalSatang);
  $('disc').textContent = '−' + baht(order.discountSatang);
  $('total').textContent = baht(order.totalSatang);
  $('noteWrap').hidden = !order.note; $('note').textContent = order.note;

  // how to pay: only while the bill is open
  const payable = !!data.qrImageUrl;
  $('qrCard').hidden = !payable; $('bankCard').hidden = !payable;
  if (payable) {
    $('qrAmount').textContent = baht(order.totalSatang);
    $('qrImg').src = data.qrImageUrl;
    $('qrSave').href = data.qrImageUrl;
    $('qrSave').setAttribute('download', `QR-${order.orderNo}.png`);
    $('bankName').textContent = shop.bankName || '—';
    $('accountName').textContent = shop.accountName;
    $('accountNo').textContent = shop.accountNo;
    $('accountNoLabel').hidden = $('accountNoRow').hidden = !shop.accountNo;
    $('promptPayId').textContent = shop.promptPayId;
    $('exactAmount').textContent = baht(order.totalSatang);
  }

  // slip upload (only while the bill is open)
  $('uploadCard').hidden = !data.canSubmitSlip;
  state.canSubmitSlip = data.canSubmitSlip;
  if (!data.canSubmitSlip) $('paidPrompt').hidden = true;

  // LINE
  const canNotify = order.status === 'pending';
  $('notifyTitle').textContent = canNotify ? (data.canSubmitSlip ? 'หรือแจ้งทาง LINE' : 'แจ้งชำระทาง LINE') : 'ติดต่อร้าน';
  $('notifyHint').hidden = !canNotify;
  $('lineBtn').textContent = canNotify ? 'แจ้งชำระผ่าน LINE' : 'ติดต่อร้านทาง LINE';
  if (shop.lineOaId) {
    $('lineBtn').href = $('paidPromptLine').href = lineUrl(shop.lineOaId, data);
    $('lineId').textContent = `LINE ${shop.lineOaId}`;
  } else { $('lineBtn').hidden = true; $('paidPromptLine').hidden = true; }

  $('loading').hidden = true; $('content').hidden = false;
}

// ---- bank apps + "paid? send the slip" prompt when the customer comes back ----
const state = { leftToPay: false, canSubmitSlip: false };
const os = platform();
$('bankApps').replaceChildren(...BANK_APPS.map(app => el('a', {
  class: 'bank-app', href: bankLink(app, os), rel: 'noopener', 'data-bank': app.id,
  onclick: () => { state.leftToPay = true; }
}, el('b', { text: app.name }), el('span', { text: app.bank }))));
$('qrSave').addEventListener('click', e => {
  state.leftToPay = true;
  if (os === 'ios') {
    // iPhone saves downloads to Files, but banking apps read from Photos: long-press the image instead.
    e.preventDefault();
    $('qrImg').scrollIntoView({ behavior: 'smooth', block: 'center' });
    $('qrImg').classList.add('pulse'); setTimeout(() => $('qrImg').classList.remove('pulse'), 2400);
    toast('กดค้างที่รูป QR แล้วเลือก "บันทึกลงในรูปภาพ"');
  }
});
document.addEventListener('visibilitychange', () => {
  // Back from the banking app: offer the next step right away.
  if (document.visibilityState === 'visible' && state.leftToPay && state.canSubmitSlip) $('paidPrompt').hidden = false;
});
$('paidPromptClose').addEventListener('click', () => { $('paidPrompt').hidden = true; state.leftToPay = false; });
$('paidPromptUpload').addEventListener('click', () => {
  $('paidPrompt').hidden = true; state.leftToPay = false;
  $('uploadCard').scrollIntoView({ behavior: 'smooth', block: 'start' });
  $('slipFile').click();
});
$('paidPromptLine').addEventListener('click', () => { $('paidPrompt').hidden = true; state.leftToPay = false; });

$('copyAccount').addEventListener('click', async () => toast(await copyText($('accountNo').textContent.replace(/\D/g, '')) ? 'คัดลอกเลขบัญชีแล้ว' : 'คัดลอกไม่สำเร็จ'));
$('copyPromptPay').addEventListener('click', async () => toast(await copyText($('promptPayId').textContent) ? 'คัดลอกเลขพร้อมเพย์แล้ว' : 'คัดลอกไม่สำเร็จ'));
$('qrImg').addEventListener('error', () => { $('qrImg').hidden = true; toast('โหลดรูป QR ไม่สำเร็จ ใช้การโอนเข้าบัญชีแทนได้'); });

// ---- slip upload ----
const MAX_SLIP = 8 * 1024 * 1024;
let slipKey = null, sending = false;
$('slipFile').addEventListener('change', () => {
  const f = $('slipFile').files[0]; show($('slipError'), ''); slipKey = null;
  if (!f) { $('slipPreview').hidden = true; $('fileLabel').textContent = 'แตะเพื่อเลือกรูปสลิป'; return; }
  if (!['image/png', 'image/jpeg', 'image/webp'].includes(f.type)) show($('slipError'), 'กรุณาเลือกไฟล์รูปภาพ PNG, JPG หรือ WEBP');
  else if (f.size > MAX_SLIP) show($('slipError'), 'รูปมีขนาดเกิน 8 MB กรุณาเลือกรูปที่เล็กลง หรือแคปหน้าจอสลิปใหม่');
  $('fileLabel').textContent = `เลือกแล้ว: ${f.name}  (แตะเพื่อเปลี่ยน)`;
  if ($('slipPreview').src) URL.revokeObjectURL($('slipPreview').src);
  $('slipPreview').src = URL.createObjectURL(f); $('slipPreview').hidden = false;
});
$('slipForm').addEventListener('submit', async e => {
  e.preventDefault(); if (sending) return;
  const f = $('slipFile').files[0];
  if (!f) { show($('slipError'), 'กรุณาเลือกรูปสลิปก่อน'); return; }
  if (!['image/png', 'image/jpeg', 'image/webp'].includes(f.type) || f.size > MAX_SLIP) return;
  // Keep the same key until success so a retry after a network drop cannot create a duplicate.
  slipKey ||= crypto.randomUUID();
  const form = new FormData(); form.set('slip', f); form.set('note', $('slipNote').value);
  sending = true; $('slipSubmit').disabled = true; $('slipSubmit').textContent = 'กำลังส่ง...'; show($('slipError'), '');
  try {
    const res = await fetch(`/api/pay/${encodeURIComponent(token)}/slip`, { method: 'POST', body: form, headers: { 'Idempotency-Key': slipKey } });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) { const err = new Error(data.error || 'ส่งสลิปไม่สำเร็จ ลองอีกครั้ง'); err.status = res.status; throw err; }
    slipKey = null; toast('ส่งสลิปเรียบร้อย ร้านจะตรวจสอบและแจ้งผล');
    await load(); scrollTo(0, 0);
  } catch (err) {
    if (err.status && err.status < 500 && err.status !== 429) slipKey = null;
    show($('slipError'), err.status ? err.message : 'เชื่อมต่อไม่ได้ ตรวจสอบอินเทอร์เน็ตแล้วกด "ส่งสลิป" อีกครั้ง (ไม่ส่งซ้ำ)');
  } finally { sending = false; $('slipSubmit').disabled = false; $('slipSubmit').textContent = 'ส่งสลิป'; }
});

const load = () => api('/api/pay/' + encodeURIComponent(token))
  .then(render)
  .catch(e => { $('loading').hidden = true; $('content').hidden = true; show($('errorBox'), e.message); });
load();
