import { AppError, applySecurityHeaders, json, sameOrigin } from './lib/http.js';
import { shopConfig } from './config.js';
import { handleAdmin } from './routes/admin.js';
import { handlePayApi, handlePayQr, handlePaySlip } from './routes/pay.js';
import { handleLineWebhook } from './services/line.js';
import { handleCatalog, handleCreateRequest, handleGetRequest } from './routes/requests.js';

async function route(request, env) {
  const url = new URL(request.url);
  const path = url.pathname;
  const method = request.method;
  // LINE calls this server-to-server (no Origin header); it is authenticated by its HMAC signature instead.
  if (path === '/api/line/webhook' && method === 'POST') return handleLineWebhook(request, env);
  if (path.startsWith('/api/') && !['GET', 'HEAD'].includes(method)) sameOrigin(request);

  if (path === '/api/health' && method === 'GET') {
    await env.DB.prepare('SELECT 1 FROM orders LIMIT 1').first();
    const shop = shopConfig(env);
    return json({ ok: true, paymentsConfigured: shop.ready, env: shop.appEnv });
  }
  if (path === '/api/config' && method === 'GET') {
    const { shopName, lineOaId, facebookUrl, messengerUrl, appEnv } = shopConfig(env);
    return json({ shopName, lineOaId, facebookUrl, messengerUrl, env: appEnv });
  }
  const pay = path.match(/^\/api\/pay\/([^/]+)(\/qr\.png|\/slip)?$/);
  if (pay && method === 'GET' && pay[2] !== '/slip') return pay[2] ? handlePayQr(request, env, pay[1]) : handlePayApi(request, env, pay[1]);
  if (pay && method === 'POST' && pay[2] === '/slip') return handlePaySlip(request, env, pay[1]);
  if (path === '/api/catalog' && method === 'GET') return handleCatalog();
  if (path === '/api/requests' && method === 'POST') return handleCreateRequest(request, env);
  const req = path.match(/^\/api\/requests\/([^/]+)$/);
  if (req && method === 'GET') return handleGetRequest(request, env, req[1]);
  if (path.startsWith('/api/admin/')) return handleAdmin(request, env, path);
  if (path.startsWith('/api/')) throw new AppError('ไม่พบ API หรือวิธีเรียกไม่ถูกต้อง', 404);

  if (!['GET', 'HEAD'].includes(method)) throw new AppError('ไม่รองรับคำขอนี้', 405);
  // Customer pay page: one static page (public/pay.html) that reads the token from its own URL. (UI: Phase 5)
  // Fetch "/pay", not "/pay.html": static assets redirect *.html to the extensionless path, which would drop the token.
  if (/^\/pay\/[^/]+$/.test(path)) return env.ASSETS.fetch(new Request(new URL('/pay', url), { method, headers: request.headers }));
  if (/^\/request\/[^/]+$/.test(path)) return env.ASSETS.fetch(new Request(new URL('/request', url), { method, headers: request.headers }));
  return env.ASSETS.fetch(request); // "/admin" → public/admin.html (Phase 4)
}

export default {
  async fetch(request, env) {
    let response;
    try { response = await route(request, env); }
    catch (e) {
      if (!(e instanceof AppError)) console.error('Request failed', e?.name, e?.message);
      response = json({ error: e instanceof AppError ? e.message : 'ระบบขัดข้องชั่วคราว กรุณาลองใหม่อีกครั้ง' }, e instanceof AppError ? e.status : 500);
    }
    return applySecurityHeaders(response, new URL(request.url).pathname);
  }
};
