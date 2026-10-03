// HTTP helpers shared by every route.
export class AppError extends Error {
  constructor(message, status = 400, code = undefined) { super(message); this.status = status; this.code = code; }
}

export const json = (data, status = 200, headers = {}) => Response.json(data, { status, headers });

// Writes must come from this site (blocks cross-site form posts / CSRF).
export function sameOrigin(request) {
  if (request.headers.get('Origin') !== new URL(request.url).origin) throw new AppError('คำขอไม่ได้มาจากเว็บไซต์นี้', 403);
}

// Reads a body while enforcing a hard size limit, even when Content-Length is missing or false.
export async function readBody(request, max) {
  if (Number(request.headers.get('content-length')) > max) throw new AppError('ข้อมูลมีขนาดใหญ่เกินกำหนด', 413);
  const reader = request.body?.getReader();
  if (!reader) throw new AppError('ไม่มีข้อมูล');
  const chunks = []; let length = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    length += value.length;
    if (length > max) { await reader.cancel(); throw new AppError('ข้อมูลมีขนาดใหญ่เกินกำหนด', 413); }
    chunks.push(value);
  }
  const bytes = new Uint8Array(length); let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
  return bytes;
}

export async function readJson(request, max = 32 * 1024) {
  if (!request.headers.get('content-type')?.startsWith('application/json')) throw new AppError('รูปแบบข้อมูลไม่ถูกต้อง', 415);
  try { return JSON.parse(new TextDecoder().decode(await readBody(request, max))); }
  catch (e) { if (e instanceof AppError) throw e; throw new AppError('ข้อมูล JSON ไม่ถูกต้อง'); }
}

export function applySecurityHeaders(response, path) {
  const result = new Response(response.body, response);
  const h = result.headers;
  h.set('X-Content-Type-Options', 'nosniff');
  h.set('Referrer-Policy', 'same-origin');   // pay-link tokens never leave this site in a Referer
  h.set('X-Frame-Options', 'DENY');
  h.set('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data: blob:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'");
  // Gallery photos never change for a given id, so they may be cached; every other API answer may not.
  if (path.startsWith('/api/') && !/^\/api\/gallery\/\d+\/image$/.test(path)) h.set('Cache-Control', 'no-store');
  if (path.startsWith('/pay/') || path.startsWith('/api/pay/') || path.startsWith('/request/') || path.startsWith('/api/requests/')) { h.set('X-Robots-Tag', 'noindex, nofollow'); h.set('Cache-Control', 'no-store'); }
  return result;
}
