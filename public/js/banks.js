// Thai banking apps the customer can open after saving the QR.
// Android package names and iOS App Store ids were checked against the stores (Oct 2026).
// Opening a banking app with the amount filled in is not possible from a web page, so these
// buttons only open the app (or its store page, which shows "Open" when it is installed).
export const BANK_APPS = [
  { id: 'kplus',    name: 'K PLUS',          bank: 'กสิกรไทย',   android: 'com.kasikorn.retail.mbanking.wap', ios: '361170631' },
  { id: 'scb',      name: 'SCB EASY',        bank: 'ไทยพาณิชย์', android: 'com.scb.phone',                    ios: '568388474' },
  { id: 'ktb',      name: 'Krungthai NEXT',  bank: 'กรุงไทย',    android: 'ktbcs.netbank',                    ios: '436753378' },
  { id: 'paotang',  name: 'เป๋าตัง',          bank: 'กรุงไทย',    android: 'com.ktb.customer.qr',              ios: '1324902182' },
  { id: 'bbl',      name: 'Bangkok Bank',    bank: 'กรุงเทพ',    android: 'com.bbl.mobilebanking',            ios: '660238716' },
  { id: 'krungsri', name: 'krungsri',        bank: 'กรุงศรี',     android: 'com.krungsri.kma',                 ios: '571873195' },
  { id: 'ttb',      name: 'ttb touch',       bank: 'ทีทีบี',      android: 'com.TMBTOUCH.PRODUCTION',          ios: '884079963' },
  { id: 'mymo',     name: 'MyMo',            bank: 'ออมสิน',     androidSearch: 'MyMo GSB',                   ios: '987047466' },
  { id: 'baac',     name: 'BAAC Mobile',     bank: 'ธ.ก.ส.',     androidSearch: 'BAAC Mobile',                ios: '1591473167' }
];

export function platform(ua = navigator.userAgent) {
  if (/android/i.test(ua)) return 'android';
  if (/iphone|ipad|ipod/i.test(ua) || (/macintosh/i.test(ua) && navigator.maxTouchPoints > 1)) return 'ios';
  return 'other';
}

export function bankLink(app, os) {
  if (os === 'android') {
    if (!app.android) return `https://play.google.com/store/search?q=${encodeURIComponent(app.androidSearch)}&c=apps`;
    const store = `https://play.google.com/store/apps/details?id=${app.android}`;
    // Chrome opens the app when allowed; otherwise it follows the fallback to the Play Store page ("Open" button).
    return `intent://#Intent;action=android.intent.action.MAIN;category=android.intent.category.LAUNCHER;package=${app.android};S.browser_fallback_url=${encodeURIComponent(store)};end`;
  }
  return `https://apps.apple.com/th/app/id${app.ios}`;
}
