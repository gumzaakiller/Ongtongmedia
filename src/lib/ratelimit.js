import { AppError } from './http.js';
import { sha256Hex } from './crypto.js';

// Fixed-window counter per IP hash, stored in D1 (rate_limits table).
export async function rateLimit(request, env, bucket, max, seconds) {
  const now = Math.floor(Date.now() / 1000);
  const ip = request.headers.get('CF-Connecting-IP') || 'local';
  const key = `${bucket}:${await sha256Hex(ip)}:${Math.floor(now / seconds)}`;
  const row = await env.DB.prepare('INSERT INTO rate_limits (key,count,expires_at) VALUES (?,1,?) ON CONFLICT(key) DO UPDATE SET count=count+1 RETURNING count')
    .bind(key, now + seconds).first();
  if (row.count > max) throw new AppError('ทำรายการบ่อยเกินไป กรุณารอสักครู่แล้วลองใหม่', 429);
}
