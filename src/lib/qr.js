import qrcodegen from '../vendor/qrcodegen.js';

// QR code → PNG bytes, generated in the Worker so customers can save the image and open it from a banking app.
const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; }
  return t;
})();
function crc32(bytes) { let c = 0xFFFFFFFF; for (const b of bytes) c = CRC_TABLE[(c ^ b) & 0xFF] ^ (c >>> 8); return (c ^ 0xFFFFFFFF) >>> 0; }

function chunk(type, data) {
  const out = new Uint8Array(12 + data.length); const view = new DataView(out.buffer);
  view.setUint32(0, data.length);
  for (let i = 0; i < 4; i++) out[4 + i] = type.charCodeAt(i);
  out.set(data, 8);
  view.setUint32(8 + data.length, crc32(out.subarray(4, 8 + data.length)));
  return out;
}

async function zlib(bytes) {
  const stream = new Blob([bytes]).stream().pipeThrough(new CompressionStream('deflate'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

export function qrMatrix(text) {
  const qr = qrcodegen.QrCode.encodeText(text, qrcodegen.QrCode.Ecc.MEDIUM);
  return { size: qr.size, dark: (x, y) => qr.getModule(x, y) };
}

export async function qrPng(text, { scale = 8, border = 4 } = {}) {
  const { size, dark } = qrMatrix(text);
  const px = (size + border * 2) * scale;
  // 8-bit grayscale; each row starts with filter byte 0.
  const raw = new Uint8Array(px * (px + 1));
  for (let y = 0; y < px; y++) {
    const row = y * (px + 1); raw[row] = 0;
    const my = Math.floor(y / scale) - border;
    for (let x = 0; x < px; x++) {
      const mx = Math.floor(x / scale) - border;
      const isDark = mx >= 0 && my >= 0 && mx < size && my < size && dark(mx, my);
      raw[row + 1 + x] = isDark ? 0 : 255;
    }
  }
  const ihdr = new Uint8Array(13); const v = new DataView(ihdr.buffer);
  v.setUint32(0, px); v.setUint32(4, px); ihdr[8] = 8; ihdr[9] = 0; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  const parts = [new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', await zlib(raw)), chunk('IEND', new Uint8Array())];
  const png = new Uint8Array(parts.reduce((n, p) => n + p.length, 0)); let o = 0;
  for (const p of parts) { png.set(p, o); o += p.length; }
  return png;
}
