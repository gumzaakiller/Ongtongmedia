// Public gallery of the shop's work, grouped by the same categories as the order form.
import { $, api, el, show } from './util.js';

let all = [], current = 'all';

function render() {
  const items = current === 'all' ? all : all.filter(i => i.category === current);
  $('grid').replaceChildren(...items.map(i => el('figure', { class: 'g-card' },
    el('button', { class: 'g-img', type: 'button', 'aria-label': `ดูรูปใหญ่: ${i.title}`, onclick: () => openViewer(i) },
      el('img', { src: i.imageUrl, alt: i.title, loading: 'lazy', width: 400, height: 400 })),
    el('figcaption', {},
      el('b', { text: i.title }),
      i.caption ? el('span', { text: i.caption }) : null,
      el('a', { class: 'btn small-btn', href: `/order?cat=${encodeURIComponent(i.category)}&ref=${encodeURIComponent(i.title)}`, text: 'สั่งงานแบบนี้' })))));
  $('emptyBox').hidden = all.length > 0;
}

function openViewer(i) {
  $('viewerImg').src = i.imageUrl; $('viewerImg').alt = i.title;
  $('viewerCap').textContent = i.caption ? `${i.title} — ${i.caption}` : i.title;
  $('viewer').hidden = false; document.body.style.overflow = 'hidden'; $('viewerClose').focus();
}
function closeViewer() { $('viewer').hidden = true; document.body.style.overflow = ''; }
$('viewerClose').addEventListener('click', closeViewer);
$('viewer').addEventListener('click', e => { if (e.target === $('viewer')) closeViewer(); });
document.addEventListener('keydown', e => { if (e.key === 'Escape' && !$('viewer').hidden) closeViewer(); });

api('/api/gallery').then(({ categories, items }) => {
  all = items;
  const want = new URLSearchParams(location.search).get('cat');
  if (categories.some(c => c.id === want)) current = want;
  const chip = (id, label) => el('button', { class: 'chip', type: 'button', 'aria-pressed': String(id === current), 'data-id': id, text: label, onclick: () => {
    current = id;
    for (const c of $('catChips').children) c.setAttribute('aria-pressed', String(c.dataset.id === id));
    render();
  } });
  $('catChips').replaceChildren(chip('all', `ทั้งหมด (${items.length})`), ...categories.map(c => chip(c.id, `${c.name} (${c.count})`)));
  $('catChips').hidden = !categories.length;
  $('loading').hidden = true;
  render();
}).catch(e => { $('loading').hidden = true; show($('errorBox'), e.message); });
