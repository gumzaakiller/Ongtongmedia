import { $, STATUS_LABEL, api, baht, copyText, el, show, toast } from './util.js';

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

  // LINE
  const canNotify = order.status === 'pending';
  $('notifyTitle').textContent = canNotify ? 'ชำระแล้ว แจ้งร้านได้ที่นี่' : 'ติดต่อร้าน';
  $('notifyHint').hidden = !canNotify;
  $('lineBtn').textContent = canNotify ? 'แจ้งชำระผ่าน LINE' : 'ติดต่อร้านทาง LINE';
  if (shop.lineOaId) { $('lineBtn').href = lineUrl(shop.lineOaId, data); $('lineId').textContent = `LINE ${shop.lineOaId}`; }
  else $('lineBtn').hidden = true;

  $('loading').hidden = true; $('content').hidden = false;
}

$('copyAccount').addEventListener('click', async () => toast(await copyText($('accountNo').textContent.replace(/\D/g, '')) ? 'คัดลอกเลขบัญชีแล้ว' : 'คัดลอกไม่สำเร็จ'));
$('copyPromptPay').addEventListener('click', async () => toast(await copyText($('promptPayId').textContent) ? 'คัดลอกเลขพร้อมเพย์แล้ว' : 'คัดลอกไม่สำเร็จ'));
$('qrImg').addEventListener('error', () => { $('qrImg').hidden = true; toast('โหลดรูป QR ไม่สำเร็จ ใช้การโอนเข้าบัญชีแทนได้'); });

api('/api/pay/' + encodeURIComponent(token))
  .then(render)
  .catch(e => { $('loading').hidden = true; show($('errorBox'), e.message); });
