import { $, STATUS_LABEL, ApiError, api, baht, copyText, el, show, thaiDateTime, toSatang, toast } from './util.js';

const FILTERS = [['', 'ทั้งหมด'], ['pending', 'รอชำระเงิน'], ['awaiting_verification', 'รอตรวจสลิป'], ['paid', 'ชำระแล้ว'], ['processing', 'กำลังดำเนินการ'], ['completed', 'เสร็จสิ้น'], ['cancelled', 'ยกเลิก']];
// Buttons offered per status (must match MANUAL_TRANSITIONS on the server).
const ACTIONS = {
  pending: [['cancelled', 'ยกเลิกรายการนี้', 'danger', 'ยกเลิกรายการนี้? ลูกค้าจะชำระผ่านลิงก์นี้ไม่ได้อีก']],
  paid: [['processing', 'เริ่มดำเนินการ', 'primary'], ['completed', 'งานเสร็จแล้ว', '']],
  processing: [['completed', 'งานเสร็จแล้ว', 'primary']]
};

const state = { view: null, status: '', q: '', cursor: null, current: null, customer: null, createKey: null, busy: false, incomeCursor: null };
const METHOD_LABEL = { promptpay: 'พร้อมเพย์', bank_transfer: 'โอนเข้าบัญชี', cash: 'เงินสด', other: 'อื่นๆ' };
const PAY_LABEL = { submitted: 'รอตรวจ', verified: 'ยืนยันแล้ว', rejected: 'ไม่ผ่าน' };
const todayYmd = () => new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Bangkok' });
const thaiDate = ymd => new Date(ymd + 'T00:00:00+07:00').toLocaleDateString('th-TH', { timeZone: 'Asia/Bangkok', day: 'numeric', month: 'short', year: '2-digit' });
const isDesktop = () => matchMedia('(min-width: 960px)').matches;

/* ---------------- session ---------------- */
function onAuthError(e) {
  if (e instanceof ApiError && e.status === 401) { showLogin(); return true; }
  return false;
}
function showLogin() { $('appView').hidden = true; $('loginView').hidden = false; $('password').focus(); }
async function showApp() {
  $('loginView').hidden = true; $('appView').hidden = false;
  api('/api/config').then(c => { $('envFlag').hidden = c.env === 'production'; }).catch(() => {});
  await setView(state.view || 'dash');
}

/* ---------------- views ---------------- */
const VIEWS = { dash: 'dashView', requests: 'requestsView', orders: 'ordersView', income: 'incomeView', gallery: 'galleryView' };
async function setView(name) {
  state.view = name;
  for (const [v, id] of Object.entries(VIEWS)) $(id).hidden = v !== name;
  for (const b of document.querySelectorAll('.tab-btn')) b.setAttribute('aria-pressed', String(b.dataset.view === name));
  if (name !== 'orders') { $('side').classList.remove('detail-open'); document.body.style.overflow = ''; }
  if (name !== 'requests') $('reqSide').classList.remove('detail-open');
  scrollTo(0, 0);
  if (name === 'dash') return loadDashboard();
  if (name === 'income') return loadIncome();
  if (name === 'requests') return loadRequests();
  if (name === 'gallery') return loadGallery();
  await loadOrders();
  if (isDesktop() && !state.current) openCreate();
}
for (const b of document.querySelectorAll('.tab-btn')) b.addEventListener('click', () => setView(b.dataset.view));
async function goToOrder(orderNo) { state.view = 'orders'; await setView('orders'); await openOrder(orderNo); }

$('loginForm').addEventListener('submit', async e => {
  e.preventDefault();
  const btn = e.submitter; btn.disabled = true; show($('loginError'), '');
  try {
    await api('/api/admin/login', { method: 'POST', body: { password: $('password').value } });
    $('password').value = ''; await showApp();
  } catch (err) { show($('loginError'), err.message); }
  finally { btn.disabled = false; }
});
$('logoutBtn').addEventListener('click', async () => {
  try { await api('/api/admin/logout', { method: 'POST' }); } catch {}
  state.current = null; showLogin();
});

/* ---------------- list ---------------- */
for (const [value, label] of FILTERS) {
  $('statusChips').append(el('button', { class: 'chip', type: 'button', 'aria-pressed': String(value === state.status), 'data-status': value, text: label, onclick: () => {
    state.status = value;
    for (const c of $('statusChips').children) c.setAttribute('aria-pressed', String(c.dataset.status === value));
    loadOrders();
  } }));
}
let searchTimer;
$('searchInput').addEventListener('input', () => { clearTimeout(searchTimer); searchTimer = setTimeout(() => { state.q = $('searchInput').value.trim(); loadOrders(); }, 300); });
$('reloadBtn').addEventListener('click', () => loadOrders());
$('moreBtn').addEventListener('click', () => loadOrders(true));

let listSeq = 0;
async function loadOrders(more = false) {
  const seq = ++listSeq;
  const params = new URLSearchParams();
  if (state.status) params.set('status', state.status);
  if (state.q) params.set('q', state.q);
  if (more && state.cursor) params.set('cursor', state.cursor);
  $('moreBtn').disabled = true; show($('listError'), '');
  try {
    const data = await api('/api/admin/orders?' + params);
    if (seq !== listSeq) return; // a newer search finished first
    if (!more) $('orderList').replaceChildren();
    data.orders.forEach(o => $('orderList').append(orderRow(o)));
    if (!$('orderList').children.length) {
      $('orderList').append(el('li', { class: 'empty muted', text: state.q || state.status ? 'ไม่พบรายการที่ตรงกับการค้นหา' : 'ยังไม่มีรายการ กด "สร้างรายการเรียกเก็บเงิน" เพื่อเริ่ม' }));
    }
    state.cursor = data.nextCursor; $('moreBtn').hidden = !data.nextCursor;
  } catch (e) { if (!onAuthError(e)) show($('listError'), e.message); }
  finally { $('moreBtn').disabled = false; }
}

function orderRow(o) {
  return el('li', {}, el('button', { class: 'order-row', type: 'button', 'data-no': o.orderNo, 'aria-current': String(state.current?.orderNo === o.orderNo), onclick: () => openOrder(o.orderNo) },
    el('span', { class: 'who', text: o.customerName }),
    el('span', { class: 'amt num', text: baht(o.totalSatang) }),
    el('span', { class: 'meta', text: `${o.orderNo}  ${o.title}` }),
    el('span', {}, el('span', { class: `badge ${o.status}`, text: STATUS_LABEL[o.status] }))
  ));
}
function markCurrent() {
  for (const b of $('orderList').querySelectorAll('.order-row')) b.setAttribute('aria-current', String(b.dataset.no === state.current?.orderNo));
}

/* ---------------- side panel ---------------- */
function openSide(which) {
  $('createForm').hidden = which !== 'create';
  $('ticket').hidden = which !== 'ticket';
  $('side').classList.toggle('detail-open', !isDesktop() && which !== null);
  document.body.style.overflow = !isDesktop() && which ? 'hidden' : '';
}
function closeSide() {
  state.current = null; markCurrent();
  if (isDesktop()) openCreate(); else openSide(null);
}

/* ---------------- create ---------------- */
$('newBtn').addEventListener('click', () => openCreate());
$('createCancel').addEventListener('click', closeSide);
$('addItem').addEventListener('click', () => { addItemRow(); recalc(); });
$('createForm').addEventListener('input', recalc);

let itemSeq = 0;
function addItemRow(focus = true) {
  if ($('items').children.length >= 50) return toast('เพิ่มได้ไม่เกิน 50 รายการ');
  const id = ++itemSeq;
  const row = el('div', { class: 'item' },
    el('div', { class: 'desc' }, el('label', { for: `d${id}`, text: 'รายการ' }), el('input', { id: `d${id}`, class: 'i-desc', maxlength: '300', placeholder: 'เช่น ไวนิล 2x1 ม.', autocomplete: 'off' })),
    el('div', {}, el('label', { for: `q${id}`, text: 'จำนวน' }), el('input', { id: `q${id}`, class: 'i-qty num', inputmode: 'numeric', value: '1', autocomplete: 'off' })),
    el('div', {}, el('label', { for: `p${id}`, text: 'ราคาต่อหน่วย' }), el('input', { id: `p${id}`, class: 'i-price num', inputmode: 'decimal', placeholder: '0.00', autocomplete: 'off' })),
    el('button', { class: 'btn remove', type: 'button', 'aria-label': 'ลบรายการนี้', text: '×', onclick: () => { if ($('items').children.length > 1) { row.remove(); recalc(); } } })
  );
  $('items').append(row);
  if (focus) row.querySelector('.i-desc').focus();
}

function readItems() {
  return [...$('items').querySelectorAll('.item')].map(r => ({
    description: r.querySelector('.i-desc').value.trim(),
    qty: r.querySelector('.i-qty').value.trim(),
    unitPrice: r.querySelector('.i-price').value.trim()
  }));
}
function recalc() {
  let sub = 0, ok = true;
  for (const i of readItems()) {
    const q = /^\d+$/.test(i.qty) ? Number(i.qty) : NaN; const p = toSatang(i.unitPrice);
    if (Number.isNaN(q) || Number.isNaN(p)) ok = false; else sub += q * p;
  }
  const disc = toSatang($('discount').value);
  $('tSub').textContent = ok ? baht(sub) : '—';
  $('tDisc').textContent = Number.isNaN(disc) ? '—' : baht(disc);
  $('tTotal').textContent = ok && !Number.isNaN(disc) ? baht(Math.max(sub - disc, 0)) : '—';
}

function resetCreate() {
  $('createForm').reset(); $('items').replaceChildren(); addItemRow(false);
  setCustomer(null); show($('createError'), ''); recalc();
  state.createKey = null; state.fromRequest = null;
  $('createTitle').textContent = 'สร้างรายการเรียกเก็บเงิน'; $('fromReqNote').hidden = true;
  $('createSubmit').textContent = 'สร้างรายการและรับลิงก์';
}
function openCreate() {
  state.current = null; markCurrent();
  resetCreate(); openSide('create');
  if (!isDesktop()) $('side').scrollTop = 0;
}

// Customer lookup: pick an existing customer or type a new one.
function setCustomer(c) {
  state.customer = c;
  $('customerPicked').hidden = !c; $('customerFields').hidden = !!c;
  if (c) $('customerPickedName').textContent = [c.name, c.phone, c.lineId && `LINE ${c.lineId}`].filter(Boolean).join('  ');
  $('cSuggest').hidden = true;
}
$('customerClear').addEventListener('click', () => { setCustomer(null); $('cName').focus(); });
let suggestTimer, suggestSeq = 0;
$('cName').addEventListener('input', () => {
  clearTimeout(suggestTimer);
  const q = $('cName').value.trim();
  if (q.length < 2) { $('cSuggest').hidden = true; return; }
  suggestTimer = setTimeout(async () => {
    const seq = ++suggestSeq;
    try {
      const { customers } = await api('/api/admin/customers?q=' + encodeURIComponent(q));
      if (seq !== suggestSeq) return;
      $('cSuggest').replaceChildren(...customers.map(c => el('li', {}, el('button', { type: 'button', onclick: () => setCustomer(c) },
        el('b', { text: c.name }), el('div', { class: 'small muted', text: [c.phone, c.lineId && `LINE ${c.lineId}`].filter(Boolean).join('  ') || 'ลูกค้าเดิม' })))));
      $('cSuggest').hidden = !customers.length;
    } catch (e) { onAuthError(e); }
  }, 250);
});
$('cName').addEventListener('keydown', e => { if (e.key === 'Escape') $('cSuggest').hidden = true; });
document.addEventListener('click', e => { if (!e.target.closest('.suggest')) $('cSuggest').hidden = true; });

$('createForm').addEventListener('submit', async e => {
  e.preventDefault();
  if (state.busy) return;
  show($('createError'), '');
  const body = {
    customer: state.customer ? { id: state.customer.id } : { name: $('cName').value, phone: $('cPhone').value, lineId: $('cLine').value },
    title: $('title').value, items: readItems(), discount: $('discount').value,
    note: $('note').value, internalNote: $('internalNote').value
  };
  if (!state.customer && !body.customer.name.trim()) { show($('createError'), 'กรุณากรอกชื่อลูกค้า'); $('cName').focus(); return; }
  // Same key until success: a retry after a network error cannot create a second bill.
  state.createKey ||= crypto.randomUUID();
  state.busy = true; $('createSubmit').disabled = true; $('createSubmit').textContent = 'กำลังสร้าง...';
  try {
    const fromReq = state.fromRequest;
    const { order } = fromReq
      ? await api(`/api/admin/requests/${encodeURIComponent(fromReq.requestNo)}/quote`, { method: 'POST', body: { ...body, requestVersion: fromReq.version }, headers: { 'Idempotency-Key': state.createKey } })
      : await api('/api/admin/orders', { method: 'POST', body, headers: { 'Idempotency-Key': state.createKey } });
    state.createKey = null; state.fromRequest = null; refreshRequestCount();
    await loadOrders();
    renderTicket(order); openSide('ticket');
    toast('สร้างรายการแล้ว');
  } catch (err) {
    if (!onAuthError(err)) show($('createError'), err.message);
    if (err.status && err.status < 500 && err.status !== 429) state.createKey = null; // input problem: next try is a new request
  } finally { state.busy = false; $('createSubmit').disabled = false; $('createSubmit').textContent = state.fromRequest ? 'ออกบิลและรับลิงก์ชำระเงิน' : 'สร้างรายการและรับลิงก์'; }
});

/* ---------------- ticket ---------------- */
$('ticketClose').addEventListener('click', closeSide);
async function openOrder(orderNo) {
  try { const { order } = await api('/api/admin/orders/' + encodeURIComponent(orderNo)); renderTicket(order); openSide('ticket'); }
  catch (e) { if (!onAuthError(e)) toast(e.message); }
}

function shareMessage(o) {
  return [
    `สวัสดีค่ะ ${/^คุณ/.test(o.customer.name) ? '' : 'คุณ'}${o.customer.name}`,
    `อองตองมีเดียแจ้งยอดชำระ ${o.title}`,
    `ยอดชำระ ${baht(o.totalSatang)}`,
    `เลขที่ ${o.orderNo}`,
    '',
    'ชำระเงินและแจ้งสลิปได้ที่ลิงก์นี้',
    o.payUrl,
    '',
    'ขอบคุณค่ะ'
  ].join('\n');
}

function renderTicket(o) {
  state.current = o; markCurrent();
  $('tkNo').textContent = o.orderNo;
  $('tkTitle').textContent = o.title;
  $('tkStatus').className = `badge ${o.status}`; $('tkStatus').textContent = STATUS_LABEL[o.status];
  $('tkCustomer').textContent = o.customer.name;
  $('tkContact').textContent = [o.customer.phone, o.customer.lineId && `LINE ${o.customer.lineId}`].filter(Boolean).join('  ');
  $('tkLines').replaceChildren(...o.items.map(i => el('tr', {},
    el('td', {}, i.description, el('div', { class: 'q', text: `${i.qty} × ${baht(i.unitPriceSatang)}` })),
    el('td', { text: baht(i.amountSatang) }))));
  $('tkSub').textContent = baht(o.subtotalSatang);
  $('tkDiscRow').hidden = !o.discountSatang; $('tkDisc').textContent = '−' + baht(o.discountSatang);
  $('tkTotal').textContent = baht(o.totalSatang);
  $('shareBox').hidden = o.status === 'cancelled';
  $('tkLink').value = o.payUrl; $('openLink').href = o.payUrl;
  $('tkNoteWrap').hidden = !o.note; $('tkNote').textContent = o.note;
  $('tkInternalWrap').hidden = !o.internalNote; $('tkInternal').textContent = o.internalNote;
  renderPayments(o);
  show($('ticketError'), '');
  $('tkActions').replaceChildren(...(ACTIONS[o.status] || []).map(([to, label, kind, confirmText]) =>
    el('button', { class: `btn block ${kind}`, type: 'button', text: label, onclick: e => changeStatus(o, to, confirmText, e.currentTarget) })));
  $('tkEvents').replaceChildren(...o.events.slice().reverse().map(ev =>
    el('li', {}, el('b', { text: STATUS_LABEL[ev.to] }), ` ${thaiDateTime(ev.at)}`, ev.note ? el('div', { class: 'muted', text: ev.note }) : null)));
  if (!isDesktop()) $('side').scrollTop = 0;
}

async function changeStatus(o, to, confirmText, btn) {
  if (confirmText && !confirm(confirmText)) return;
  btn.disabled = true; show($('ticketError'), '');
  try {
    const { order } = await api(`/api/admin/orders/${encodeURIComponent(o.orderNo)}/status`, { method: 'POST', body: { to, version: o.version } });
    renderTicket(order); loadOrders(); toast(`เปลี่ยนเป็น "${STATUS_LABEL[to]}" แล้ว`);
  } catch (e) {
    if (onAuthError(e)) return;
    show($('ticketError'), e.message);
    if (e.status === 409) openOrder(o.orderNo).then(() => show($('ticketError'), e.message));
  } finally { btn.disabled = false; }
}

$('copyLink').addEventListener('click', async () => { toast(await copyText(state.current.payUrl) ? 'คัดลอกลิงก์แล้ว' : 'คัดลอกไม่สำเร็จ กดค้างที่ลิงก์เพื่อคัดลอกเอง'); });
$('copyMessage').addEventListener('click', async () => { toast(await copyText(shareMessage(state.current)) ? 'คัดลอกข้อความแล้ว วางในแชท LINE ได้เลย' : 'คัดลอกไม่สำเร็จ'); });
$('tkLink').addEventListener('focus', e => e.target.select());

/* ---------------- payments (ticket) ---------------- */
function renderPayments(o) {
  $('tkPayWrap').hidden = !o.payments.length && o.status !== 'pending';
  $('tkPayments').replaceChildren(...o.payments.map(p => el('div', { class: `pay-item ${p.status}` },
    el('div', { class: 'row' },
      el('b', { class: 'num', text: `${baht(p.amountSatang)}  ${METHOD_LABEL[p.method] || p.method}` }),
      el('span', { class: `badge ${p.status}`, text: PAY_LABEL[p.status] })),
    el('div', { class: 'small muted', text: `${p.hasSlip ? 'ลูกค้าส่งสลิป' : p.byCustomer ? 'ลูกค้าแจ้งโอนแล้ว (ไม่มีสลิป)' : 'บันทึกโดยร้าน'} ${thaiDateTime(p.submittedAt)}` }),
    !p.hasSlip && p.byCustomer && p.status === 'submitted' ? el('div', { class: 'notice warn small', text: 'ไม่มีสลิป: เปิดแอปธนาคารเช็คว่ามีเงินเข้าตามยอดนี้ก่อนกดยืนยัน' }) : null,
    p.customerNote ? el('div', { class: 'small', text: `ข้อความ: ${p.customerNote}` }) : null,
    p.rejectReason ? el('div', { class: 'small', text: `เหตุผลที่ไม่ผ่าน: ${p.rejectReason}` }) : null,
    p.hasSlip ? el('a', { class: 'slip', href: `/api/admin/payments/${p.id}/slip`, target: '_blank', rel: 'noopener', title: 'เปิดสลิปขนาดเต็ม' },
      el('img', { src: `/api/admin/payments/${p.id}/slip`, alt: `สลิปการชำระของ ${o.orderNo}`, loading: 'lazy' })) : null,
    p.status === 'submitted' ? el('div', { class: 'acts' },
      el('button', { class: 'btn primary', type: 'button', text: 'ยืนยันการชำระเงิน', onclick: e => reviewPayment(o, p, 'verify', e.currentTarget) }),
      el('button', { class: 'btn danger', type: 'button', text: p.hasSlip ? 'สลิปไม่ผ่าน' : 'ไม่พบเงินเข้า', onclick: e => reviewPayment(o, p, 'reject', e.currentTarget) })) : null
  )));
  $('manualBox').hidden = o.status !== 'pending';
  $('manualBox').open = false;
  $('mDate').value = todayYmd(); $('mDate').max = todayYmd(); $('mNote').value = '';
}

async function reviewPayment(o, p, action, btn) {
  let body = { version: o.version };
  if (action === 'verify') {
    if (!confirm(`ตรวจแล้วว่ามีเงินเข้าบัญชี ${baht(p.amountSatang)} จริง?\nเมื่อยืนยัน ระบบจะลงรายรับให้อัตโนมัติ`)) return;
  } else {
    const reason = p.hasSlip
      ? prompt('เหตุผลที่สลิปไม่ผ่าน (ลูกค้าจะเห็นข้อความนี้)', 'ยอดในสลิปไม่ตรงกับยอดที่ต้องชำระ')
      : prompt('แจ้งลูกค้าว่าอย่างไร (ลูกค้าจะเห็นข้อความนี้)', 'ร้านยังไม่พบยอดเงินเข้า กรุณาส่งสลิปหรือทักแชทร้าน');
    if (reason === null) return;
    if (!reason.trim()) return toast('กรุณาใส่เหตุผล');
    body.reason = reason.trim();
  }
  btn.disabled = true; show($('ticketError'), '');
  try {
    const { order } = await api(`/api/admin/payments/${p.id}/${action}`, { method: 'POST', body });
    renderTicket(order); loadOrders();
    toast(action === 'verify' ? 'ยืนยันแล้ว ลงรายรับเรียบร้อย' : 'แจ้งลูกค้าว่าสลิปไม่ผ่านแล้ว');
  } catch (e) {
    if (onAuthError(e)) return;
    if (e.status === 409) await openOrder(o.orderNo);
    show($('ticketError'), e.message);
  } finally { btn.disabled = false; }
}

$('mSubmit').addEventListener('click', async () => {
  const o = state.current; const btn = $('mSubmit');
  const method = $('mMethod').value; const receivedDate = $('mDate').value;
  if (!receivedDate) return toast('กรุณาเลือกวันที่รับเงิน');
  if (!confirm(`บันทึกว่าได้รับเงิน ${baht(o.totalSatang)} (${METHOD_LABEL[method]}) วันที่ ${thaiDate(receivedDate)}?\nระบบจะเปลี่ยนเป็นชำระแล้วและลงรายรับ`)) return;
  btn.disabled = true; show($('ticketError'), '');
  try {
    const { order } = await api(`/api/admin/orders/${encodeURIComponent(o.orderNo)}/payments`, { method: 'POST', body: { version: o.version, method, receivedDate, note: $('mNote').value } });
    renderTicket(order); loadOrders(); toast('บันทึกรับเงินและลงรายรับแล้ว');
  } catch (e) {
    if (onAuthError(e)) return;
    if (e.status === 409) await openOrder(o.orderNo);
    show($('ticketError'), e.message);
  } finally { btn.disabled = false; }
});

/* ---------------- dashboard ---------------- */
async function loadDashboard() {
  show($('dashError'), '');
  try {
    const d = await api('/api/admin/dashboard');
    $('dReceived').textContent = baht(d.receivedToday.totalSatang);
    $('dReceivedSub').textContent = `${d.receivedToday.count} รายการ  ${thaiDate(d.today)}`;
    const fig = (id, main, sub) => $(id).replaceChildren(main, sub ? el('small', { text: sub }) : '');
    fig('dMonth', baht(d.receivedThisMonth.totalSatang), `${d.receivedThisMonth.count} รายการ`);
    fig('dCreated', baht(d.ordersToday.totalSatang), `${d.ordersToday.count} บิล`);
    fig('dUnpaid', baht(d.unpaid.totalSatang), `${d.unpaid.count} บิล`);
    fig('dInProgress', `${d.inProgress.count} งาน`);
    const max = Math.max(...d.last7Days.map(x => x.totalSatang), 1);
    $('dBars').replaceChildren(...d.last7Days.map(x => {
      const fill = el('div', { class: 'fill' }); fill.style.height = `${Math.round((x.totalSatang / max) * 100)}%`;
      const day = new Date(x.date + 'T00:00:00+07:00').toLocaleDateString('th-TH', { timeZone: 'Asia/Bangkok', weekday: 'short' });
      return el('div', { class: `bar${x.date === d.today ? ' today' : ''}`, title: `${thaiDate(x.date)} ${baht(x.totalSatang)}` },
        el('span', { class: 'v', text: x.totalSatang ? Math.round(x.totalSatang / 100).toLocaleString('th-TH') : '' }), fill, el('span', { text: day }));
    }));
    $('dNewReq').hidden = !d.newRequests.count; $('dNewReqCount').textContent = d.newRequests.count;
    setRequestCount(d.newRequests.count);
    $('dAwaitCount').textContent = d.awaitingVerification.count;
    $('dAwaitSum').textContent = d.awaitingVerification.count ? `รวม ${baht(d.awaitingVerification.totalSatang)} ตรวจยอดเงินเข้าแล้วกดยืนยันในแต่ละรายการ` : 'ไม่มีสลิปรอตรวจ';
    $('dAwaitList').replaceChildren(...d.awaitingList.map(o => el('li', {}, el('button', { class: 'order-row', type: 'button', onclick: () => goToOrder(o.orderNo) },
      el('span', { class: 'who', text: o.customerName }), el('span', { class: 'amt num', text: baht(o.totalSatang) }),
      el('span', { class: 'meta', text: `${o.orderNo}  ${o.title}` }), el('span', {}, el('span', { class: 'badge awaiting_verification', text: 'รอตรวจสลิป' }))))));
    $('dAwaitList').hidden = !d.awaitingList.length;
  } catch (e) { if (!onAuthError(e)) show($('dashError'), e.message); }
}

/* ---------------- income ---------------- */
function incomeParams() {
  const p = new URLSearchParams();
  if ($('fMonth').value) p.set('month', $('fMonth').value);
  else { if ($('fFrom').value) p.set('from', $('fFrom').value); if ($('fTo').value) p.set('to', $('fTo').value); }
  if ($('fQ').value.trim()) p.set('q', $('fQ').value.trim());
  return p;
}
$('fMonth').addEventListener('change', () => { if ($('fMonth').value) { $('fFrom').value = ''; $('fTo').value = ''; } });
for (const id of ['fFrom', 'fTo']) $(id).addEventListener('change', () => { if ($(id).value) $('fMonth').value = ''; });
$('incomeFilter').addEventListener('submit', e => { e.preventDefault(); loadIncome(); });
$('fClear').addEventListener('click', () => { $('incomeFilter').reset(); loadIncome(); });
$('incomeMore').addEventListener('click', () => loadIncome(true));

async function loadIncome(more = false) {
  if (!state.view) return;
  if (!more && !$('fMonth').value && !$('fFrom').value && !$('fTo').value && !state.incomeTouched) $('fMonth').value = todayYmd().slice(0, 7);
  state.incomeTouched = true;
  const params = incomeParams();
  $('csvLink').href = '/api/admin/income.csv?' + params;
  if (more && state.incomeCursor) params.set('cursor', state.incomeCursor);
  show($('incomeError'), ''); $('incomeMore').disabled = true;
  try {
    const d = await api('/api/admin/income?' + params);
    if (!more) $('incomeRows').replaceChildren();
    $('incomeSum').replaceChildren(el('span', { text: `รวม ${d.totals.count} รายการ` }), el('b', { text: baht(d.totals.totalSatang) }));
    for (const i of d.income) {
      $('incomeRows').append(el('tr', {},
        el('td', { text: thaiDate(i.receivedDate) }),
        el('td', {}, el('button', { type: 'button', text: i.orderNo, onclick: () => goToOrder(i.orderNo) })),
        el('td', {}, i.customerName, el('div', { class: 'sub', text: i.title })),
        el('td', { text: METHOD_LABEL[i.method] || i.method }),
        el('td', { class: 'r', text: baht(i.amountSatang) })));
    }
    if (!$('incomeRows').children.length) $('incomeRows').append(el('tr', {}, el('td', { colspan: '5', class: 'empty muted', text: 'ไม่มีรายรับในช่วงที่เลือก' })));
    state.incomeCursor = d.nextCursor; $('incomeMore').hidden = !d.nextCursor;
  } catch (e) { if (!onAuthError(e)) show($('incomeError'), e.message); }
  finally { $('incomeMore').disabled = false; }
}

/* ---------------- job requests ---------------- */
const REQ_LABEL = { new: 'ใหม่', quoted: 'แจ้งราคาแล้ว', cancelled: 'ยกเลิก' };
const REQ_BADGE = { new: 'awaiting_verification', quoted: 'paid', cancelled: 'cancelled' };
const REQ_FILTERS = [['new', 'ใหม่'], ['quoted', 'แจ้งราคาแล้ว'], ['cancelled', 'ยกเลิก'], ['', 'ทั้งหมด']];
state.reqStatus = 'new'; state.reqCursor = null; state.request = null;
function setRequestCount(n, more = false) { $('reqCount').textContent = more ? `${n}+` : String(n); $('reqCount').hidden = !n; }
function refreshRequestCount() { api('/api/admin/requests?status=new').then(d => setRequestCount(d.requests.length, !!d.nextCursor)).catch(() => {}); }
$('dNewReq').addEventListener('click', () => setView('requests'));
for (const [value, label] of REQ_FILTERS) {
  $('reqChips').append(el('button', { class: 'chip', type: 'button', 'aria-pressed': String(value === state.reqStatus), 'data-status': value, text: label, onclick: () => {
    state.reqStatus = value;
    for (const c of $('reqChips').children) c.setAttribute('aria-pressed', String(c.dataset.status === value));
    loadRequests();
  } }));
}
$('reqReload').addEventListener('click', () => loadRequests());
$('reqMore').addEventListener('click', () => loadRequests(true));
$('reqClose').addEventListener('click', () => { $('reqSide').classList.remove('detail-open'); document.body.style.overflow = ''; state.request = null; $('reqTicket').hidden = true; $('reqEmptySide').hidden = false; });

async function loadRequests(more = false) {
  const p = new URLSearchParams(); if (state.reqStatus) p.set('status', state.reqStatus);
  if (more && state.reqCursor) p.set('cursor', state.reqCursor);
  show($('reqError'), '');
  try {
    const d = await api('/api/admin/requests?' + p);
    if (!more) $('reqList').replaceChildren();
    for (const r of d.requests) $('reqList').append(el('li', {}, el('button', { class: 'order-row', type: 'button', 'data-no': r.requestNo, onclick: () => openRequest(r.requestNo) },
      el('span', { class: 'who', text: r.customerName }), el('span', { class: 'meta', text: thaiDateTime(r.createdAt) }),
      el('span', { class: 'meta', text: `${r.requestNo}  ${r.summary}${r.files ? `  แนบ ${r.files} ไฟล์` : ''}` }),
      el('span', {}, el('span', { class: `badge ${REQ_BADGE[r.status]}`, text: REQ_LABEL[r.status] })))));
    if (!$('reqList').children.length) $('reqList').append(el('li', { class: 'empty muted', text: state.reqStatus === 'new' ? 'ไม่มีคำขอใหม่' : 'ไม่มีคำขอ' }));
    state.reqCursor = d.nextCursor; $('reqMore').hidden = !d.nextCursor;
    if (state.reqStatus === 'new' && !more) setRequestCount(d.requests.length, !!d.nextCursor);
  } catch (e) { if (!onAuthError(e)) show($('reqError'), e.message); }
}

async function openRequest(no) {
  try {
    const { request: r } = await api('/api/admin/requests/' + encodeURIComponent(no));
    state.request = r; renderRequest(r);
    $('reqTicket').hidden = false; $('reqEmptySide').hidden = true;
    if (!isDesktop()) { $('reqSide').classList.add('detail-open'); document.body.style.overflow = 'hidden'; $('reqSide').scrollTop = 0; }
  } catch (e) { if (!onAuthError(e)) toast(e.message); }
}

function renderRequest(r) {
  $('rqNo').textContent = r.requestNo; $('rqSummary').textContent = r.summary;
  $('rqStatus').className = `badge ${REQ_BADGE[r.status]}`; $('rqStatus').textContent = REQ_LABEL[r.status];
  $('rqCustomer').textContent = r.customer.name;
  $('rqContact').replaceChildren(...[
    r.customer.phone ? el('a', { href: `tel:${r.customer.phone.replace(/[^\d+]/g, '')}`, text: `โทร ${r.customer.phone}` }) : null,
    r.customer.lineId ? el('span', { text: `  LINE ${r.customer.lineId}` }) : null].filter(Boolean));
  const d = r.details; const rows = [['งาน', r.categoryName]];
  if (d.width && d.height) rows.push(['ขนาด', `${d.width} × ${d.height} ${d.unit === 'm' ? 'เมตร' : 'ซม.'}`]);
  rows.push(['จำนวน', String(d.qty)]);
  if (d.options?.length) rows.push(['ตัวเลือก', d.options.join(', ')]);
  rows.push(['ไฟล์งาน', d.artworkLabel]);
  if (d.deadline) rows.push(['ต้องการรับงาน', thaiDate(d.deadline)]);
  rows.push(['ส่งคำขอเมื่อ', thaiDateTime(r.createdAt)]);
  $('rqDetails').replaceChildren(...rows.flatMap(([k, v]) => [el('dt', { text: k }), el('dd', { text: v })]));
  $('rqNoteWrap').hidden = !d.details; $('rqNote').textContent = d.details;
  $('rqFilesWrap').hidden = !r.files.length;
  $('rqFiles').replaceChildren(...r.files.map(f => {
    const url = `/api/admin/request-files/${f.id}`;
    return f.mime === 'application/pdf'
      ? el('a', { class: 'pdf', href: url, target: '_blank', rel: 'noopener', text: `PDF: ${f.name}` })
      : el('a', { href: url, target: '_blank', rel: 'noopener', title: f.name }, el('img', { src: url, alt: f.name, loading: 'lazy' }));
  }));
  $('rqBill').hidden = !r.bill;
  if (r.bill) $('rqBill').textContent = `ออกบิลแล้ว ${r.bill.orderNo} ยอด ${baht(r.bill.totalSatang)} (${STATUS_LABEL[r.bill.status]})`;
  $('rqTrack').href = r.trackUrl;
  show($('rqError'), '');
  const acts = [];
  if (r.status === 'new') {
    acts.push(el('button', { class: 'btn primary block', type: 'button', text: 'แจ้งราคา / ออกบิล', onclick: () => quoteFromRequest(r) }));
    acts.push(el('button', { class: 'btn danger block', type: 'button', text: 'ยกเลิกคำขอ', onclick: e => cancelReq(r, e.currentTarget) }));
  }
  if (r.bill) acts.push(el('button', { class: 'btn block', type: 'button', text: `เปิดบิล ${r.bill.orderNo}`, onclick: () => goToOrder(r.bill.orderNo) }));
  $('rqActions').replaceChildren(...acts);
}

async function cancelReq(r, btn) {
  const reason = prompt('เหตุผลที่ยกเลิก (ลูกค้าเห็นข้อความนี้)', 'ร้านไม่สามารถรับงานนี้ได้');
  if (reason === null) return;
  btn.disabled = true;
  try {
    const { request } = await api(`/api/admin/requests/${encodeURIComponent(r.requestNo)}/cancel`, { method: 'POST', body: { version: r.version, reason } });
    state.request = request; renderRequest(request); loadRequests(); toast('ยกเลิกคำขอแล้ว');
  } catch (e) { if (!onAuthError(e)) { show($('rqError'), e.message); if (e.status === 409) openRequest(r.requestNo); } }
  finally { btn.disabled = false; }
}

// Opens the normal bill form, pre-filled from the request. Saving it quotes the request (one transaction on the server).
async function quoteFromRequest(r) {
  $('reqSide').classList.remove('detail-open'); document.body.style.overflow = '';
  state.view = 'orders'; await setView('orders');
  openCreate();
  state.fromRequest = { requestNo: r.requestNo, version: r.version };
  $('createTitle').textContent = 'แจ้งราคา / ออกบิล';
  $('fromReqNote').textContent = `จากคำขอ ${r.requestNo}: ${r.summary}${r.details.options?.length ? ` (${r.details.options.join(', ')})` : ''}`;
  $('fromReqNote').hidden = false;
  $('cName').value = r.customer.name; $('cPhone').value = r.customer.phone; $('cLine').value = r.customer.lineId;
  $('title').value = r.summary.slice(0, 300);
  const row = $('items').querySelector('.item');
  const sizeText = r.details.width && r.details.height ? ` ${r.details.width}×${r.details.height} ${r.details.unit === 'm' ? 'ม.' : 'ซม.'}` : '';
  row.querySelector('.i-desc').value = `${r.categoryName}${sizeText}${r.details.options?.length ? ' ' + r.details.options.join(' ') : ''}`.slice(0, 300);
  row.querySelector('.i-qty').value = String(r.details.qty || 1);
  row.querySelector('.i-price').focus();
  $('createSubmit').textContent = 'ออกบิลและรับลิงก์ชำระเงิน';
  recalc();
}

/* ---------------- start ---------------- */
addEventListener('resize', () => { if (isDesktop()) { $('side').classList.remove('detail-open'); $('reqSide').classList.remove('detail-open'); document.body.style.overflow = ''; } });
api('/api/admin/session').then(showApp).catch(e => { if (!onAuthError(e)) { showLogin(); show($('loginError'), e.message); } });

/* ---------------- gallery (product examples) ---------------- */
let galleryCats = null, gSending = false;
async function loadGallery() {
  try {
    if (!galleryCats) {
      galleryCats = (await api('/api/catalog')).catalog;
      $('gCat').replaceChildren(...galleryCats.map(c => el('option', { value: c.id, text: c.name })));
    }
    const { items } = await api('/api/gallery');
    const name = id => galleryCats.find(c => c.id === id)?.name || id;
    $('gList').replaceChildren(...items.map(i => el('div', { class: 'ag-item' },
      el('img', { src: i.imageUrl, alt: i.title, loading: 'lazy' }),
      el('div', {}, el('b', { text: i.title }), el('span', { class: 'muted', text: name(i.category) }),
        el('button', { class: 'btn danger small-btn', type: 'button', text: 'ลบ', onclick: async e => {
          if (!confirm(`ลบรูป "${i.title}" ออกจากตัวอย่างงาน?`)) return;
          e.currentTarget.disabled = true;
          try { await api(`/api/admin/gallery/${i.id}`, { method: 'DELETE' }); toast('ลบแล้ว'); loadGallery(); }
          catch (err) { toast(err.message); e.currentTarget.disabled = false; }
        } })))));
    if (!items.length) $('gList').replaceChildren(el('p', { class: 'muted', text: 'ยังไม่มีรูปตัวอย่าง เพิ่มรูปแรกได้จากฟอร์มด้านบน' }));
  } catch (err) { toast(err.message); }
}

// Phone photos are big: shrink to 1600 px JPEG in the browser so uploads are quick and the page stays light.
async function shrinkImage(file) {
  try {
    const bmp = await createImageBitmap(file);
    const scale = Math.min(1, 1600 / Math.max(bmp.width, bmp.height));
    if (scale === 1 && file.size < 1.5 * 1024 * 1024) return file;
    const c = document.createElement('canvas');
    c.width = Math.round(bmp.width * scale); c.height = Math.round(bmp.height * scale);
    c.getContext('2d').drawImage(bmp, 0, 0, c.width, c.height);
    const blob = await new Promise(r => c.toBlob(r, 'image/jpeg', 0.85));
    return blob ? new File([blob], 'photo.jpg', { type: 'image/jpeg' }) : file;
  } catch { return file; }
}
$('gFile').addEventListener('change', () => {
  const f = $('gFile').files[0];
  $('gFileLabel').textContent = f ? `เลือกแล้ว: ${f.name}` : 'แตะเพื่อเลือกรูป';
  if (f && !$('gTitle').value) $('gTitle').focus();
});
$('galleryForm').addEventListener('submit', async e => {
  e.preventDefault(); if (gSending) return;
  const f = $('gFile').files[0];
  if (!$('gTitle').value.trim()) return show($('gError'), 'กรุณาใส่ชื่อผลงาน');
  if (!f) return show($('gError'), 'กรุณาเลือกรูป');
  gSending = true; $('gSubmit').disabled = true; $('gSubmit').textContent = 'กำลังอัปโหลด...'; show($('gError'), '');
  try {
    const form = new FormData();
    form.set('category', $('gCat').value); form.set('title', $('gTitle').value); form.set('caption', $('gCaption').value);
    form.set('image', await shrinkImage(f));
    const res = await fetch('/api/admin/gallery', { method: 'POST', body: form, credentials: 'same-origin' });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || 'อัปโหลดไม่สำเร็จ');
    toast('เพิ่มรูปตัวอย่างแล้ว');
    $('gTitle').value = ''; $('gCaption').value = ''; $('gFile').value = ''; $('gFileLabel').textContent = 'แตะเพื่อเลือกรูป';
    loadGallery();
  } catch (err) { show($('gError'), err.message); }
  finally { gSending = false; $('gSubmit').disabled = false; $('gSubmit').textContent = 'เพิ่มรูปตัวอย่าง'; }
});
