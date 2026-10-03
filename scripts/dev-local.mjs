// Local preview without wrangler: runs the Worker on Node with the test D1 stand-in and serves public/.
// Usage: node scripts/dev-local.mjs [port]   (admin password: local-test-password-only-1234)
import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';
import worker from '../src/index.js';
import { makeEnv } from '../test/helpers/fake-d1.js';

const root = new URL('../public/', import.meta.url).pathname;
const types = { '.html': 'text/html; charset=utf-8', '.css': 'text/css', '.js': 'text/javascript', '.png': 'image/png', '.svg': 'image/svg+xml', '.webp': 'image/webp', '.jpg': 'image/jpeg' };

// Mimics Workers static assets with default html_handling: "/admin" → admin.html, "/" → index.html.
async function assetFetch(request) {
  let path = decodeURIComponent(new URL(request.url).pathname);
  if (path.endsWith('/')) path += 'index.html';
  const candidates = extname(path) ? [path] : [path + '.html', path + '/index.html'];
  for (const p of candidates) {
    const file = normalize(join(root, p));
    if (!file.startsWith(root)) break;
    try { return new Response(await readFile(file), { headers: { 'Content-Type': types[extname(file)] || 'application/octet-stream' } }); } catch {}
  }
  return new Response('Not found', { status: 404 });
}

// Shop details (name, PromptPay, bank) come from wrangler.jsonc so previews match the real page.
const { vars } = JSON.parse(await readFile(new URL('../wrangler.jsonc', import.meta.url), 'utf8'));
const env = makeEnv({ ...vars, ...(process.env.FB_ID ? { FACEBOOK_PAGE_ID: process.env.FB_ID } : {}), ASSETS: { fetch: assetFetch }, APP_ENV: 'staging' });
const port = Number(process.argv[2] || 8787);
http.createServer(async (req, res) => {
  const chunks = []; for await (const c of req) chunks.push(c);
  const body = chunks.length ? Buffer.concat(chunks) : undefined;
  const request = new Request(`http://localhost:${port}${req.url}`, { method: req.method, headers: req.headers, body: ['GET', 'HEAD'].includes(req.method) ? undefined : body });
  const response = await worker.fetch(request, env);
  res.writeHead(response.status, Object.fromEntries(response.headers));
  res.end(Buffer.from(await response.arrayBuffer()));
}).listen(port, () => console.log(`http://localhost:${port}`));
