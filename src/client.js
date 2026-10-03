import QRCode from 'qrcode';
import { MAX_SLIP, STATUSES, validateOrder, promptPayPayload } from './shared.js';

const $ = id => document.getElementById(id);
const fmt = satang => '฿' + (satang / 100).toLocaleString('th-TH', {minimumFractionDigits:2,maximumFractionDigits:2});
let cfg = null, itemSeq = 0, busy = false, completed = false, pending = null, nextCursor = null, loadingOrders = false;
async function api(path, options = {}) {
  let response;
  try { response = await fetch(path, { credentials: 'same-origin', ...options }); }
  catch { throw new Error('เชื่อมต่อไม่ได้ กรุณาลองใหม่ ข้อมูลคำสั่งซื้อเดิมจะไม่ถูกบันทึกซ้ำ'); }
  const data = await response.json().catch(() => ({error:'ระบบตอบกลับไม่ถูกต้อง'}));
  if (!response.ok) { const error = new Error(data.error || 'ระบบขัดข้อง'); error.status = response.status; throw error; }
  return data;
}
function message(id, text) { $(id).textContent = text; $(id).hidden = !text; }
function payload() {
  return { customer: $('customer').value, phone: $('phone').value, contact: $('contact').value, note: $('note').value, shipping: $('shipping').value,
    items: [...document.querySelectorAll('.item')].map(row => ({ name: row.querySelector('.iname').value, price: row.querySelector('.iprice').value, qty: Number(row.querySelector('.iqty').value) })) };
}
function addItem() {
  if (document.querySelectorAll('.item').length >= 50) return message('orderError','เพิ่มสินค้าได้ไม่เกิน 50 รายการ');
  const id = ++itemSeq; const row = document.createElement('div'); row.className = 'item';
  row.innerHTML = `<div class="item-name"><label for="name${id}">ชื่อสินค้า / บริการ</label><input id="name${id}" class="iname" maxlength="200" placeholder="ชื่อสินค้า/บริการ" required></div><div><label for="price${id}">ราคา (บาท)</label><input id="price${id}" class="iprice" type="number" min="0.01" max="1000000" step="0.01" placeholder="ราคา" required></div><div><label for="qty${id}">จำนวน</label><input id="qty${id}" class="iqty" type="number" min="1" max="10000" step="1" value="1" required></div><button type="button" class="btn danger" aria-label="ลบรายการสินค้า ${id}">×</button>`;
  row.querySelector('button').addEventListener('click', () => { row.remove(); calc(); });
  $('items').append(row); calc();
}
function calc() {
  const data = payload(); let order;
  // Customer fields are not required until submitting; prices and quantities are always checked.
  try { order = validateOrder({...data,customer:'preview',phone:'0800000000'}); } catch { order = null; }
  $('subtotalText').textContent = order ? fmt(order.subtotal) : '—';
  $('shippingText').textContent = order ? fmt(order.shipping) : '—';
  $('totalText').textContent = $('qrAmount').textContent = order ? fmt(order.total) : '—';
  $('qr').hidden = true;
  $('qrMessage').textContent = !cfg?.ready ? 'ร้านยังไม่พร้อมรับชำระเงิน' : !order ? 'กรอกรายการ ราคา และจำนวนให้ครบเพื่อสร้าง QR' : 'สแกน QR พร้อมเพย์ตามยอดด้านล่าง';
  if (order && cfg?.ready) {
    try {
      QRCode.toCanvas($('qr'), promptPayPayload(cfg.promptPayId,order.total), {width:240,margin:4}, error => {
        if (error) { $('qr').hidden = true; $('qrMessage').textContent = 'สร้าง QR ไม่สำเร็จ กรุณาลองใหม่'; }
      });
      $('qr').hidden = false;
    } catch { $('qrMessage').textContent = 'สร้าง QR ไม่สำเร็จ กรุณาติดต่อร้าน'; }
  }
}
async function submitOrder(event) {
  event.preventDefault(); if (busy || completed) return;
  busy = true; $('submitOrder').disabled = true; message('orderError','');
  try {
    if (!cfg?.ready) throw new Error('ร้านยังไม่ได้ตั้งค่าข้อมูลรับชำระเงิน');
    if (!pending) {
      const data = payload(); validateOrder(data);
      const file = $('slip').files[0];
      if (file && (file.size > MAX_SLIP || !['image/png','image/jpeg','image/webp'].includes(file.type))) throw new Error('กรุณาใช้รูป PNG, JPG หรือ WEBP ขนาดไม่เกิน 8 MB');
      const form = new FormData(); form.set('order',JSON.stringify(data)); if(file) form.set('slip',file);
      pending = { key:crypto.randomUUID(), form };
    }
    $('orderFields').disabled = true; $('submitOrder').textContent = 'กำลังบันทึก...';
    const result = await api('/api/orders',{method:'POST',headers:{'Idempotency-Key':pending.key},body:pending.form});
    completed = true; pending = null;
    message('successBox',`บันทึกสำเร็จ\nเลขที่คำสั่งซื้อ: ${result.orderId}\nยอด: ${fmt(result.totalSatang)}\nสถานะ: ${result.status}`);
    $('newOrder').hidden = false; $('submitOrder').textContent = 'บันทึกสำเร็จแล้ว';
  } catch(error) {
    // Keep the exact request and key after ambiguous/network failures.
    if (error.status && error.status < 500 && error.status !== 429) pending = null;
    message('orderError',error.message + (pending ? '\nกดส่งอีกครั้งเพื่อส่งข้อมูลเดิมอย่างปลอดภัย' : ''));
    $('orderFields').disabled = false;
    $('orderForm').querySelectorAll('input,button').forEach(el => { el.disabled = false; });
    if (pending) {
      // Freeze editable fields while permitting retry of the same payload.
      $('orderForm').querySelectorAll('input,button').forEach(el => { el.disabled = el.id !== 'submitOrder'; });
    }
    $('submitOrder').textContent = pending ? 'ลองส่งคำสั่งซื้อเดิมอีกครั้ง' : 'ยืนยันคำสั่งซื้อ / แจ้งชำระเงิน';
  } finally { busy = false; $('submitOrder').disabled = completed || !cfg?.ready; }
}
function adminState(loggedIn) {
  $('loginForm').hidden = loggedIn; $('adminControls').hidden = !loggedIn;
  $('accountingPanel').hidden = !loggedIn;
  if (!loggedIn) { ++accountingEpoch; $('dashboard').replaceChildren(); for(const [listId] of Object.values(ledgerIds))$(listId).replaceChildren(); $('orders').replaceChildren(); $('moreOrders').hidden = true; nextCursor = null; }
}
function node(tag, text, className) { const el = document.createElement(tag); el.textContent = text; if(className) el.className = className; return el; }
function renderOrder(order) {
  const card = node('article','','order'); const top = node('div','','orderTop'); const badge = node('span',order.status,'badge');
  top.append(node('b',order.id),badge); card.append(top,node('p',new Date(order.created_at).toLocaleString('th-TH'),'small'));
  card.append(node('p',`${order.customer} · ${order.phone}\n${order.contact}`));
  card.append(node('p',order.items.map(i=>`${i.name} × ${i.qty} @ ${fmt(i.priceSatang)}`).join('\n')));
  card.append(node('p',`สินค้า ${fmt(order.subtotal_satang)} + ค่าจัดส่ง ${fmt(order.shipping_satang)}`),node('b',`รวม ${fmt(order.total_satang)}`));
  if(order.note) card.append(node('p',`หมายเหตุ: ${order.note}`));
  if(order.hasSlip) { const link = node('a','ดูสลิป'); link.href = `/api/admin/orders/${encodeURIComponent(order.id)}/slip`; link.target = '_blank'; link.rel = 'noopener'; card.append(node('p',''),link); }
  const select = document.createElement('select'); select.setAttribute('aria-label',`สถานะ ${order.id}`);
  for(const status of STATUSES) { const option = node('option',status); option.value=status; option.selected=status===order.status; select.append(option); }
  select.addEventListener('change',async()=>{
    select.disabled=true;
    try {
      const result=await api(`/api/admin/orders/${order.id}/status`,{method:'PATCH',headers:{'Content-Type':'application/json'},body:JSON.stringify({status:select.value,version:order.version})});
      order.status=result.status;order.version=result.version;badge.textContent=result.status;message('adminMessage','บันทึกสถานะแล้ว');await loadAccounting();
    } catch(e) { select.value=order.status;message('adminMessage',e.message);if(e.status===401)adminState(false); }
    finally{select.disabled=false;}
  });
  card.append(select);
  if (['รอชำระเงิน','รอตรวจสอบการชำระเงิน'].includes(order.status)) {
    const prepare=node('button','สร้าง/ดูรายการชำระ','btn soft spaced');prepare.type='button';
    prepare.addEventListener('click',async()=>{
      prepare.disabled=true;
      try{await api('/api/admin/payments',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({orderId:order.id})});await loadAccounting();}
      catch(e){message('adminMessage',e.message);if(e.status===401)adminState(false);}finally{prepare.disabled=false;}
    });card.append(prepare);
  }
  $('orders').append(card);
}
async function loadOrders(more=false) {
  if(loadingOrders)return; loadingOrders=true; $('reloadOrders').disabled=true;$('moreOrders').disabled=true;
  message('adminMessage','กำลังโหลด...');
  try {
    const result=await api('/api/admin/orders'+(more&&nextCursor?'?cursor='+encodeURIComponent(nextCursor):''));
    if(!more)$('orders').replaceChildren();
    result.orders.forEach(renderOrder);nextCursor=result.nextCursor;$('moreOrders').hidden=!nextCursor;
    message('adminMessage',$('orders').children.length?'':'ยังไม่มีคำสั่งซื้อ');
    if(!more) await loadAccounting();
  } catch(e){message('adminMessage',e.message);if(e.status===401)adminState(false);}
  finally{loadingOrders=false;$('reloadOrders').disabled=false;$('moreOrders').disabled=false;}
}
const ledgerPages={pending:null,income:null,expenses:null};
let accountingEpoch=0;
function renderLedger(type,item) {
  const card=node('article','','order');
  if(type==='pending') {
    card.append(node('b',`${item.customer} · ${fmt(item.amount_satang)}`),node('p',item.order_id,'small'));
    const actions=node('div','','payment-actions');
    if(item.hasSlip){const link=node('a','ดูสลิป');link.href=`/api/admin/payments/${encodeURIComponent(item.id)}/slip`;link.target='_blank';link.rel='noopener';actions.append(link);}
    else card.append(node('p','ยังไม่มีสลิป กรุณาตรวจยอดเงินจริงกับร้าน','muted'));
    const button=node('button','ยืนยันชำระ','btn primary');button.type='button';
    button.addEventListener('click',async()=>{
      if(!window.confirm(`ยืนยันว่าได้รับเงินจริง ${fmt(item.amount_satang)} สำหรับ ${item.order_id} แล้ว?`))return;
      button.disabled=true;
      try{await api(`/api/admin/payments/${encodeURIComponent(item.id)}/confirm`,{method:'POST'});await loadOrders();message('adminMessage','ยืนยันชำระและบันทึกรายรับแล้ว');}
      catch(e){message('accountingMessage',e.message);if(e.status===401)adminState(false);}finally{button.disabled=false;}
    });actions.append(button);card.append(actions);
  }else{
    card.append(node('b',`${fmt(item.amount_satang)} · ${item.category}`));
    card.append(node('p',type==='income'?`${item.order_id}\n${new Date(item.received_at).toLocaleString('th-TH',{timeZone:'Asia/Bangkok'})}`:`${item.expense_date}\n${item.description}`));
  }
  return card;
}
const ledgerIds={pending:['pendingPayments','morePayments'],income:['incomeList','moreIncome'],expenses:['expenseList','moreExpenses']};
async function loadLedger(type,more=false,epoch=accountingEpoch) {
  const [listId,buttonId]=ledgerIds[type],button=$(buttonId);button.disabled=true;
  try{
    const path=type==='pending'?'payments/pending':type;
    const result=await api(`/api/admin/${path}?offset=${more?ledgerPages[type]||0:0}`);
    if(epoch!==accountingEpoch || $('accountingPanel').hidden)return;
    if(!more)$(listId).replaceChildren();
    result.items.forEach(item=>$(listId).append(renderLedger(type,item)));
    if(!$(listId).children.length)$(listId).append(node('p','ยังไม่มีรายการ','muted'));
    ledgerPages[type]=result.nextOffset;button.hidden=result.nextOffset===null;
  }finally{button.disabled=false;}
}
async function loadAccounting() {
  const epoch=++accountingEpoch;message('accountingMessage','กำลังโหลดบัญชี...');$('dashboard').replaceChildren();
  for(const [listId,buttonId] of Object.values(ledgerIds)){$(listId).replaceChildren();$(buttonId).hidden=true;}
  try{
    const d=await api('/api/admin/dashboard');
    if(epoch!==accountingEpoch || $('accountingPanel').hidden)return;
    const metrics=[['ยอดขายวันนี้',fmt(d.salesTodaySatang)],['รับเงินแล้ว (สะสม)',fmt(d.paidSatang)],['รอตรวจสอบ',`${d.pendingCount} รายการ · ${fmt(d.pendingSatang)}`],['รายรับเดือนนี้',fmt(d.incomeMonthSatang)],['รายจ่ายเดือนนี้',fmt(d.expensesMonthSatang)],['กำไรสุทธิเดือนนี้',fmt(d.netProfitSatang)]];
    for(const [label,value] of metrics){const card=node('div','','metric');card.append(node('span',label),node('strong',value));$('dashboard').append(card);}
    await Promise.all(Object.keys(ledgerIds).map(type=>loadLedger(type,false,epoch)));
    if(epoch===accountingEpoch)message('accountingMessage','');
  }catch(e){if(epoch===accountingEpoch){message('accountingMessage',e.message);if(e.status===401)adminState(false);}}
}
for(const [type,[,buttonId]] of Object.entries(ledgerIds))$(buttonId).addEventListener('click',()=>loadLedger(type,true).catch(e=>{message('accountingMessage',e.message);if(e.status===401)adminState(false);}));
let expensePending=null;
$('expenseForm').addEventListener('submit',async event=>{
  event.preventDefault();const button=event.submitter;button.disabled=true;
  const fields=[...$('expenseForm').querySelectorAll('input')];
  try{
    if(!expensePending)expensePending={requestId:crypto.randomUUID(),amount:$('expenseAmount').value,category:$('expenseCategory').value,description:$('expenseDescription').value,expenseDate:$('expenseDate').value};
    fields.forEach(el=>el.disabled=true);
    await api('/api/admin/expenses',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(expensePending)});
    expensePending=null;$('expenseForm').reset();await loadAccounting();message('accountingMessage','บันทึกรายจ่ายแล้ว');
  }catch(e){if(e.status && e.status<500)expensePending=null;message('accountingMessage',e.message+(expensePending?' กดบันทึกอีกครั้งเพื่อส่งข้อมูลเดิม':''));if(e.status===401)adminState(false);}
  finally{button.disabled=false;fields.forEach(el=>el.disabled=!!expensePending);}
});
async function showTab(admin) {
  $('payTab').hidden=admin;$('adminTab').hidden=!admin;
  for(const [id,active] of [['payNav',!admin],['adminNav',admin]]){$(id).classList.toggle('active',active);$(id).setAttribute('aria-pressed',String(active));}
  if(admin){
    try{await api('/api/admin/session');adminState(true);await loadOrders();}
    catch(e){adminState(false);message('adminMessage',e.status===401?'':e.message);}
  }
}
$('payNav').addEventListener('click',()=>showTab(false));$('adminNav').addEventListener('click',()=>showTab(true));
$('addItem').addEventListener('click',addItem);$('orderForm').addEventListener('input',calc);$('orderForm').addEventListener('submit',submitOrder);
$('newOrder').addEventListener('click',()=>{
  completed=false;pending=null;$('orderForm').reset();$('orderFields').disabled=false;
  $('orderForm').querySelectorAll('input,button').forEach(el=>el.disabled=false);
  $('items').replaceChildren();addItem();message('successBox','');message('orderError','');$('newOrder').hidden=true;
  $('submitOrder').textContent='ยืนยันคำสั่งซื้อ / แจ้งชำระเงิน';$('submitOrder').disabled=!cfg?.ready;
});
$('loginForm').addEventListener('submit',async event=>{
  event.preventDefault();const button=event.submitter;button.disabled=true;
  try{await api('/api/admin/login',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({password:$('adminPassword').value})});$('adminPassword').value='';adminState(true);await loadOrders();}
  catch(e){message('adminMessage',e.message);}finally{button.disabled=false;}
});
$('logout').addEventListener('click',async()=>{try{await api('/api/admin/logout',{method:'POST'});adminState(false);message('adminMessage','ออกจากระบบแล้ว');}catch(e){message('adminMessage',e.message);if(e.status===401)adminState(false);}});
$('reloadOrders').addEventListener('click',()=>loadOrders());$('moreOrders').addEventListener('click',()=>loadOrders(true));
addItem();
api('/api/config').then(config=>{
  cfg=config;$('shopName').textContent=cfg.shopName;
  $('bankInfo').textContent=cfg.ready?`${cfg.bankName}\nชื่อบัญชี: ${cfg.accountName}\nเลขบัญชี: ${cfg.accountNo || '—'}\nพร้อมเพย์: ${cfg.promptPayId}`:'กรุณาติดต่อร้านเพื่อยืนยันข้อมูลรับชำระเงิน';
  message('configMessage',cfg.ready?'':'ร้านยังไม่ได้ตั้งค่าข้อมูลรับชำระเงิน จึงยังไม่เปิดรับคำสั่งซื้อ');$('submitOrder').disabled=!cfg.ready;calc();
}).catch(e=>{message('configMessage',e.message);$('bankInfo').textContent='โหลดข้อมูลร้านไม่สำเร็จ กรุณารีเฟรชหน้า';});
