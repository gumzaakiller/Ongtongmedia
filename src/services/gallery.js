// Product examples (public gallery). Images live in R2 under gallery/, served by id with long caching.
import { AppError, json } from '../lib/http.js';
import { imageType, extensionFor, MAX_SLIP_BYTES } from '../lib/image.js';
import { randomHex, sha256Hex } from '../lib/crypto.js';
import { text } from '../lib/validate.js';
import { nowIso } from '../lib/time.js';
import { CATALOG } from '../catalog.js';

const CATEGORY_IDS = new Set(CATALOG.map(c => c.id));
const item = r => ({ id: r.id, category: r.category, title: r.title, caption: r.caption, imageUrl: `/api/gallery/${r.id}/image`, createdAt: r.created_at });

export async function listGallery(env) {
  const { results } = await env.DB.prepare('SELECT id,category,title,caption,created_at FROM gallery_items ORDER BY id DESC LIMIT 500').all();
  const counts = {};
  for (const r of results) counts[r.category] = (counts[r.category] || 0) + 1;
  return {
    categories: CATALOG.filter(c => counts[c.id]).map(c => ({ id: c.id, name: c.name, count: counts[c.id] })),
    items: results.map(item)
  };
}

export async function galleryImage(env, id) {
  const row = await env.DB.prepare('SELECT r2_key,mime FROM gallery_items WHERE id=?').bind(id).first();
  if (!row) throw new AppError('ไม่พบรูป', 404);
  const obj = await env.SLIPS.get(row.r2_key);
  if (!obj) throw new AppError('ไม่พบรูป', 404);
  // id → key never changes (a replaced photo gets a new id), so browsers can keep it.
  return new Response(obj.body, { headers: { 'Content-Type': row.mime, 'Cache-Control': 'public, max-age=604800, immutable' } });
}

export async function addGalleryItem(env, form) {
  const category = String(form.get('category') ?? '');
  if (!CATEGORY_IDS.has(category)) throw new AppError('กรุณาเลือกหมวดสินค้า');
  const title = text(form.get('title') ?? '', 'ชื่อผลงาน', 200, { required: true });
  const caption = text(form.get('caption') ?? '', 'รายละเอียด', 500);
  const file = form.get('image');
  if (!file || typeof file === 'string' || !file.size) throw new AppError('กรุณาเลือกรูป');
  if (file.size > MAX_SLIP_BYTES) throw new AppError('รูปต้องมีขนาดไม่เกิน 8 MB', 413);
  const bytes = new Uint8Array(await file.arrayBuffer());
  const mime = imageType(bytes);
  const sha = await sha256Hex(bytes);
  if (await env.DB.prepare('SELECT 1 FROM gallery_items WHERE sha256=?').bind(sha).first()) throw new AppError('รูปนี้อยู่ในตัวอย่างงานแล้ว', 409);
  const key = `gallery/${category}/${randomHex(12)}.${extensionFor(mime)}`;
  await env.SLIPS.put(key, bytes, { httpMetadata: { contentType: mime } });
  try {
    const row = await env.DB.prepare('INSERT INTO gallery_items(category,title,caption,r2_key,sha256,mime,size,created_at) VALUES(?,?,?,?,?,?,?,?) RETURNING id,category,title,caption,created_at')
      .bind(category, title, caption, key, sha, mime, bytes.length, nowIso()).first();
    return item(row);
  } catch (e) {
    await env.SLIPS.delete(key).catch(() => {});
    if (String(e?.message).includes('UNIQUE')) throw new AppError('รูปนี้อยู่ในตัวอย่างงานแล้ว', 409);
    throw e;
  }
}

export async function deleteGalleryItem(env, id) {
  const row = await env.DB.prepare('DELETE FROM gallery_items WHERE id=? RETURNING r2_key').bind(id).first();
  if (!row) throw new AppError('ไม่พบรูป', 404);
  await env.SLIPS.delete(row.r2_key).catch(() => {});
  return { ok: true };
}

export const handleGalleryList = async env => json(await listGallery(env));
