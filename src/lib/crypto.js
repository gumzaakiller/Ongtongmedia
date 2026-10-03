const encoder = new TextEncoder();

export async function sha256Hex(value) {
  const bytes = typeof value === 'string' ? encoder.encode(value) : value;
  return [...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))].map(b => b.toString(16).padStart(2, '0')).join('');
}

export function randomHex(byteLength = 32) {
  return [...crypto.getRandomValues(new Uint8Array(byteLength))].map(b => b.toString(16).padStart(2, '0')).join('');
}

// 32 random bytes → 43-char base64url: the unguessable part of a customer's pay link.
export function randomToken() {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  let binary = '';
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
export const TOKEN_RE = /^[A-Za-z0-9_-]{43}$/;

// Constant-time password check via HMAC verify (no data-dependent string comparison).
export async function passwordMatches(expected, supplied) {
  const key = await crypto.subtle.importKey('raw', encoder.encode(expected), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign', 'verify']);
  const signature = await crypto.subtle.sign('HMAC', key, encoder.encode(expected));
  return crypto.subtle.verify('HMAC', key, signature, encoder.encode(typeof supplied === 'string' ? supplied : ''));
}
