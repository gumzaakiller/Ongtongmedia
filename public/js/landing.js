import { $, api, el } from './util.js';
import { recentItems } from './recent.js';

api('/api/config').then(c => {
  if (c.messengerUrl) { $('messengerBtn').href = c.messengerUrl; $('messengerBtn').hidden = false; }
  if (c.facebookUrl) { $('facebookBtn').href = c.facebookUrl; $('facebookBtn').hidden = false; }
}).catch(() => {});

const items = recentItems();
if (items.length) {
  $('recentList').replaceChildren(...items.map(i => el('li', {}, el('a', { href: i.url },
    el('b', { text: i.no }), el('span', { text: i.label })))));
  $('recentWrap').hidden = false;
}
