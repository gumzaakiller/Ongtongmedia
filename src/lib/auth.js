import { AppError, json, readJson } from './http.js';
import { passwordMatches, randomHex, sha256Hex } from './crypto.js';
import { rateLimit } from './ratelimit.js';

const SESSION_SECONDS = 8 * 60 * 60;

function cookie(request, token, age = SESSION_SECONDS) {
  return `otm_session=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${age}${new URL(request.url).protocol === 'https:' ? '; Secure' : ''}`;
}
function sessionToken(request) { return request.headers.get('Cookie')?.match(/(?:^|;\s*)otm_session=([a-f0-9]{64})(?:;|$)/)?.[1]; }
export function passwordReady(env) { return typeof env.ADMIN_PASSWORD === 'string' && env.ADMIN_PASSWORD.length >= 16 && env.ADMIN_PASSWORD.length <= 256; }

export async function requireAdmin(request, env) {
  if (!passwordReady(env)) throw new AppError('ยังไม่ได้ตั้งค่าบัญชีผู้ดูแล', 503);
  const token = sessionToken(request);
  if (!token) throw new AppError('กรุณาเข้าสู่ระบบผู้ดูแล', 401);
  // Sessions are bound to the current password: changing ADMIN_PASSWORD logs everyone out.
  const session = await env.DB.prepare('SELECT token_hash FROM sessions WHERE token_hash=? AND expires_at>? AND password_version=?')
    .bind(await sha256Hex(token), Math.floor(Date.now() / 1000), await sha256Hex(env.ADMIN_PASSWORD)).first();
  if (!session) throw new AppError('หมดเวลาเข้าสู่ระบบ กรุณาเข้าสู่ระบบอีกครั้ง', 401);
}

export async function login(request, env) {
  if (!passwordReady(env)) throw new AppError('ยังไม่ได้ตั้งค่าบัญชีผู้ดูแล', 503);
  await rateLimit(request, env, 'login', 5, 900);
  const body = await readJson(request);
  if (!await passwordMatches(env.ADMIN_PASSWORD, body?.password)) throw new AppError('รหัสผ่านไม่ถูกต้อง', 401);
  const token = randomHex(32);
  const now = Math.floor(Date.now() / 1000);
  await env.DB.batch([
    env.DB.prepare('DELETE FROM sessions WHERE expires_at<=?').bind(now),
    env.DB.prepare('DELETE FROM rate_limits WHERE expires_at<=?').bind(now),
    env.DB.prepare('INSERT INTO sessions VALUES (?,?,?)').bind(await sha256Hex(token), now + SESSION_SECONDS, await sha256Hex(env.ADMIN_PASSWORD))
  ]);
  return json({ ok: true }, 200, { 'Set-Cookie': cookie(request, token) });
}

export async function logout(request, env) {
  const token = sessionToken(request);
  if (token) await env.DB.prepare('DELETE FROM sessions WHERE token_hash=?').bind(await sha256Hex(token)).run();
  return json({ ok: true }, 200, { 'Set-Cookie': cookie(request, '', 0) });
}
