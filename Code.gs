const CONFIG = {
  SHOP_NAME: 'อองตองมีเดีย',
  PROMPTPAY_ID: '0812345678', // แก้เป็นเบอร์โทร/เลขบัตรประชาชนที่ผูกพร้อมเพย์
  BANK_NAME: 'ธนาคารของคุณ',
  ACCOUNT_NAME: 'ชื่อบัญชีร้าน',
  ACCOUNT_NO: '000-0-00000-0',
  ADMIN_PIN: '1234', // ควรเปลี่ยนทันที
};

function setupSystem() {
  const props = PropertiesService.getScriptProperties();
  let ssId = props.getProperty('ORDER_SHEET_ID');
  let folderId = props.getProperty('SLIP_FOLDER_ID');

  if (!ssId) {
    const ss = SpreadsheetApp.create(`${CONFIG.SHOP_NAME} - Orders`);
    const sh = ss.getSheets()[0];
    sh.setName('Orders');
    sh.getRange(1,1,1,13).setValues([[
      'Order ID','Created At','Customer','Phone','Line/Facebook','Items','Subtotal','Shipping','Total','Payment Method','Slip URL','Status','Note'
    ]]);
    sh.setFrozenRows(1);
    ssId = ss.getId();
    props.setProperty('ORDER_SHEET_ID', ssId);
  }

  if (!folderId) {
    const folder = DriveApp.createFolder(`${CONFIG.SHOP_NAME} - Payment Slips`);
    folderId = folder.getId();
    props.setProperty('SLIP_FOLDER_ID', folderId);
  }

  return {
    spreadsheetUrl: `https://docs.google.com/spreadsheets/d/${ssId}`,
    slipFolderUrl: `https://drive.google.com/drive/folders/${folderId}`
  };
}

function doGet() {
  return HtmlService.createTemplateFromFile('index')
    .evaluate()
    .setTitle(`${CONFIG.SHOP_NAME} | ชำระเงิน`)
    .setXFrameOptionsMode(HtmlService.XFrameOptionsMode.ALLOWALL);
}

function getShopConfig() {
  return {
    shopName: CONFIG.SHOP_NAME,
    promptPayId: CONFIG.PROMPTPAY_ID,
    bankName: CONFIG.BANK_NAME,
    accountName: CONFIG.ACCOUNT_NAME,
    accountNo: CONFIG.ACCOUNT_NO,
  };
}

function createOrder(payload) {
  validateOrder_(payload);
  const props = PropertiesService.getScriptProperties();
  const ssId = props.getProperty('ORDER_SHEET_ID');
  if (!ssId) throw new Error('ยังไม่ได้ตั้งค่าระบบ กรุณารัน setupSystem() ก่อน');

  const lock = LockService.getScriptLock();
  lock.waitLock(10000);
  try {
    const orderId = makeOrderId_();
    const ss = SpreadsheetApp.openById(ssId);
    const sh = ss.getSheetByName('Orders');
    let slipUrl = '';

    if (payload.slip && payload.slip.dataUrl) {
      slipUrl = saveSlip_(orderId, payload.slip);
    }

    const itemsText = (payload.items || []).map(i => `${i.name} x${i.qty} @${Number(i.price).toFixed(2)}`).join(' | ');
    sh.appendRow([
      orderId,
      new Date(),
      payload.customer || '',
      payload.phone || '',
      payload.contact || '',
      itemsText,
      Number(payload.subtotal || 0),
      Number(payload.shipping || 0),
      Number(payload.total || 0),
      payload.paymentMethod || 'PromptPay/โอนเงิน',
      slipUrl,
      slipUrl ? 'รอตรวจสอบการชำระเงิน' : 'รอชำระเงิน',
      payload.note || ''
    ]);

    return { ok: true, orderId, status: slipUrl ? 'รอตรวจสอบการชำระเงิน' : 'รอชำระเงิน' };
  } finally {
    lock.releaseLock();
  }
}

function adminListOrders(pin) {
  checkAdmin_(pin);
  const ssId = PropertiesService.getScriptProperties().getProperty('ORDER_SHEET_ID');
  if (!ssId) throw new Error('ยังไม่ได้ตั้งค่าระบบ');
  const sh = SpreadsheetApp.openById(ssId).getSheetByName('Orders');
  const values = sh.getDataRange().getValues();
  if (values.length <= 1) return [];
  const headers = values.shift();
  return values.reverse().map(row => {
    const obj = {};
    headers.forEach((h, i) => obj[h] = row[i] instanceof Date ? row[i].toISOString() : row[i]);
    return obj;
  });
}

function adminUpdateStatus(pin, orderId, status) {
  checkAdmin_(pin);
  const allowed = ['รอชำระเงิน','รอตรวจสอบการชำระเงิน','ชำระแล้ว','กำลังดำเนินการ','เสร็จสิ้น','ยกเลิก'];
  if (!allowed.includes(status)) throw new Error('สถานะไม่ถูกต้อง');

  const ssId = PropertiesService.getScriptProperties().getProperty('ORDER_SHEET_ID');
  const sh = SpreadsheetApp.openById(ssId).getSheetByName('Orders');
  const data = sh.getDataRange().getValues();
  for (let r = 1; r < data.length; r++) {
    if (String(data[r][0]) === String(orderId)) {
      sh.getRange(r + 1, 12).setValue(status);
      return { ok: true };
    }
  }
  throw new Error('ไม่พบคำสั่งซื้อ');
}

function include(filename) {
  return HtmlService.createHtmlOutputFromFile(filename).getContent();
}

function checkAdmin_(pin) {
  if (String(pin) !== String(CONFIG.ADMIN_PIN)) throw new Error('PIN ไม่ถูกต้อง');
}

function validateOrder_(p) {
  if (!p) throw new Error('ข้อมูลไม่ครบ');
  if (!String(p.customer || '').trim()) throw new Error('กรุณากรอกชื่อลูกค้า');
  if (!String(p.phone || '').trim()) throw new Error('กรุณากรอกเบอร์โทร');
  if (!Array.isArray(p.items) || p.items.length === 0) throw new Error('กรุณาเพิ่มสินค้า/บริการ');
  if (Number(p.total || 0) <= 0) throw new Error('ยอดชำระไม่ถูกต้อง');
}

function saveSlip_(orderId, slip) {
  const folderId = PropertiesService.getScriptProperties().getProperty('SLIP_FOLDER_ID');
  if (!folderId) throw new Error('ยังไม่มีโฟลเดอร์เก็บสลิป');
  const m = String(slip.dataUrl).match(/^data:(image\/(?:png|jpeg|jpg|webp));base64,(.+)$/i);
  if (!m) throw new Error('รองรับสลิปเฉพาะไฟล์ภาพ PNG/JPG/WEBP');
  const bytes = Utilities.base64Decode(m[2]);
  if (bytes.length > 8 * 1024 * 1024) throw new Error('ไฟล์สลิปต้องไม่เกิน 8 MB');
  const ext = m[1].includes('png') ? 'png' : m[1].includes('webp') ? 'webp' : 'jpg';
  const blob = Utilities.newBlob(bytes, m[1], `${orderId}.${ext}`);
  const file = DriveApp.getFolderById(folderId).createFile(blob);
  return file.getUrl();
}

function makeOrderId_() {
  const tz = Session.getScriptTimeZone() || 'Asia/Bangkok';
  const ts = Utilities.formatDate(new Date(), tz, 'yyyyMMdd-HHmmss');
  const rnd = Math.floor(100 + Math.random() * 900);
  return `OTM-${ts}-${rnd}`;
}
