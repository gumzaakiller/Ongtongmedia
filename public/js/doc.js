// Renders an issued document (admin: /doc/:id, customer receipt: /receipt/:token) as an A4 page to print or save as PDF.
const $ = id => document.getElementById(id);
const TH_MONTHS = ['มกราคม', 'กุมภาพันธ์', 'มีนาคม', 'เมษายน', 'พฤษภาคม', 'มิถุนายน', 'กรกฎาคม', 'สิงหาคม', 'กันยายน', 'ตุลาคม', 'พฤศจิกายน', 'ธันวาคม'];
const thaiDate = ymd => `${+ymd.slice(8)} ${TH_MONTHS[+ymd.slice(5, 7) - 1]} ${+ymd.slice(0, 4) + 543}`;
const money = sat => (sat / 100).toLocaleString('th-TH', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const qty = n => n.toLocaleString('th-TH');
function el(tag, props = {}, ...kids) {
  const n = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) { if (k === 'class') n.className = v; else if (k === 'text') n.textContent = v; else n.setAttribute(k, v); }
  for (const k of kids) if (k != null) n.append(k);
  return n;
}
const formatTax = t => t && t.length === 13 ? `${t[0]}-${t.slice(1, 5)}-${t.slice(5, 10)}-${t.slice(10, 12)}-${t[12]}` : t;

function render(d) {
  document.title = `${d.title} ${d.book}/${d.number} | ${d.shop.name}`;
  $('shopName').textContent = d.shop.name;
  $('shopAddress').textContent = d.shop.address || '';
  $('shopPhone').textContent = d.shop.phone ? `โทร. ${d.shop.phone}` : '';
  $('shopTax').textContent = d.shop.taxId ? `เลขประจำตัวผู้เสียภาษีอากร : ${d.shop.taxId}` : '';
  $('docTitle').textContent = d.title;
  $('docBook').textContent = d.book; $('docNo').textContent = d.number;
  $('docDate').textContent = thaiDate(d.issuedDate);
  $('cName').textContent = d.customer.name;
  $('cAddress').textContent = d.customer.address || '-';
  $('cPhone').textContent = d.customer.phone || '-';
  $('cTaxLabel').hidden = $('cTax').hidden = !d.customer.taxId;
  $('cTax').textContent = formatTax(d.customer.taxId);
  $('orderNo').textContent = d.orderNo;

  const rows = d.items.map(i => el('tr', {},
    el('td', { class: 'c-no', text: `${i.position}.` }), el('td', { text: i.description }),
    el('td', { class: 'c-qty', text: qty(i.qty) }), el('td', { class: 'c-price', text: money(i.unitPriceSatang) }), el('td', { class: 'c-amt', text: money(i.amountSatang) })));
  for (let k = rows.length; k < 8; k++) rows.push(el('tr', { class: 'fill' }, ...Array.from({ length: 5 }, () => el('td'))));
  $('lines').replaceChildren(...rows);
  const foot = [];
  if (d.discountSatang) {
    foot.push(el('tr', {}, el('td', { colspan: 3 }), el('td', { class: 'c-price', text: 'รวม' }), el('td', { class: 'c-amt', text: money(d.subtotalSatang) })));
    foot.push(el('tr', {}, el('td', { colspan: 3 }), el('td', { class: 'c-price', text: 'ส่วนลด' }), el('td', { class: 'c-amt', text: money(d.discountSatang) })));
  }
  foot.push(el('tr', {},
    el('td', { colspan: 3, class: 'words' }, 'รวมเงิน (ตัวอักษร)', el('b', { text: `- ${d.amountText} -` })),
    el('td', { class: 'c-price', text: 'รวมเงิน' }), el('td', { class: 'c-amt', text: money(d.totalSatang) })));
  $('foot').replaceChildren(...foot);

  const notes = [];
  if (d.type === 'receipt') {
    if (d.deliveryRef) notes.push(`อ้างอิงใบส่งของ เล่มที่ ${d.deliveryRef.book}/${d.deliveryRef.number}`);
    if (d.paymentMethod) notes.push(`ชำระโดย ${d.paymentMethod}`);
  } else if (d.type === 'delivery') {
    notes.push('ได้รับสินค้าตามรายการถูกต้องแล้ว', 'สินค้าส่งถูกต้องตามรายการไม่รับคืน');
  } else {
    notes.push('กรุณาชำระเงินตามยอดรวมข้างต้น และแจ้งหลักฐานการโอนกับร้าน');
    const p = $('payInfo'); p.hidden = false;
    p.replaceChildren(
      el('div', { text: `โอนเข้าบัญชี ${d.shop.bankName || ''}` }),
      el('div', { text: `ชื่อบัญชี ${d.shop.accountName || ''}` }),
      d.shop.accountNo ? el('div', { text: `เลขที่บัญชี ${d.shop.accountNo}` }) : null,
      d.shop.promptPayId ? el('div', { text: `พร้อมเพย์ ${d.shop.promptPayId}` }) : null);
  }
  $('notes').replaceChildren(...notes.map(n => el('li', { text: n })));

  const signer = d.shop.signer || '..............................................';
  const sign = (role, name) => el('div', { class: 'sign' }, el('div', { class: 'line', text: `ลงชื่อ..........................................${role}` }), el('div', { class: 'who', text: `(${name})` }));
  const blank = '..............................................';
  $('signs').replaceChildren(...(d.type === 'receipt' ? [sign('ผู้รับเงิน', signer)]
    : d.type === 'delivery' ? [sign('ผู้ส่งของ', signer), sign('ผู้รับของ', blank)]
    : [sign('ผู้ออกใบแจ้งหนี้', signer)]));

  $('msg').hidden = true; $('paper').hidden = false;
}

$('printBtn').addEventListener('click', () => print());
$('backBtn').addEventListener('click', () => history.length > 1 ? history.back() : location.assign('/'));

const [kind, key] = location.pathname.split('/').filter(Boolean);
const url = kind === 'doc' ? `/api/admin/documents/${encodeURIComponent(key)}` : `/api/pay/${encodeURIComponent(key)}/receipt`;
fetch(url, { credentials: 'same-origin' })
  .then(async r => { const data = await r.json().catch(() => ({})); if (!r.ok) throw new Error(data.error || 'เปิดเอกสารไม่ได้'); return data.document; })
  .then(render)
  .catch(e => { $('msg').textContent = e.message; $('msg').className = 'msg error no-print'; });
