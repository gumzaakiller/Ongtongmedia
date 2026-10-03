import { $, STATUS_LABEL, ApiError, api, baht, copyText, el, show, thaiDateTime, toSatang, toast } from './util.js';

const FILTERS = [['', 'ทั้งหมด'], ['pending', 'รอชำระเงิน'], ['awaiting_verification', 'รอตรวจสลิป'], ['paid', 'ชำระแล้ว'], ['processing', 'กำลังดำเนินการ'], ['completed', 'เสร็จสิ้น'], ['cancelled', 'ยกเลิก']];
// Buttons offered per status (must match MANUAL_TRANSITIONS on the server).
const ACTIONS = {
  pending: [['cancelled', 'ยกเลิกรายการนี้', 'danger', 'ยกเลิกรายการนี้? ลูกค้าจะชำระผ่านลิงก์นี้ไม่ได้อีก']],
  paid: [['processing', 'เริ่มดำเนินการ', 'primary'], ['completed', 'งานเสร็จแล้ว', '']],
  processing: [['completed', 'งานเสร็จแล้ว', 'primary']]
};

const state = { status: '', q: '', cursor: null, current: null, customer: null, createKey: null, busy: false };
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
  await loadOrders();
  if (isDesktop() && !state.current) openCreate();
}

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

/* ---------------- start ---------------- */
addEventListener('resize', () => { if (isDesktop()) { $('side').classList.remove('detail-open'); document.body.style.overflow = ''; } });
api('/api/admin/session').then(showApp).catch(e => { if (!onAuthError(e)) { showLogin(); show($('loginError'), e.message); } });
