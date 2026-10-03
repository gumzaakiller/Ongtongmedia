import { build } from 'esbuild';
await build({ entryPoints: ['src/client.js'], bundle: true, outfile: 'public/app.js', minify: true, target: ['es2022'], legalComments: 'eof' });
