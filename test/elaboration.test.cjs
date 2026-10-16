// 2026/10/16 17:45:00 by liaoweipeng1
const { test, before } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { SlangProject, ParserWorker, defaultConfig, discover } = require('../dist/core.cjs');
const assets = path.resolve(__dirname, '../dist');
let directory;
before(async () => {
  await fs.mkdir(path.resolve(__dirname, '../.tmp'), { recursive: true });
  directory = await fs.mkdtemp(path.resolve(__dirname, '../.tmp/elaboration-'));
  process.env.TEMP = directory;
  process.env.TMP = directory;
});
async function fixture(files, options = {}) {
  const root = await fs.mkdtemp(path.join(directory, 'case-'));
  for (const [name, text] of Object.entries(files)) {
    await fs.mkdir(path.dirname(path.join(root, name)), { recursive: true });
    await fs.writeFile(path.join(root, name), text);
  }
  return { root, indexer: new SlangProject(assets),
    config: { ...defaultConfig, root, fileLists: ['rtl.f'], analysisMode: 'elaborated', topModule: 'top', ...options } };
}
function complete(snapshot) {
  assert.equal(snapshot.elaboration.status, 'complete', JSON.stringify(snapshot.issues));
  return snapshot.elaboration.roots[0];
}
function all(node) { return [node, ...node.children.flatMap(all)]; }
const idle = { changedFiles: [], rediscover: false };

test('evaluates parameter-dependent generate if/case/for and resolves cached instance bodies', async () => {
  const { indexer, config } = await fixture({
    'rtl.f': 'design.sv',
    'design.sv': `module leaf #(parameter W=1); endmodule
module branch #(parameter N=2);
for(genvar i=-2;i<N;i+=2) begin:g
  if(i<0) begin:negative leaf #(.W(i+10)) u_neg(); end
  else begin:positive case(i) 0: begin:zero leaf u_zero(); end default: begin:other leaf u_other(); end endcase end
end
endmodule
module top; branch #(.N(3)) a(); branch #(.N(1)) b(); branch #(.N(3)) c(); endmodule`,
  });
  const root = complete(await indexer.update(config));
  const [a, b, c] = root.children;
  assert.deepEqual(a.children[0].children.map(n => n.name), ['[-2]', '[0]', '[2]']);
  assert.deepEqual(b.children[0].children.map(n => n.name), ['[-2]', '[0]']);
  assert.deepEqual(all(a).filter(n => n.kind === 'instance').map(n => n.name), ['a', 'u_neg', 'u_zero', 'u_other']);
  assert.equal(all(c).find(n => n.name === 'u_neg').parameters[0], 'W = 8');
  assert.equal(new Set(all(root).map(n => n.id)).size, all(root).length);
});

test('preserves descending and multidimensional instance indices with hierarchical overrides', async () => {
  const { indexer, config } = await fixture({
    'rtl.f': 'design.sv\n-Gtop.arr[2].N=9',
    'design.sv': 'module leaf #(parameter N=1); endmodule module top; leaf arr[2:1](); leaf matrix[1:0][-1:0](); endmodule',
  });
  const root = complete(await indexer.update(config));
  assert.deepEqual(root.children[0].children.map(n => [n.name, n.parameters[0]]), [['[1]', 'N = 1'], ['[2]', 'N = 9']]);
  assert.deepEqual(root.children[1].children.map(n => n.name), ['[0]', '[1]']);
  assert.deepEqual(root.children[1].children[0].children.map(n => n.name), ['[-1]', '[0]']);
});

test('applies nested file-list macros, literal apostrophes, include files and configuration overrides', async () => {
  const { indexer, config, root } = await fixture({
    'rtl.f': '-F lists/part.f',
    'lists/part.f': "+incdir+../include\n+define+ENABLED+COUNT=4'h2\n../top.sv\n",
    'include/body.svh': '`ifdef ENABLED\nfor(genvar k=0;k<`COUNT;k++) begin:lanes leaf u(); end\n`else\nleaf inactive();\n`endif',
    'top.sv': '`include "defs.svh"\nmodule top #(parameter N=1);\n`include "body.svh"\nif(N==3) begin:special leaf yes(); end\nendmodule',
    'include/defs.svh': 'module leaf; endmodule',
  }, { parameters: ['N=3'] });
  const first = await indexer.update(config);
  const nodes = all(complete(first));
  assert.equal(nodes.filter(n => n.name === 'u').length, 2);
  assert.ok(nodes.some(n => n.name === 'yes'));
  assert.ok(!nodes.some(n => n.name === 'inactive'));
  assert.ok(first.elaboration.dependencies.some(file => file.endsWith('body.svh')));
  assert.equal(nodes.find(n => n.name === 'u').definition.file, path.join(root, 'include/defs.svh'));
  const changed = await indexer.update({ ...config, defines: ["COUNT=4'h3"] });
  assert.equal(all(complete(changed)).filter(n => n.name === 'u').length, 3);
});

test('keeps file order for single-unit preprocessing and honors -v library root semantics', async () => {
  const { indexer, config } = await fixture({
    'rtl.f': '--single-unit\nz_defs.sv\na_top.sv\n-v lib.sv',
    'z_defs.sv': '`define COUNT 2',
    'a_top.sv': 'module top; for(genvar i=0;i<`COUNT;i++) begin:g leaf u(); end endmodule',
    'lib.sv': 'module leaf; endmodule module unused_library; endmodule',
  }, { topModule: '' });
  const snapshot = await indexer.update(config);
  assert.equal(complete(snapshot).name, 'top');
  assert.equal(snapshot.elaboration.roots.length, 1);
  assert.equal(all(complete(snapshot)).filter(n => n.name === 'u').length, 2);
});

test('maps include/macro navigation and UTF-8 byte columns to VS Code UTF-16', async () => {
  const source = '\uFEFFmodule leaf; endmodule\nmodule top; /* 中文😀 */ leaf \\u.special (); endmodule';
  const { indexer, config, root } = await fixture({ 'rtl.f': '中文 路径.sv', '中文 路径.sv': source });
  await fs.writeFile(path.join(root, 'rtl.f'), '"中文 路径.sv"');
  const child = complete(await indexer.update(config)).children[0];
  assert.equal(child.location.line, 1);
  assert.equal(child.location.column, source.split('\n')[1].indexOf('\\u.special'));
  assert.equal(child.definition.line, 0);
  assert.equal(child.definition.column, 7);
  assert.equal(child.location.file, path.join(root, '中文 路径.sv'));
});

test('caches idle runs, invalidates include edits and waits for unsaved source/header/list files', async () => {
  const { indexer, config, root } = await fixture({
    'rtl.f': 'top.sv', 'top.sv': 'module leaf; endmodule module top;\n`include "body.svh"\nendmodule',
    'body.svh': 'leaf old_instance();',
  });
  const first = complete(await indexer.update(config));
  assert.equal((await indexer.update(config, [], false, idle)).elaboration.cached, true);
  assert.equal((await indexer.update(config, [path.join(root, 'README.md')], false, idle)).elaboration.status, 'complete');
  for (const filename of ['top.sv', 'body.svh', 'rtl.f']) {
    const pending = await indexer.update(config, [path.join(root, filename)], false, idle);
    assert.equal(pending.elaboration.status, 'pending');
    assert.deepEqual(pending.elaboration.roots, []);
  }
  const header = path.join(root, 'body.svh');
  await fs.writeFile(header, 'leaf new_instance();');
  const changed = complete(await indexer.update(config, [], false, { changedFiles: [header], rediscover: false }));
  assert.equal(changed.children[0].name, 'new_instance');
  assert.equal(changed.id, first.id);
  await fs.writeFile(header, 'leaf recovered_instance();');
  assert.equal(complete(await indexer.update(config, [], true, idle)).children[0].name, 'recovered_instance');
});

test('navigates macro-generated instances and physical files despite line directives', async () => {
  const text = '`define INST(n) leaf n();\n`line 900 "virtual_name.sv" 0\nmodule leaf; endmodule\nmodule top; /* 中文😀 */ `INST(generated) endmodule';
  const { indexer, config, root } = await fixture({ 'rtl.f': 'real.sv', 'real.sv': text });
  const instance = complete(await indexer.update(config)).children[0];
  assert.equal(instance.name, 'generated');
  assert.equal(instance.location.file, path.join(root, 'real.sv'));
  assert.equal(instance.location.line, 3);
  assert.equal(instance.definition.line, 2);
  assert.ok(instance.location.column >= text.split('\n')[3].indexOf('`INST'));
});

test('top changes and explicit default timescale produce a new elaboration', async () => {
  const { indexer, config } = await fixture({
    'rtl.f': 'a.sv\nb.sv',
    'a.sv': '`timescale 1ns/1ps\nmodule leaf; endmodule',
    'b.sv': 'module top; leaf first(); endmodule module second; leaf other(); endmodule',
  });
  assert.notEqual((await indexer.update(config)).elaboration.status, 'complete');
  assert.equal(complete(await indexer.update({ ...config, defaultTimescale: '1ns/1ps' })).children[0].name, 'first');
  const other = complete(await indexer.update({ ...config, defaultTimescale: '1ns/1ps', topModule: 'second' }));
  assert.equal(other.name, 'second');
  assert.equal(other.children[0].name, 'other');
});

test('reports unknown IP, active duplicate definitions and syntax errors as incomplete', async () => {
  const { indexer, config, root } = await fixture({
    'rtl.f': 'top.sv', 'top.sv': 'module top; vendor_ip black_box(); endmodule',
  });
  const missing = await indexer.update(config);
  assert.equal(missing.elaboration.status, 'partial');
  assert.equal(missing.elaboration.roots[0].children[0].kind, 'unresolved');
  await fs.writeFile(path.join(root, 'top.sv'), 'module leaf; endmodule module leaf; endmodule module top; leaf u(); endmodule');
  const duplicate = await indexer.update(config, [], true);
  assert.notEqual(duplicate.elaboration.status, 'complete');
  assert.ok(duplicate.issues.some(issue => /DuplicateDefinition|duplicate-definition|duplicate definition/.test(issue.message)));
  await fs.writeFile(path.join(root, 'top.sv'), 'module top; invalid !! endmodule');
  assert.notEqual((await indexer.update(config, [], true)).elaboration.status, 'complete');
});

test('selects only active ifdef definitions without false duplicate warnings', async () => {
  const { indexer, config } = await fixture({ 'rtl.f': 'top.sv',
    'top.sv': '`ifdef ON\nmodule top; leaf enabled(); endmodule\n`else\nmodule top; leaf disabled(); endmodule\n`endif\nmodule leaf; endmodule' });
  assert.equal(complete(await indexer.update(config)).children[0].name, 'disabled');
  assert.equal(complete(await indexer.update({ ...config, defines: ['ON'] })).children[0].name, 'enabled');
});

test('does not silently compile truncated or unsupported project scope', async () => {
  const { indexer, config, root } = await fixture({
    'rtl.f': '-y vendor\ntop.sv', 'top.sv': 'module top; endmodule',
  });
  assert.equal((await indexer.update(config)).elaboration.status, 'failed');
  await fs.writeFile(path.join(root, 'rtl.f'), 'top.sv\nmissing.sv');
  assert.equal((await indexer.update(config, [], true)).elaboration.status, 'failed');
  assert.equal((await indexer.update({ ...config, maxFiles: 1 }, [], true)).elaboration.status, 'failed');
});

test('expands bind/interface hierarchy and includes primitive instances', async () => {
  const { indexer, config } = await fixture({ 'rtl.f': 'top.sv', 'top.sv': `
interface bus; logic a; endinterface
module checker_mod; endmodule
module leaf; endmodule
module top; wire a,b; bus u_bus(); leaf u_leaf(); not u_inv(a,b); endmodule
bind leaf checker_mod u_check();` });
  const nodes = all(complete(await indexer.update(config)));
  assert.ok(nodes.some(node => node.name === 'u_bus' && node.type === 'bus'));
  assert.ok(nodes.some(node => node.name === 'u_check' && node.type === 'checker_mod'));
  assert.ok(nodes.some(node => node.name === 'u_inv' && node.kind === 'primitive'));
});

test('terminates native timeout and rejects a tampered executable before launching', async () => {
  const { config } = await fixture({ 'rtl.f': 'top.sv', 'top.sv': 'module top; endmodule' });
  const transitions = [];
  const slow = new SlangProject(assets, (pid, running) => transitions.push({ pid, running }), 1);
  const snapshot = await slow.update(config);
  assert.equal(snapshot.elaboration.status, 'failed');
  assert.ok(snapshot.issues.some(issue => /已结束解析进程/.test(issue.message)));
  assert.equal(transitions.at(-1).running, false);
  assert.throws(() => process.kill(transitions[0].pid, 0));
  const fake = path.join(directory, 'fake-assets');
  await fs.mkdir(path.join(fake, 'slang-runtime'), { recursive: true });
  await fs.writeFile(path.join(fake, 'slang-runtime/python.exe'), 'invalid');
  const invalid = await new SlangProject(fake).update(config);
  assert.ok(invalid.issues.some(issue => issue.message.includes('校验失败')));
});

test('isolates semantic projects with identical module names in the real worker', async () => {
  const a = await fixture({ 'rtl.f': 'top.sv', 'top.sv': 'module top; leaf first(); endmodule module leaf; endmodule' });
  const b = await fixture({ 'rtl.f': 'top.sv', 'top.sv': 'module top; leaf second(); endmodule module leaf; endmodule' });
  const worker = new ParserWorker(assets);
  try {
    const snapshots = await worker.update([a.config, b.config], {}, false);
    assert.equal(complete(snapshots[0]).children[0].name, 'first');
    assert.equal(complete(snapshots[1]).children[0].name, 'second');
    const pending = await worker.update([a.config, b.config], {}, false, {}, [path.join(a.root, 'top.sv')]);
    assert.equal(pending[0].elaboration.status, 'pending');
    assert.equal(pending[1].elaboration.cached, true);
  } finally { worker.dispose(); }
});
