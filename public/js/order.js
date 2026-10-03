import { $, api, el, show } from './util.js';
import { rememberRecent } from './recent.js';

let catalog = [], limits = {}, selected = null, files = [], sendKey = null, sending = false, lineOaId = '@653ercqc';
const todayYmd = () => new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Bangkok' });
const mb = n => n < 1024 * 1024 ? Math.max(1, Math.round(n / 1024)) + ' KB' : (n / 1024 / 1024).toFixed(1) + ' MB';
const ACCEPT = ['image/png', 'image/jpeg', 'image/webp', 'application/pdf'];

function pick(cat) {
  selected = cat;
  for (const b of $('catGrid').children) b.setAttribute('aria-checked', String(b.dataset.id === cat.id));
  $('sizeFields').hidden = !cat.size;
  // Standard sizes as a dropdown; "กำหนดขนาดเอง" shows the width/height fields.
  const presets = cat.sizes || [];
  $('presetWrap').hidden = !presets.length;
  $('sizePreset').replaceChildren(...presets.map((p, i) => el('option', { value: String(i), text: p.label })), el('option', { value: 'custom', text: 'กำหนดขนาดเอง' }));
  $('sizePreset').value = presets.length ? '0' : 'custom';
  applyPreset();
  $('optionList').replaceChildren(...cat.options.map((o, i) => el('label', { class: 'check' },
    el('input', { type: 'checkbox', name: 'options', value: o, id: `opt${i}` }), ` ${o}`)));
  $('optionsWrap').hidden = !cat.options.length;
  $('fileNote').textContent = cat.fileNote || ''; $('fileNote').hidden = !cat.fileNote;
  $('details').placeholder = cat.id === 'other' ? 'บอกรายละเอียดงานที่ต้องการ (จำเป็น)' : 'เช่น ข้อความบนป้าย สีที่ต้องการ ใช้ติดที่ไหน';
  const first = $('specCard').hidden;
  $('specCard').hidden = false; $('contactCard').hidden = false;
  if (first) $('specCard').scrollIntoView({ behavior: 'smooth', block: 'start' });
  sendKey = null;
}

function applyPreset() {
  const v = $('sizePreset').value; const p = selected?.sizes?.[Number(v)];
  $('customSize').hidden = !!p; $('sizeHint').hidden = !!p;
  if (p) { $('width').value = p.width; $('height').value = p.height; $('unit').value = 'cm'; }
  else if (selected?.sizes?.length) { $('width').value = ''; $('height').value = ''; }
}
$('sizePreset').addEventListener('change', applyPreset);

function renderFiles() {
  $('fileList').replaceChildren(...files.map((f, i) => el('li', {},
    el('span', { text: `${f.name}  (${mb(f.size)})` }),
    el('button', { type: 'button', class: 'btn ghost small-btn', 'aria-label': `เอาไฟล์ ${f.name} ออก`, text: 'เอาออก', onclick: () => { files.splice(i, 1); sendKey = null; renderFiles(); } }))));
  $('filesLabel').textContent = files.length ? `เลือกแล้ว ${files.length} ไฟล์ (แตะเพื่อเพิ่ม)` : 'แตะเพื่อเลือกไฟล์ (เลือกได้หลายไฟล์)';
}
$('files').addEventListener('change', () => {
  show($('formError'), '');
  for (const f of $('files').files) {
    if (!ACCEPT.includes(f.type)) { show($('formError'), `ไฟล์ ${f.name} ไม่รองรับ แนบได้เฉพาะ JPG, PNG, WEBP หรือ PDF`); continue; }
    if (f.size > limits.maxFileBytes) { show($('formError'), `ไฟล์ ${f.name} ใหญ่เกิน 20 MB กรุณาส่งทาง LINE หลังส่งคำขอ`); continue; }
    if (files.length >= limits.maxFiles) { show($('formError'), `แนบได้ไม่เกิน ${limits.maxFiles} ไฟล์`); break; }
    files.push(f);
  }
  if (files.reduce((n, f) => n + f.size, 0) > limits.maxTotalBytes) show($('formError'), 'ไฟล์รวมกันเกิน 25 MB กรุณาเอาบางไฟล์ออก แล้วส่งทาง LINE แทน');
  $('files').value = ''; sendKey = null; renderFiles();
});

$('orderForm').addEventListener('input', () => { sendKey = null; });
$('orderForm').addEventListener('submit', async e => {
  e.preventDefault(); if (sending) return;
  show($('formError'), '');
  const fail = (msg, focus) => { show($('formError'), msg); if (focus) $(focus).focus(); };
  if (!selected) return fail('กรุณาเลือกงานที่ต้องการ');
  if (!$('name').value.trim()) return fail('กรุณาใส่ชื่อ', 'name');
  if (!$('phone').value.trim() && !$('lineId').value.trim()) return fail('กรุณาใส่เบอร์โทร หรือ LINE ID อย่างน้อยหนึ่งช่อง', 'phone');
  if (selected.id === 'other' && !$('details').value.trim()) return fail('กรุณาบอกรายละเอียดงาน', 'details');
  if (files.reduce((n, f) => n + f.size, 0) > limits.maxTotalBytes) return fail('ไฟล์รวมกันเกิน 25 MB');

  const form = new FormData();
  form.set('category', selected.id);
  for (const id of ['qty', 'details', 'deadline', 'name', 'phone', 'lineId']) form.set(id, $(id).value);
  if (selected.size) for (const id of ['width', 'height', 'unit']) form.set(id, $(id).value);
  form.set('artwork', document.querySelector('input[name=artwork]:checked').value);
  for (const c of document.querySelectorAll('input[name=options]:checked')) form.append('options', c.value);
  for (const f of files) form.append('files', f, f.name);

  sendKey ||= crypto.randomUUID(); // same key on retry → never a duplicate request
  sending = true; $('submitBtn').disabled = true; $('submitBtn').textContent = files.length ? 'กำลังส่งไฟล์...' : 'กำลังส่ง...';
  try {
    const res = await fetch('/api/requests', { method: 'POST', body: form, headers: { 'Idempotency-Key': sendKey } });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) { const err = new Error(data.error || 'ส่งไม่สำเร็จ ลองอีกครั้ง'); err.status = res.status; throw err; }
    done(data);
  } catch (err) {
    if (err.status && err.status < 500 && err.status !== 429) sendKey = null;
    fail(err.status ? err.message : 'เชื่อมต่อไม่ได้ ตรวจสอบอินเทอร์เน็ตแล้วกดส่งอีกครั้ง (ไม่ส่งซ้ำ)');
  } finally { sending = false; $('submitBtn').disabled = false; $('submitBtn').textContent = 'ส่งคำขอให้ร้าน'; }
});

function done({ requestNo, trackUrl }) {
  const path = new URL(trackUrl).pathname;
  rememberRecent(requestNo, `คำขอ ${selected.name}`, path);
  $('orderForm').hidden = true; $('doneCard').hidden = false;
  $('doneNo').textContent = requestNo;
  $('doneTrack').href = path;
  $('doneLine').href = `https://line.me/R/oaMessage/${encodeURIComponent(lineOaId)}/?${encodeURIComponent(`สอบถามคำขอ ${requestNo}\n(ส่งไฟล์งานเพิ่มเติมในแชทนี้ได้)`)}`;
  scrollTo(0, 0);
}

Promise.all([api('/api/catalog'), api('/api/config').catch(() => ({}))]).then(([c, cfg]) => {
  catalog = c.catalog; limits = c;
  if (cfg.lineOaId) lineOaId = cfg.lineOaId;
  $('catGrid').replaceChildren(...catalog.map(cat => el('button', { type: 'button', class: 'cat', role: 'radio', 'aria-checked': 'false', 'data-id': cat.id, onclick: () => pick(cat) },
    el('b', { text: cat.name }), el('span', { text: cat.hint }))));
  $('deadline').min = todayYmd();
  $('orderForm').hidden = false;
}).catch(e => show($('loadError'), e.message));
