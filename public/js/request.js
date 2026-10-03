import { $, api, baht, el, show, thaiDateTime } from './util.js';
import { rememberRecent } from './recent.js';

const token = decodeURIComponent(location.pathname.split('/').filter(Boolean)[1] || '');
const REQ_LABEL = { new: 'รอร้านแจ้งราคา', quoted: 'ร้านแจ้งราคาแล้ว', cancelled: 'ยกเลิก' };
const REQ_BADGE = { new: 'pending', quoted: 'paid', cancelled: 'cancelled' };
const BILL_MESSAGE = {
  pending: 'ร้านแจ้งราคาแล้ว กดปุ่มด้านล่างเพื่อดูยอดและชำระเงิน',
  awaiting_verification: 'ร้านได้รับหลักฐานการชำระแล้ว กำลังตรวจสอบ',
  paid: 'ชำระเงินเรียบร้อย ร้านจะเริ่มทำงานของคุณ',
  processing: 'ร้านกำลังทำงานของคุณ',
  completed: 'งานเสร็จเรียบร้อย ขอบคุณที่ใช้บริการ',
  cancelled: 'บิลของคำขอนี้ถูกยกเลิก กรุณาติดต่อร้าน'
};

function render({ request: r }) {
  document.title = `${r.requestNo} | อองตองมีเดีย`;
  rememberRecent(r.requestNo, `คำขอ ${r.categoryName}`);
  let msg = '';
  if (r.status === 'new') msg = 'ร้านได้รับคำขอแล้ว จะแจ้งราคากลับทางเบอร์โทรหรือ LINE ที่ให้ไว้';
  if (r.status === 'cancelled') msg = `คำขอนี้ถูกยกเลิก${r.cancelReason ? `: ${r.cancelReason}` : ''}`;
  if (r.bill) msg = `${BILL_MESSAGE[r.bill.status] || ''}\nเลขที่บิล ${r.bill.orderNo}  ยอด ${baht(r.bill.totalSatang)}`;
  $('statusBox').textContent = msg;
  $('statusBox').className = `status-box ${r.bill ? (r.bill.status === 'pending' ? 'quoted' : r.bill.status) : r.status === 'new' ? 'awaiting_verification' : 'cancelled'}`;
  $('payBtn').hidden = !r.bill;
  if (r.bill) { $('payBtn').href = new URL(r.bill.payUrl).pathname; $('payBtn').textContent = r.bill.status === 'pending' ? `ดูยอด ${baht(r.bill.totalSatang)} และชำระเงิน` : 'ดูบิล'; }

  $('reqNo').textContent = r.requestNo;
  $('reqSummary').textContent = r.summary;
  $('reqBadge').className = `badge ${REQ_BADGE[r.status]}`; $('reqBadge').textContent = REQ_LABEL[r.status];
  const d = r.details; const rows = [['งาน', r.categoryName]];
  if (d.width && d.height) rows.push(['ขนาด', `${d.width} × ${d.height} ${d.unit === 'm' ? 'เมตร' : 'ซม.'}`]);
  rows.push(['จำนวน', `${d.qty}`]);
  if (d.options?.length) rows.push(['ตัวเลือก', d.options.join(', ')]);
  rows.push(['ไฟล์งาน', d.artworkLabel]);
  if (d.deadline) rows.push(['ต้องการรับงาน', new Date(d.deadline + 'T00:00:00+07:00').toLocaleDateString('th-TH', { dateStyle: 'medium', timeZone: 'Asia/Bangkok' })]);
  rows.push(['ส่งคำขอเมื่อ', thaiDateTime(r.createdAt)]);
  $('reqDetails').replaceChildren(...rows.flatMap(([k, v]) => [el('dt', { text: k }), el('dd', { text: v })]));
  $('reqNoteWrap').hidden = !d.details; $('reqNote').textContent = d.details;
  $('reqFilesWrap').hidden = !r.files.length;
  $('reqFiles').replaceChildren(...r.files.map(f => el('li', { text: f.name })));
  $('lineBtn').href = `https://line.me/R/oaMessage/${encodeURIComponent('@653ercqc')}/?${encodeURIComponent(`สอบถามคำขอ ${r.requestNo}`)}`;
  $('loading').hidden = true; $('content').hidden = false;
}

api('/api/requests/' + encodeURIComponent(token)).then(render)
  .catch(e => { $('loading').hidden = true; show($('errorBox'), e.message); });
