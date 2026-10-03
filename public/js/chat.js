// Floating "แชทกับร้าน" button on customer pages: LINE, Messenger (when configured) and phone.
import { api, el } from './util.js';

const FALLBACK = { lineOaId: '@653ercqc', messengerUrl: '', phone: '0804938357' };

function build(cfg) {
  const links = [
    el('a', { class: 'chat-opt line', href: `https://line.me/R/ti/p/${encodeURIComponent(cfg.lineOaId || FALLBACK.lineOaId)}`, rel: 'noopener' }, el('b', { text: 'LINE' }), el('span', { text: cfg.lineOaId || FALLBACK.lineOaId })),
    cfg.messengerUrl ? el('a', { class: 'chat-opt', href: cfg.messengerUrl, rel: 'noopener' }, el('b', { text: 'Messenger' }), el('span', { text: 'แชทผ่าน Facebook' })) : null,
    el('a', { class: 'chat-opt', href: `tel:${FALLBACK.phone}` }, el('b', { text: 'โทร' }), el('span', { text: '080-493-8357' }))
  ].filter(Boolean);
  const menu = el('div', { class: 'chat-menu', id: 'chatMenu', role: 'menu', hidden: true }, el('p', { class: 'chat-head', text: 'คุยกับร้านอองตองมีเดีย' }), ...links);
  const btn = el('button', { class: 'chat-fab', type: 'button', 'aria-expanded': 'false', 'aria-controls': 'chatMenu', text: 'แชทกับร้าน' });
  const toggle = open => { menu.hidden = !open; btn.setAttribute('aria-expanded', String(open)); btn.textContent = open ? 'ปิด' : 'แชทกับร้าน'; };
  btn.addEventListener('click', () => toggle(menu.hidden));
  document.addEventListener('keydown', e => { if (e.key === 'Escape') toggle(false); });
  document.addEventListener('click', e => { if (!menu.hidden && !e.target.closest('.chat-menu, .chat-fab')) toggle(false); });
  document.body.append(menu, btn);
}

api('/api/config').then(build).catch(() => build(FALLBACK));
