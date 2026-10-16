// 2026/10/16 17:13:42 by liaoweipeng1
const fs = require('node:fs/promises');
const path = require('node:path');
const assert = require('node:assert/strict');
const { RtlParser, ProjectIndexer, defaultConfig } = require('../dist/core.cjs');

async function main() {
  const project = path.resolve(__dirname, '..');
  await fs.mkdir(path.join(project, '.tmp'), { recursive: true });
  const root = await fs.mkdtemp(path.join(project, '.tmp/stress-'));
  const count = 5000;
  const files = Array.from({ length: count }, (_, i) => path.join(root, `m${i}.v`));
  for (let offset = 0; offset < count; offset += 100) {
    await Promise.all(files.slice(offset, offset + 100).map((file, i) =>
      fs.writeFile(file, `// 2026/10/16 17:13:42 by liaoweipeng1\nmodule m${offset + i}; endmodule\n`)));
  }
  const parser = await RtlParser.create(path.join(project, 'dist'));
  try {
    const config = { ...defaultConfig, root };
    const indexer = new ProjectIndexer(parser);
    const first = await indexer.update(config);
    assert.equal(first.modules.length, count);
    const dirty = files[1234];
    await fs.writeFile(dirty, 'module m1234; m42 changed(); endmodule');
    const next = await indexer.update(config, {}, false, { changedFiles: [dirty], rediscover: false });
    assert.equal(next.modules.find(mod => mod.name === 'm1234').instances[0].name, 'changed');
    assert.equal(next.readCount, 1);
    assert.equal(next.statCount, 1);
    assert.equal(next.parsedCount, 1);
    assert.equal(next.cachedCount, count - 1);
    assert.equal(next.discoveryCount, 0);
    const idle = await indexer.update(config, {}, false, { changedFiles: [], rediscover: false });
    assert.equal(idle.readCount + idle.statCount + idle.parsedCount + idle.discoveryCount, 0);
    const stats = snapshot => ({ elapsedMs: snapshot.elapsedMs, parsedCount: snapshot.parsedCount,
      readCount: snapshot.readCount, statCount: snapshot.statCount, discoveryCount: snapshot.discoveryCount,
      bytesRead: snapshot.bytesRead, cachedCount: snapshot.cachedCount });
    const report = { result: 'PASS', checkedAt: new Date().toISOString(), files: count, fixture: root,
      cold: stats(first), oneFileEdit: stats(next), idle: stats(idle),
      scope: '本地磁盘5000个小型语法样例，验证事件增量I/O和结果；不等同于5000个复杂实际模块或网络盘性能。' };
    await fs.mkdir(path.join(project, 'verification'), { recursive: true });
    await fs.writeFile(path.join(project, 'verification/stress-report.json'), JSON.stringify(report, null, 2));
    console.log(JSON.stringify(report, null, 2));
  } finally { parser.dispose(); }
}

main().catch(error => { console.error(error); process.exitCode = 1; });
