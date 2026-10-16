// 2026/10/16 16:47:15 by liaoweipeng1
import { build } from 'esbuild';
import { copyFile, mkdir, readFile, cp } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';

const wasm = await readFile('vendor/tree-sitter-systemverilog.wasm');
const hash = createHash('sha256').update(wasm).digest('hex');
if (hash !== '1d7315a7b71772b0c2834e1e9b5444af72807aca3f200159cd5e7ef77acb17d8') {
  throw new Error('Official grammar WASM checksum mismatch');
}
await mkdir('dist/licenses', { recursive: true });
const runtimeManifest = JSON.parse(await readFile('vendor/slang-runtime-manifest.json', 'utf8'));
for (const [file, digest] of Object.entries(runtimeManifest)) {
  const bytes = await readFile(path.join('vendor/slang-runtime', file));
  if (createHash('sha256').update(bytes).digest('hex') !== digest) {
    throw new Error(`Pinned slang runtime checksum mismatch: ${file}`);
  }
}
await cp('vendor/slang-runtime', 'dist/slang-runtime', { recursive: true });
await copyFile('src/slang_bridge.py', 'dist/slang-runtime/slang_bridge.py');
for (const entry of ['extension', 'worker', 'core']) {
  await build({ entryPoints: [`src/${entry}.ts`], outfile: `dist/${entry}.cjs`,
    bundle: true, platform: 'node', format: 'cjs', target: 'node20', external: ['vscode'],
    alias: { 'web-tree-sitter': path.resolve('node_modules/web-tree-sitter/tree-sitter.cjs') },
    sourcemap: false, legalComments: 'inline' });
}
await copyFile('node_modules/web-tree-sitter/tree-sitter.wasm', 'dist/tree-sitter.wasm');
await copyFile('vendor/tree-sitter-systemverilog.wasm', 'dist/tree-sitter-systemverilog.wasm');
for (const pkg of ['web-tree-sitter', 'tree-sitter-systemverilog', 'picomatch']) {
  await copyFile(`node_modules/${pkg}/LICENSE`, `dist/licenses/${pkg}.txt`);
}
console.log('Built extension, parser worker, offline WASM and pinned slang 12.0.');
