import { $, api } from './util.js';

api('/api/config').then(c => {
  if (c.messengerUrl) { $('messengerBtn').href = c.messengerUrl; $('messengerBtn').hidden = false; }
  if (c.facebookUrl) { $('facebookBtn').href = c.facebookUrl; $('facebookBtn').hidden = false; }
}).catch(() => {});
