// 2026/10/16 16:47:15 by liaoweipeng1
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { RtlParser, Hierarchy, ProjectIndexer, ParserWorker, discover, defaultConfig, tokenizeFileList } = require('../dist/core.cjs');
let parser;
let root;
before(async () => {
  parser = await RtlParser.create(path.resolve(__dirname, '../dist'));
  await fs.mkdir(path.resolve(__dirname, '../.tmp'), { recursive: true });
  root = await fs.mkdtemp(path.resolve(__dirname, '../.tmp/core-'));
});
after(() => parser?.dispose());

test('extracts parameterized, positional and comma-separated instances without confusing functions', () => {
  const result = parser.parse('top.sv', `module leaf #(parameter W = 8) (); endmodule
module top;
  function automatic integer f(input integer x); f = x + 1; endfunction
  leaf #(.W(f(2))) u_a(), u_b();
  leaf #(4) u_c();
  leaf u_d();
endmodule`);
  assert.equal(result.issues.length, 0);
  const top = result.modules.find(m => m.name === 'top');
  assert.deepEqual(top.instances.map(i => i.name), ['u_a', 'u_b', 'u_c', 'u_d']);
  assert.equal(top.instances[0].parameters, '#(.W(f(2)))');
  assert.equal(top.instances[0].location.line, 3);
});

test('ignores comments and strings, preserves UTF-16 source positions and escaped names', () => {
  const source = 'module top; /* 中文😀 */ leaf \\u.special ();\n' +
    'initial $display("ghost fake();"); // other fake2();\nendmodule';
  const result = parser.parse('unicode.sv', source);
  assert.equal(result.issues.length, 0);
  const instances = result.modules[0].instances;
  assert.equal(instances.length, 1);
  assert.equal(instances[0].name, '\\u.special');
  assert.equal(instances[0].location.column, source.indexOf('\\u.special'));
  const withBom = parser.parse('bom.sv', '\uFEFFmodule top; leaf u(); endmodule');
  assert.equal(withBom.modules[0].location.column, 7);
  assert.equal(withBom.modules[0].instances[0].location.column, 17);
});

test('marks generate conditions, loops and instance arrays without inventing active hardware', () => {
  const result = parser.parse('generate.sv', `module top;
for(genvar i=0;i<4;i++) begin : lanes leaf u_lane(); end
if(1) begin : yes leaf u_yes(); end else begin : no leaf u_no(); end
leaf u_array[3:0]();
endmodule`);
  const instances = result.modules[0].instances;
  assert.equal(instances.length, 4);
  assert.deepEqual(instances[0].scopes, ['lanes']);
  assert.ok(instances[0].notes.includes('generate 循环未展开'));
  assert.ok(instances[1].notes.includes('generate 条件未求值'));
  assert.ok(instances[3].notes.includes('实例数组未展开'));
});

test('reports preprocessor ambiguity and retains both conditional branches', () => {
  const result = parser.parse('macro.sv', '`ifdef A\nmodule top; leaf a(); endmodule\n`else\nmodule top; leaf b(); endmodule\n`endif');
  assert.equal(result.modules.length, 2);
  assert.ok(result.issues.some(i => i.message.includes('未运行预处理器')));
  assert.ok(result.modules.every(m => m.notes.includes('预处理未求值')));
  const include = parser.parse('inc.sv', 'module top;\n`include "children.vh"\n`MAKE_CHILD\nendmodule');
  assert.ok(include.issues.some(i => i.message.includes('未运行预处理器')));
});

test('indexes interfaces and gives syntax recovery an explicit warning', () => {
  const result = parser.parse('bus.sv', 'interface bus; endinterface module top; bus u_bus(); endmodule');
  assert.deepEqual(result.modules.map(m => m.name), ['bus', 'top']);
  assert.equal(result.modules[1].instances[0].type, 'bus');
  assert.ok(parser.parse('broken.v', 'module broken; leaf #( u(); endmodule').issues.length > 0);
});

test('top inference, duplicate candidates, missing IP and recursion terminate honestly', () => {
  const modules = parser.parse('hierarchy.v', `module leaf; endmodule
module leaf; endmodule
module top; leaf dup(); missing external_ip(); recursive r(); endmodule
module recursive; recursive again(); endmodule`).modules;
  const hierarchy = new Hierarchy(modules);
  assert.deepEqual(hierarchy.roots().map(n => n.label), ['top']);
  const nodes = hierarchy.children(hierarchy.roots()[0]);
  assert.equal(nodes[0].module, undefined);
  assert.equal(hierarchy.children(nodes[0]).length, 2);
  assert.ok(nodes[1].notes.some(n => n.includes('未找到定义')));
  const recursive = hierarchy.children(nodes[2])[0];
  assert.equal(recursive.terminal, true);
  assert.equal(hierarchy.children(recursive).length, 0);
});

test('disconnected cycles remain discoverable alongside normal roots', () => {
  const modules = parser.parse('cycles.v', 'module top; endmodule module a; b u(); endmodule module b; a u(); endmodule').modules;
  assert.deepEqual(new Hierarchy(modules).roots().map(n => n.label), ['top', 'a']);
});

test('stable hierarchy IDs survive inserted source lines', () => {
  const source = 'module top; leaf child(); endmodule module leaf; endmodule';
  const first = new Hierarchy(parser.parse('stable.v', source).modules);
  const second = new Hierarchy(parser.parse('stable.v', '\n\n' + source).modules);
  assert.equal(first.children(first.roots()[0])[0].id, second.children(second.roots()[0])[0].id);
});

test('file-list tokenizer preserves quoted spaces, Windows separators and comments', () => {
  assert.deepEqual(tokenizeFileList('"rtl/my file.sv" D:\\RTL\\top.v // comment\n/* skip */ -f nested.f\n+incdir+"a b"'),
    ['rtl/my file.sv', 'D:\\RTL\\top.v', '-f', 'nested.f', '+incdir+a b']);
  assert.throws(() => tokenizeFileList('"bad'));
});

test('nested file lists exclude history, warn on missing lists, cycles and unsupported options', async () => {
  const dir = path.join(root, 'lists');
  await fs.mkdir(path.join(dir, 'sub'), { recursive: true });
  await fs.writeFile(path.join(dir, 'top.v'), 'module top; endmodule');
  await fs.writeFile(path.join(dir, 'history.v'), 'module top; endmodule');
  await fs.writeFile(path.join(dir, 'main.f'), '-f sub/nested.f\n+define+X\n-y lib\nhistory.v\n-f missing.f');
  await fs.writeFile(path.join(dir, 'sub/nested.f'), '../top.v\n-f ../main.f');
  const result = await discover({ ...defaultConfig, root: dir, fileLists: ['main.f'], exclude: ['history.v'] });
  assert.deepEqual(result.files, [path.join(dir, 'top.v')]);
  assert.ok(result.issues.some(i => i.message.includes('循环引用')));
  assert.ok(result.issues.some(i => i.message.includes('missing.f')));
  assert.ok(result.issues.some(i => i.message.includes('不支持选项 -y')));
});

test('incremental indexing handles one-file edits, duplicate definitions, overlays and deletion', async () => {
  const dir = path.join(root, 'incremental');
  await fs.mkdir(dir);
  const top = path.join(dir, 'top.v');
  const leaf = path.join(dir, 'leaf.v');
  await fs.writeFile(top, 'module top; leaf a(); endmodule');
  await fs.writeFile(leaf, 'module leaf; endmodule');
  const config = { ...defaultConfig, root: dir };
  const index = new ProjectIndexer(parser);
  assert.equal((await index.update(config)).parsedCount, 2);
  assert.equal((await index.update(config)).parsedCount, 0);
  const updated = await index.update(config, { [top]: 'module top; leaf b(); endmodule' });
  assert.equal(updated.parsedCount, 1);
  assert.equal(updated.cachedCount, 1);
  assert.equal(updated.modules.find(m => m.name === 'top').instances[0].name, 'b');
  const editorPath = process.platform === 'win32' ? top.toLowerCase() : top;
  const caseChanged = await index.update(config, { [editorPath]: 'module top; leaf editor(); endmodule' });
  assert.equal(caseChanged.modules.find(m => m.name === 'top').instances[0].name, 'editor');
  await fs.writeFile(path.join(dir, 'duplicate.v'), 'module leaf; endmodule');
  assert.ok((await index.update(config)).issues.some(i => i.message.includes('有 2 个定义')));
  await fs.unlink(leaf);
  await fs.unlink(path.join(dir, 'duplicate.v'));
  assert.equal((await index.update(config)).modules.length, 1);
  await fs.writeFile(path.join(dir, 'rtl.f'), 'top.v\nleaf.v\n');
  const deleted = await index.update({ ...config, fileLists: ['rtl.f'] }, { [leaf]: 'module leaf; endmodule' });
  assert.equal(deleted.modules.length, 1);
  assert.ok(deleted.issues.some(issue => issue.message.includes('leaf.v')));
});

test('file count and size limits explicitly mark incomplete indexing', async () => {
  const dir = path.join(root, 'limits');
  await fs.mkdir(dir);
  await fs.writeFile(path.join(dir, 'a.v'), 'module a; endmodule');
  await fs.writeFile(path.join(dir, 'b.v'), 'module b; endmodule');
  assert.ok((await discover({ ...defaultConfig, root: dir, maxFiles: 1 })).issues.some(i => i.message.includes('索引不完整')));
  const snapshot = await new ProjectIndexer(parser).update({ ...defaultConfig, root: dir, maxFileBytes: 2 });
  assert.equal(snapshot.modules.length, 0);
  assert.equal(snapshot.issues.length, 2);
});

test('non-UTF8 closed files report errors instead of silently corrupting navigation', async () => {
  const dir = path.join(root, 'encoding');
  await fs.mkdir(dir);
  await fs.writeFile(path.join(dir, 'ansi.v'), Buffer.from([0xff, 0xfe, 0x61]));
  const snapshot = await new ProjectIndexer(parser).update({ ...defaultConfig, root: dir });
  assert.equal(snapshot.modules.length, 0);
  assert.equal(snapshot.issues[0].severity, 'error');
});

test('independent project indexes do not cross-bind identical module names', async () => {
  const first = new Hierarchy(parser.parse('first/top.v', 'module top; child u(); endmodule').modules);
  const second = new Hierarchy(parser.parse('second/child.v', 'module child; endmodule').modules);
  assert.equal(first.children(first.roots()[0])[0].candidates.length, 0);
  assert.equal(second.roots().length, 1);
});

const delta = (changedFiles = [], rediscover = false) => ({ changedFiles, rediscover });

test('event-driven updates read only the changed source, with zero idle filesystem reads', async () => {
  const dir = path.join(root, 'delta');
  await fs.mkdir(dir);
  const a = path.join(dir, 'a.v');
  const b = path.join(dir, 'b.v');
  await fs.writeFile(a, 'module a; b before(); endmodule');
  await fs.writeFile(b, 'module b; endmodule');
  const config = { ...defaultConfig, root: dir };
  const indexer = new ProjectIndexer(parser);
  await indexer.update(config);
  await fs.writeFile(a, 'module a; b after(); endmodule');
  const reads = [];
  const original = fs.readFile;
  fs.readFile = async function (file, ...args) {
    reads.push(path.resolve(file));
    return original.call(this, file, ...args);
  };
  try {
    const updated = await indexer.update(config, {}, false, delta([a]));
    assert.deepEqual(reads, [a]);
    assert.equal(updated.modules.find(mod => mod.name === 'a').instances[0].name, 'after');
    assert.equal(updated.parsedCount, 1);
    assert.equal(updated.statCount, 1);
    assert.equal(updated.discoveryCount, 0);
    reads.length = 0;
    const idle = await indexer.update(config, {}, false, delta());
    assert.deepEqual(reads, []);
    assert.equal(idle.statCount, 0);
    assert.equal(idle.parsedCount, 0);
    const realpath = fs.realpath;
    let resolutions = 0;
    fs.realpath = async (...args) => { resolutions++; return realpath(...args); };
    try {
      const outside = await indexer.update(config, { [path.join(root, 'other-project.v')]: 'module outside; endmodule' }, false, delta());
      assert.equal(outside.modules.length, 2);
      assert.equal(outside.readCount + outside.statCount + outside.discoveryCount, 0);
      assert.equal(resolutions, 0);
    } finally { fs.realpath = realpath; }
  } finally { fs.readFile = original; }
});

test('overlay edits and close/revert invalidate just their source', async () => {
  const dir = path.join(root, 'overlay-delta');
  await fs.mkdir(dir);
  const file = path.join(dir, 'top.v');
  await fs.writeFile(file, 'module disk; endmodule');
  const config = { ...defaultConfig, root: dir };
  const indexer = new ProjectIndexer(parser);
  await indexer.update(config);
  const edited = await indexer.update(config, { [file]: 'module unsaved; endmodule' }, false, delta([file]));
  assert.equal(edited.readCount, 0);
  assert.equal(edited.modules[0].name, 'unsaved');
  const reverted = await indexer.update(config, {}, false, delta([file]));
  assert.equal(reverted.modules[0].name, 'disk');
  assert.equal(reverted.readCount, 1);
});

test('forced refresh recovers a missed watcher event and updates bindings', async () => {
  const dir = path.join(root, 'reconcile');
  await fs.mkdir(dir);
  const file = path.join(dir, 'top.v');
  await fs.writeFile(file, 'module before_top; endmodule');
  const config = { ...defaultConfig, root: dir };
  const indexer = new ProjectIndexer(parser);
  await indexer.update(config);
  await fs.writeFile(file, 'module after_top; endmodule');
  assert.equal((await indexer.update(config, {}, false, delta())).modules[0].name, 'before_top');
  const refreshed = await indexer.update(config, {}, true, delta());
  assert.equal(refreshed.modules[0].name, 'after_top');
  assert.equal(refreshed.readCount, 1);
  assert.equal(refreshed.discoveryCount, 1);
});

test('nested list changes invalidate membership and expose excluded history explicitly', async () => {
  const dir = path.join(root, 'list-delta');
  await fs.mkdir(dir);
  await fs.writeFile(path.join(dir, 'one.v'), 'module one; endmodule');
  await fs.writeFile(path.join(dir, 'two.v'), 'module two; endmodule');
  await fs.writeFile(path.join(dir, 'history.v'), 'module one; endmodule');
  await fs.writeFile(path.join(dir, 'main.f'), '-f nested.lst\nhistory.v');
  const nested = path.join(dir, 'nested.lst');
  await fs.writeFile(nested, 'one.v');
  const config = { ...defaultConfig, root: dir, fileLists: ['main.f'], exclude: ['history.v'] };
  const indexer = new ProjectIndexer(parser);
  const first = await indexer.update(config);
  assert.deepEqual(first.excludedFiles, [path.join(dir, 'history.v')]);
  await fs.writeFile(nested, 'two.v');
  const second = await indexer.update(config, {}, false, delta([nested]));
  assert.deepEqual(second.modules.map(mod => mod.name), ['two']);
  assert.equal(second.discoveryCount, 1);
  await fs.unlink(nested);
  const missing = await indexer.update(config, {}, false, delta([nested]));
  assert.equal(missing.modules.length, 0);
  assert.ok(missing.issues.some(issue => issue.message.includes('nested.lst')));
});

test('workspace-based file-list paths are explicit and changing scope evicts stale modules', async () => {
  const dir = path.join(root, 'workspace-base');
  await fs.mkdir(path.join(dir, 'lists'), { recursive: true });
  await fs.writeFile(path.join(dir, 'top.v'), 'module top; endmodule');
  await fs.writeFile(path.join(dir, 'lists/main.f'), '-f lists/nested.f');
  await fs.writeFile(path.join(dir, 'lists/nested.f'), 'top.v');
  const config = { ...defaultConfig, root: dir, fileLists: ['lists/main.f'], fileListBase: 'workspace' };
  const indexer = new ProjectIndexer(parser);
  assert.equal((await indexer.update(config)).modules[0].name, 'top');
  const switched = await indexer.update({ ...config, exclude: ['top.v'] }, {}, false, delta());
  assert.equal(switched.modules.length, 0);
  assert.deepEqual(switched.excludedFiles, [path.join(dir, 'top.v')]);
});

test('scan creation/deletion invalidates membership without retaining deleted definitions', async () => {
  const dir = path.join(root, 'structural');
  await fs.mkdir(dir);
  const file = path.join(dir, 'top.v');
  const config = { ...defaultConfig, root: dir };
  const indexer = new ProjectIndexer(parser);
  assert.equal((await indexer.update(config)).modules.length, 0);
  await fs.writeFile(file, 'module top; endmodule');
  assert.equal((await indexer.update(config, {}, false, delta([file], true))).modules.length, 1);
  await fs.unlink(file);
  assert.equal((await indexer.update(config, {}, false, delta([file], true))).modules.length, 0);
});

test('worker keeps same-named modules and changes isolated between two real projects', async () => {
  const dirs = [path.join(root, 'worker-a'), path.join(root, 'worker-b')];
  for (const [i, dir] of dirs.entries()) {
    await fs.mkdir(dir);
    await fs.writeFile(path.join(dir, 'top.v'), `module top; missing from_${i}(); endmodule`);
  }
  const worker = new ParserWorker(path.resolve(__dirname, '../dist'));
  try {
    const configs = dirs.map(dir => ({ ...defaultConfig, root: dir }));
    const initial = await worker.update(configs, {}, false);
    assert.equal(initial[0].modules[0].instances[0].name, 'from_0');
    assert.equal(initial[1].modules[0].instances[0].name, 'from_1');
    const file = path.join(dirs[0], 'top.v');
    await fs.writeFile(file, 'module top; missing edited(); endmodule');
    const updated = await worker.update(configs, {}, false, { [dirs[0]]: delta([file]) });
    assert.equal(updated[0].modules[0].instances[0].name, 'edited');
    assert.equal(updated[1].modules[0].instances[0].name, 'from_1');
    assert.equal(updated[1].readCount, 0);
    assert.equal(updated[1].statCount, 0);
    assert.equal(updated[1].discoveryCount, 0);
  } finally { worker.dispose(); }
});

test('worker failure and timeout reject pending requests instead of hanging', async () => {
  const dir = path.join(root, 'failed-worker');
  await fs.mkdir(dir);
  await fs.writeFile(path.join(dir, 'worker.cjs'), "throw new Error('fixture crash');");
  const broken = new ParserWorker(dir, 1000);
  try { await assert.rejects(broken.update([], {}, false), /fixture crash/); }
  finally { broken.dispose(); }
  await fs.writeFile(path.join(dir, 'worker.cjs'), "require('node:worker_threads').parentPort.on('message', () => {});");
  const stalled = new ParserWorker(dir, 100);
  try { await assert.rejects(stalled.update([], {}, false), /已终止工作线程/); }
  finally { stalled.dispose(); }
});
