// Shared by the bill page (pay.js) and the walk-in transfer page (transfer.js):
// in-app browser handling, bank app buttons and "save the QR" for Android/iPhone.
import { $, el, toast } from './util.js';
import { BANK_APPS, bankLink, platform, inAppBrowser, externalBrowserUrl } from './banks.js';

export const os = platform();
export const iab = inAppBrowser();

// LINE can reopen the page in the phone's browser by itself; Messenger/Facebook need the customer's help.
export function leaveLineBrowser() {
  if (iab === 'line' && !new URL(location.href).searchParams.has('openExternalBrowser')) {
    location.replace(externalBrowserUrl(location.href, os, iab));
  }
}

// Needs #iabBox, #iabOpen, #iabText on the page.
export function showInAppHelp(scroll = true) {
  const out = externalBrowserUrl(location.href, os, iab);
  $('iabBox').hidden = false;
  $('iabOpen').hidden = !out;
  if (out) $('iabOpen').href = out;
  $('iabText').textContent = out
    ? 'หน้านี้เปิดอยู่ในแอปแชท ซึ่งบันทึกรูป QR และเปิดแอปธนาคารไม่ได้ กดปุ่มด้านล่างเพื่อเปิดใน Chrome'
    : 'หน้านี้เปิดอยู่ในแอปแชท ซึ่งบันทึกรูป QR และเปิดแอปธนาคารไม่ได้ กด ⋯ มุมขวาบน แล้วเลือก "เปิดในเบราว์เซอร์" (Safari)';
  if (scroll) $('iabBox').scrollIntoView({ behavior: 'smooth', block: 'start' });
}

export function renderBankButtons(container, onLeave = () => {}) {
  container.replaceChildren(...BANK_APPS.map(app => el('a', {
    class: 'bank-app', href: bankLink(app, os), rel: 'noopener', 'data-bank': app.id,
    onclick: e => {
      if (iab) { e.preventDefault(); showInAppHelp(); return; }
      onLeave();
    }
  },
    app.icon ? el('img', { class: 'bank-icon', src: app.icon, alt: '', width: 44, height: 44, loading: 'lazy' })
             : el('span', { class: 'bank-icon bank-icon-text', 'aria-hidden': 'true', text: app.short }),
    el('b', { text: app.name }), el('span', { class: 'bank-sub', text: app.bank }))));
}

// The QR is fetched ahead of time: iPhone only opens the share sheet straight from a tap.
export function qrSaver(button, img, onSave = () => {}) {
  let file = null, seq = 0;
  function longPressHint() {
    img.scrollIntoView({ behavior: 'smooth', block: 'center' });
    img.classList.add('pulse'); setTimeout(() => img.classList.remove('pulse'), 2400);
    toast(os === 'ios' ? 'กดค้างที่รูป QR แล้วเลือก "บันทึกลงในรูปภาพ"' : 'กดค้างที่รูป QR แล้วเลือก "ดาวน์โหลดรูปภาพ"');
  }
  button.addEventListener('click', async () => {
    if (iab) { showInAppHelp(); return; }
    onSave();
    if (!file) { longPressHint(); return; }
    if (os === 'ios') {
      // Share sheet → "บันทึกภาพ" puts it in Photos, where the banking apps look for it.
      if (navigator.canShare?.({ files: [file] })) {
        try { await navigator.share({ files: [file] }); toast('ถ้าเลือก "บันทึกภาพ" แล้ว รูป QR จะอยู่ในอัลบั้ม'); }
        catch (e) { if (e.name !== 'AbortError') longPressHint(); }
        return;
      }
      longPressHint(); return;
    }
    const href = URL.createObjectURL(file);
    const a = el('a', { href, download: file.name, hidden: true });
    document.body.append(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(href), 30000);
    toast('บันทึกรูป QR แล้ว ดูได้ในแกลเลอรีหรือโฟลเดอร์ดาวน์โหลด');
  });
  return {
    async load(url, name) {
      const mine = ++seq; file = null;
      img.src = url;
      try {
        const res = await fetch(url, { credentials: 'same-origin' });
        if (!res.ok) return;
        const blob = await res.blob();
        if (mine === seq) file = new File([blob], name, { type: 'image/png' });
      } catch {}
    }
  };
}
