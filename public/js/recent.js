// Remembers pay / tracking links opened on this device so customers can find them again from the home page.
// Per-device convenience only: failures (private mode, storage blocked) are ignored.
const KEY = 'ongtong.recent.v1';
const SAME_SITE = /^\/(pay|request)\/[A-Za-z0-9_-]{43}$/;

export function recentItems() {
  try {
    const list = JSON.parse(localStorage.getItem(KEY) || '[]');
    return Array.isArray(list) ? list.filter(i => i && SAME_SITE.test(new URL(i.url, location.origin).pathname)).slice(0, 8) : [];
  } catch { return []; }
}

export function rememberRecent(no, label, url = location.pathname) {
  try {
    const list = recentItems().filter(i => i.no !== no);
    list.unshift({ no, label, url });
    localStorage.setItem(KEY, JSON.stringify(list.slice(0, 8)));
  } catch {}
}
