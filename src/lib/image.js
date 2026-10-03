import { AppError } from './http.js';

export const MAX_SLIP_BYTES = 8 * 1024 * 1024;
const EXT = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp' };

// Decide the image type from the file's own bytes (magic numbers), never from its name or the browser's claim.
export function imageType(bytes) {
  if (bytes.length >= 24 && [137, 80, 78, 71, 13, 10, 26, 10].every((b, i) => bytes[i] === b)) return 'image/png';
  if (bytes.length >= 4 && bytes[0] === 0xFF && bytes[1] === 0xD8 && bytes[2] === 0xFF) return 'image/jpeg';
  if (bytes.length >= 16 && String.fromCharCode(...bytes.slice(0, 4)) === 'RIFF' && String.fromCharCode(...bytes.slice(8, 12)) === 'WEBP') return 'image/webp';
  throw new AppError('รองรับเฉพาะรูปภาพ PNG, JPG หรือ WEBP');
}
export const extensionFor = mime => EXT[mime];
