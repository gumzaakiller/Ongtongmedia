// Bundles browser code that needs npm packages. Admin/landing JS are plain ES modules in public/js (no build needed).
import { existsSync } from 'node:fs';
import { build } from 'esbuild';

const entries = [
  { in: 'src/client/pay.js', out: 'public/js/pay.bundle.js' } // customer pay page + QR library (Phase 5)
].filter(e => existsSync(e.in));

for (const e of entries) {
  await build({ entryPoints: [e.in], bundle: true, outfile: e.out, format: 'esm', minify: true, target: ['es2020'], legalComments: 'eof' });
  console.log('built', e.out);
}
if (!entries.length) console.log('nothing to bundle');
