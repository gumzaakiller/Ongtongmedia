import { AppError, json, readBody } from '../lib/http.js';
import { TOKEN_RE } from '../lib/crypto.js';
import { rateLimit } from '../lib/ratelimit.js';
import { text } from '../lib/validate.js';
import { createRequest, fileType, getPublicRequest, MAX_FILE_BYTES, MAX_FILES, publicCatalog, validateRequest } from '../services/requests.js';

// Worker memory is limited, so the whole upload (all files) is capped well below the platform limit.
export const MAX_REQUEST_BYTES = 25 * 1024 * 1024;
const NOT_FOUND = 'ไม่พบคำขอนี้ กรุณาตรวจสอบลิงก์ หรือติดต่อร้าน';

export const handleCatalog = () => json({ catalog: publicCatalog(), maxFiles: MAX_FILES, maxFileBytes: MAX_FILE_BYTES, maxTotalBytes: MAX_REQUEST_BYTES });

export async function handleCreateRequest(request, env) {
  await rateLimit(request, env, 'job-request', 5, 600);
  const key = request.headers.get('Idempotency-Key');
  if (!/^[A-Za-z0-9-]{16,64}$/.test(key || '')) throw new AppError('รหัสคำขอไม่ถูกต้อง');
  const type = request.headers.get('content-type') || '';
  if (!type.startsWith('multipart/form-data')) throw new AppError('รูปแบบข้อมูลไม่ถูกต้อง', 415);
  let form;
  try { form = await new Response(await readBody(request, MAX_REQUEST_BYTES + 64 * 1024), { headers: { 'Content-Type': type } }).formData(); }
  catch (e) {
    if (e instanceof AppError) throw e.status === 413 ? new AppError('ไฟล์รวมกันใหญ่เกิน 25 MB กรุณาส่งไฟล์ใหญ่ทาง LINE แทน', 413) : e;
    throw new AppError('ข้อมูลที่ส่งมาไม่ถูกต้อง');
  }
  const field = name => { const v = form.get(name); return typeof v === 'string' ? v : ''; };
  const input = validateRequest({
    category: field('category'), qty: field('qty'), width: field('width'), height: field('height'), unit: field('unit'),
    options: form.getAll('options').filter(v => typeof v === 'string'), artwork: field('artwork'), deadline: field('deadline'),
    details: field('details'), name: field('name'), phone: field('phone'), lineId: field('lineId')
  });
  const uploads = form.getAll('files').filter(f => typeof f !== 'string' && f.size);
  if (uploads.length > MAX_FILES) throw new AppError(`แนบไฟล์ได้ไม่เกิน ${MAX_FILES} ไฟล์`);
  const files = [];
  for (const f of uploads) {
    if (f.size > MAX_FILE_BYTES) throw new AppError(`ไฟล์ ${f.name} ใหญ่เกิน 20 MB กรุณาส่งทาง LINE แทน`, 413);
    const bytes = new Uint8Array(await f.arrayBuffer());
    let mime;
    try { mime = fileType(bytes); } catch { throw new AppError(`ไฟล์ ${f.name} ไม่รองรับ แนบได้เฉพาะ JPG, PNG, WEBP หรือ PDF`); }
    files.push({ bytes, mime, name: text((f.name || 'file').slice(0, 150), 'ชื่อไฟล์', 150) || 'file' });
  }
  const origin = new URL(request.url).origin;
  const r = await createRequest(env, input, files, key, origin);
  return json({ requestNo: r.requestNo, trackUrl: r.trackUrl }, r.created ? 201 : 200);
}

export async function handleGetRequest(request, env, token) {
  await rateLimit(request, env, 'pay-view', 120, 600);
  if (!TOKEN_RE.test(token)) throw new AppError(NOT_FOUND, 404);
  const r = await getPublicRequest(env, token, new URL(request.url).origin);
  if (!r) throw new AppError(NOT_FOUND, 404);
  return json({ request: r });
}
