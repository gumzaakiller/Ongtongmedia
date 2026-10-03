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
const VIEWS = { dash: 'dashView', orders: 'ordersView', income: 'incomeView' };
async function setView(name) {
  state.view = name;
  for (const [v, id] of Object.entries(VIEWS)) $(id).hidden = v !== name;
  for (const b of document.querySelectorAll('.tab-btn')) b.setAttribute('aria-pressed', String(b.dataset.view === name));
  if (name !== 'orders') { $('side').classList.remove('detail-open'); document.body.style.overflow = ''; }
  scrollTo(0, 0);
  if (name === 'dash') return loadDashboard();
  if (name === 'income') return loadIncome();
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
  state.createKey = null;
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
    const { order } = await api('/api/admin/orders', { method: 'POST', body, headers: { 'Idempotency-Key': state.createKey } });
    state.createKey = null;
    await loadOrders();
    renderTicket(order); openSide('ticket');
    toast('สร้างรายการแล้ว');
  } catch (err) {
    if (!onAuthError(err)) show($('createError'), err.message);
    if (err.status && err.status < 500 && err.status !== 429) state.createKey = null; // input problem: next try is a new request
  } finally { state.busy = false; $('createSubmit').disabled = false; $('createSubmit').textContent = 'สร้างรายการและรับลิงก์'; }
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
    el('div', { class: 'small muted', text: `${p.hasSlip ? 'ลูกค้าส่งสลิป' : 'บันทึกโดยร้าน'} ${thaiDateTime(p.submittedAt)}` }),
    p.customerNote ? el('div', { class: 'small', text: `ข้อความ: ${p.customerNote}` }) : null,
    p.rejectReason ? el('div', { class: 'small', text: `เหตุผลที่ไม่ผ่าน: ${p.rejectReason}` }) : null,
    p.hasSlip ? el('a', { class: 'slip', href: `/api/admin/payments/${p.id}/slip`, target: '_blank', rel: 'noopener', title: 'เปิดสลิปขนาดเต็ม' },
      el('img', { src: `/api/admin/payments/${p.id}/slip`, alt: `สลิปการชำระของ ${o.orderNo}`, loading: 'lazy' })) : null,
    p.status === 'submitted' ? el('div', { class: 'acts' },
      el('button', { class: 'btn primary', type: 'button', text: 'ยืนยันการชำระเงิน', onclick: e => reviewPayment(o, p, 'verify', e.currentTarget) }),
      el('button', { class: 'btn danger', type: 'button', text: 'สลิปไม่ผ่าน', onclick: e => reviewPayment(o, p, 'reject', e.currentTarget) })) : null
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
    const reason = prompt('เหตุผลที่สลิปไม่ผ่าน (ลูกค้าจะเห็นข้อความนี้)', 'ยอดในสลิปไม่ตรงกับยอดที่ต้องชำระ');
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

/* ---------------- start ---------------- */
addEventListener('resize', () => { if (isDesktop()) { $('side').classList.remove('detail-open'); document.body.style.overflow = ''; } });
api('/api/admin/session').then(showApp).catch(e => { if (!onAuthError(e)) { showLogin(); show($('loginError'), e.message); } });
