// 2026/10/16 16:47:15 by liaoweipeng1
import { build } from 'esbuild';
import { copyFile, mkdir, readFile, writeFile, unlink, realpath, lstat, rm } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { brotliCompressSync, constants } from 'node:zlib';
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
// 仅重建本工程的生成目录，防止增量构建残留旧运行库；不沿目录联接清理。
const runtimeOutput = path.resolve('dist/slang-runtime');
const actualDist = await realpath('dist');
const samePath = (left, right) => process.platform === 'win32' ? left.toLowerCase() === right.toLowerCase() : left === right;
if (!samePath(path.dirname(runtimeOutput), actualDist)) {
  throw new Error('Refusing to clean a redirected dist directory');
}
const previous = await lstat(runtimeOutput).catch(error => {
  if (error.code !== 'ENOENT') { throw error; }
});
if (previous?.isSymbolicLink()) { throw new Error('Refusing to clean a linked runtime directory'); }
await rm(runtimeOutput, { recursive: true, force: true });
for (const file of Object.keys(runtimeManifest)) {
  const target = path.join(runtimeOutput, file);
  await mkdir(path.dirname(target), { recursive: true });
  await copyFile(path.join('vendor/slang-runtime', file), target);
}
await copyFile('src/slang_bridge.py', 'dist/slang-runtime/slang_bridge.py');
for (const entry of ['extension', 'worker', 'core']) {
  await build({ entryPoints: [`src/${entry}.ts`], outfile: `dist/${entry}.cjs`,
    bundle: true, platform: 'node', format: 'cjs', target: 'node20', external: ['vscode'],
    alias: { 'web-tree-sitter': path.resolve('node_modules/web-tree-sitter/tree-sitter.cjs') },
    sourcemap: false, legalComments: 'inline' });
}
await copyFile('node_modules/web-tree-sitter/tree-sitter.wasm', 'dist/tree-sitter.wasm');
await writeFile('dist/tree-sitter-systemverilog.wasm.br', brotliCompressSync(wasm, {
  params: { [constants.BROTLI_PARAM_QUALITY]: 9 },
}));
await unlink('dist/tree-sitter-systemverilog.wasm').catch(error => {
  if (error.code !== 'ENOENT') { throw error; }
});
for (const pkg of ['web-tree-sitter', 'tree-sitter-systemverilog', 'picomatch']) {
  await copyFile(`node_modules/${pkg}/LICENSE`, `dist/licenses/${pkg}.txt`);
}
console.log('Built extension, parser worker, offline WASM and pinned slang 12.0.');
