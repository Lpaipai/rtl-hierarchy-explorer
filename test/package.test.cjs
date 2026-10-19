// 2026/10/19 10:09:00 by liaoweipeng1
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { brotliDecompressSync } = require('node:zlib');
const manifest = require('../vendor/slang-runtime-manifest.json');
const root = path.resolve(__dirname, '..');
const digest = bytes => createHash('sha256').update(bytes).digest('hex');

async function files(directory, prefix = '') {
  const result = [];
  for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
    const name = prefix + entry.name;
    if (entry.isDirectory()) {
      result.push(...await files(path.join(directory, entry.name), name + '/'));
    } else {
      result.push(name);
    }
  }
  return result.sort();
}

test('packaged grammar restores the complete pinned grammar without a raw disk copy', async () => {
  const original = await fs.readFile(path.join(root, 'vendor/tree-sitter-systemverilog.wasm'));
  const compressed = await fs.readFile(path.join(root, 'dist/tree-sitter-systemverilog.wasm.br'));
  assert.deepEqual(brotliDecompressSync(compressed), original);
  await assert.rejects(fs.access(path.join(root, 'dist/tree-sitter-systemverilog.wasm')), { code: 'ENOENT' });
});

test('runtime package has only pinned files, bridge and required full-library resources', async () => {
  const runtime = path.join(root, 'dist/slang-runtime');
  assert.deepEqual(await files(runtime), [...Object.keys(manifest), 'slang_bridge.py'].sort());
  for (const [file, hash] of Object.entries(manifest)) {
    assert.equal(digest(await fs.readFile(path.join(runtime, file))), hash, file);
  }
  for (const file of ['python313.zip', 'LICENSE.txt', 'nanobind-LICENSE.txt', 'pyslang-12.0.0.dist-info/licenses/LICENSE']) {
    assert.deepEqual(await fs.readFile(path.join(runtime, file)), await fs.readFile(path.join(root, 'vendor/slang-runtime', file)));
  }
  assert.deepEqual(await fs.readFile(path.join(runtime, 'slang_bridge.py')), await fs.readFile(path.join(root, 'src/slang_bridge.py')));
});
