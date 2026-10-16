// 2026/10/16 16:47:15 by liaoweipeng1
const vscode = require('vscode');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs/promises');

async function until(predicate, message) {
  const end = Date.now() + 15000;
  while (Date.now() < end) {
    if (await predicate()) { return; }
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error(message);
}

exports.run = async function () {
  const extension = vscode.extensions.getExtension('liaoweipeng1.rtl-hierarchy-explorer');
  assert.ok(extension, 'Extension is discoverable');
  const api = await extension.activate();
  await api.refresh(true);
  const reports = [];
  const snapshot = api.getSnapshots()[0];
  assert.equal(api.getSnapshots().length, 2);
  assert.equal(snapshot.modules.length, 2);
  assert.equal(snapshot.parsedCount, 2);
  reports.push('激活、离线 WASM 和独立工作线程成功');
  const project = api.getChildren()[0];
  const scope = api.getChildren(project).find(node => node.scope);
  const scopeGroups = api.getChildren(scope);
  assert.equal(api.getChildren(scopeGroups[0]).length, 1);
  assert.equal(api.getChildren(scopeGroups[1]).length, 2);
  reports.push('索引范围树显示文件列表和纳入的源文件');
  const top = api.getChildren(project).find(node => node.hierarchy);
  assert.equal(top.label, 'demo_top');
  const children = api.getChildren(top);
  assert.deepEqual(children.map(node => node.label), ['u_first', 'u_second']);
  const id = api.getTreeItem(children[0]).id;
  reports.push('真实 TreeDataProvider 顶层和两个参数实例正确');
  await vscode.commands.executeCommand('rtlHierarchy.openInstance', children[0]);
  assert.equal(vscode.window.activeTextEditor.document.uri.fsPath, path.join(snapshot.root, 'top.v'));
  assert.equal(vscode.window.activeTextEditor.selection.start.line, 2);
  await vscode.commands.executeCommand('rtlHierarchy.openDefinition', children[0]);
  assert.equal(vscode.window.activeTextEditor.document.uri.fsPath, path.join(snapshot.root, 'leaf.v'));
  assert.equal(vscode.window.activeTextEditor.selection.start.line, 1);
  reports.push('实例位置和模块定义两种跳转正确');
  const doc = await vscode.workspace.openTextDocument(path.join(snapshot.root, 'top.v'));
  await api.refresh();
  const edit = new vscode.WorkspaceEdit();
  edit.insert(doc.uri, new vscode.Position(0, 0), '// Extra line\n');
  assert.equal(await vscode.workspace.applyEdit(edit), true);
  await until(() => api.getSnapshots()[0].modules.find(mod => mod.name === 'demo_top')?.location.line === 2,
    'Unsaved edits should automatically refresh the hierarchy');
  const current = api.getSnapshots()[0];
  assert.equal(current.parsedCount, 1);
  assert.equal(current.cachedCount, 1);
  assert.equal(current.readCount, 0);
  assert.equal(current.statCount, 1);
  assert.equal(current.discoveryCount, 0);
  const untouched = api.getSnapshots()[1];
  assert.equal(untouched.modules.find(mod => mod.name === 'demo_top').instances[0].name, 'other_only');
  assert.equal(untouched.readCount + untouched.statCount + untouched.parsedCount + untouched.discoveryCount, 0);
  const updatedTop = api.getChildren(api.getChildren()[0]).find(node => node.hierarchy);
  assert.equal(api.getTreeItem(api.getChildren(updatedTop)[0]).id, id);
  reports.push('未保存编辑自动刷新、单文件解析、稳定节点 ID 正确');
  reports.push('另一工作区同名模块隔离，未受影响工程没有文件I/O');
  for (let i = 0; i < 25; i++) {
    const edit = new vscode.WorkspaceEdit();
    const text = doc.getText();
    edit.replace(doc.uri, new vscode.Range(doc.positionAt(0), doc.positionAt(text.length)),
      text.replace(/u_first|rapid_\d+/, `rapid_${i}`));
    assert.equal(await vscode.workspace.applyEdit(edit), true);
  }
  await until(() => api.getSnapshots()[0].modules.find(mod => mod.name === 'demo_top')?.instances[0]?.name === 'rapid_24',
    'Rapid edits must converge to the most recent document');
  reports.push('连续25次未保存编辑最终收敛到最新文本');
  await doc.save();
  await vscode.commands.executeCommand('workbench.action.closeAllEditors');
  const renamed = path.join(snapshot.root, 'renamed.v');
  await fs.rename(path.join(snapshot.root, 'leaf.v'), renamed);
  await until(() => api.getSnapshots()[0].issues.some(issue => issue.message.includes('leaf.v')), 'Missing listed file should report an error');
  await fs.writeFile(path.join(snapshot.root, 'rtl.f'), 'top.v\nrenamed.v\n');
  const canonicalRenamed = await fs.realpath(renamed);
  await until(() => api.getSnapshots()[0].modules.some(mod => mod.location.file === canonicalRenamed), 'File-list save should update membership');
  reports.push('删除/重命名提示、文件列表保存后刷新正确');
  const externalDirectory = path.join(path.dirname(snapshot.root), 'external');
  await fs.mkdir(externalDirectory);
  const external = path.join(externalDirectory, 'shared.v');
  await fs.writeFile(external, 'module shared_before; endmodule');
  await fs.appendFile(path.join(snapshot.root, 'rtl.f'), '\n../external/shared.v\n');
  await until(() => api.getSnapshots()[0].modules.some(mod => mod.name === 'shared_before'), 'External list source must be indexed');
  await fs.writeFile(external, 'module shared_after; endmodule');
  await until(() => api.getSnapshots()[0].modules.some(mod => mod.name === 'shared_after'), 'External source watcher must refresh');
  reports.push('工作区外显式源文件的修改监听正确');
  const folderConfig = vscode.workspace.getConfiguration('rtlHierarchy', vscode.Uri.file(snapshot.root));
  await folderConfig.update('exclude', ['renamed.v'], vscode.ConfigurationTarget.WorkspaceFolder);
  await until(() => !api.getSnapshots()[0].modules.some(mod => mod.name === 'leaf'), 'Exclusion changes must remove old definitions');
  assert.ok(api.getSnapshots()[0].excludedFiles.some(file => path.basename(file) === 'renamed.v'));
  await folderConfig.update('fileLists', [], vscode.ConfigurationTarget.WorkspaceFolder);
  await until(() => api.getSnapshots()[0].mode === 'scan' && !api.getSnapshots()[0].modules.some(mod => mod.name === 'shared_after'),
    'Switching to scan must evict external list-only sources');
  const added = path.join(snapshot.root, 'created.sv');
  await fs.writeFile(added, 'module created; endmodule');
  await until(() => api.getSnapshots()[0].modules.some(mod => mod.name === 'created'), 'Scan creation must refresh membership');
  await fs.unlink(added);
  await until(() => !api.getSnapshots()[0].modules.some(mod => mod.name === 'created'), 'Scan deletion must remove stale definitions');
  reports.push('排除规则、列表/扫描切换、新建删除文件均正确更新范围');
  const semanticSource = path.join(snapshot.root, 'semantic.sv');
  const header = path.join(externalDirectory, 'body.svh');
  await fs.writeFile(semanticSource, 'module leaf; endmodule\nmodule semantic_top #(parameter N=2);\n`include "body.svh"\nendmodule\n');
  await fs.writeFile(header, '`ifdef ENABLED\nfor(genvar i=0;i<N;i++) begin:lanes leaf u_lane(); end\n`else\nleaf inactive();\n`endif\n');
  await fs.writeFile(path.join(snapshot.root, 'semantic.f'), '+incdir+../external\nsemantic.sv\n');
  await folderConfig.update('fileLists', ['semantic.f'], vscode.ConfigurationTarget.WorkspaceFolder);
  await folderConfig.update('topModule', 'semantic_top', vscode.ConfigurationTarget.WorkspaceFolder);
  await folderConfig.update('defines', ['ENABLED'], vscode.ConfigurationTarget.WorkspaceFolder);
  await folderConfig.update('analysisMode', 'elaborated', vscode.ConfigurationTarget.WorkspaceFolder);
  const semantic = () => api.getSnapshots()[0].elaboration;
  await until(() => semantic()?.status === 'complete', 'Packaged native backend must elaborate the design');
  function treeNodes() {
    const walk = node => [node, ...api.getChildren(node).flatMap(walk)];
    return api.getChildren(api.getChildren()[0]).filter(node => node.elaborated).flatMap(walk);
  }
  assert.equal(treeNodes().filter(node => node.label === 'u_lane').length, 2);
  assert.ok(api.getTreeItem(api.getChildren()[0]).description.includes('精确展开完成'));
  const lane = treeNodes().find(node => node.label === 'u_lane');
  const laneId = api.getTreeItem(lane).id;
  await vscode.commands.executeCommand('rtlHierarchy.openInstance', lane);
  assert.equal(vscode.window.activeTextEditor.document.uri.fsPath, header);
  assert.equal(vscode.window.activeTextEditor.selection.start.line, 1);
  await vscode.commands.executeCommand('rtlHierarchy.openDefinition', lane);
  assert.equal(vscode.window.activeTextEditor.document.uri.fsPath, semanticSource);
  assert.equal(vscode.window.activeTextEditor.selection.start.line, 0);
  reports.push('包内 slang 真实激活，generate 展开及跨 include 源码导航正确');
  const headerDoc = await vscode.workspace.openTextDocument(header);
  const headerEdit = new vscode.WorkspaceEdit();
  headerEdit.insert(headerDoc.uri, new vscode.Position(0, 0), '// Unsaved header probe\n');
  assert.equal(await vscode.workspace.applyEdit(headerEdit), true);
  await until(() => semantic()?.status === 'pending', 'Unsaved include must hide the stale active tree');
  assert.equal(treeNodes().length, 0);
  await headerDoc.save();
  await until(() => semantic()?.status === 'complete', 'Saving include must re-elaborate automatically');
  assert.equal(api.getTreeItem(treeNodes().find(node => node.label === 'u_lane')).id, laneId);
  reports.push('未保存 include 明确等待，保存自动展开且节点 ID 保持稳定');
  await folderConfig.update('parameters', ['N=3'], vscode.ConfigurationTarget.WorkspaceFolder);
  await until(() => semantic()?.status === 'complete' && treeNodes().filter(node => node.label === 'u_lane').length === 3,
    'Changing top parameters must change the number of active instances');
  await folderConfig.update('defines', [], vscode.ConfigurationTarget.WorkspaceFolder);
  await until(() => semantic()?.status === 'complete' && treeNodes().some(node => node.label === 'inactive'),
    'Changing macros must select the actual branch');
  assert.ok(!treeNodes().some(node => node.label === 'u_lane'));
  assert.equal(api.getSnapshots()[1].elaboration, undefined);
  reports.push('宏/参数设置改变活动分支和实例数量，多工程模式相互隔离');
  await vscode.commands.executeCommand('workbench.action.closeAllEditors');
  await fs.writeFile(header, 'vendor_ip missing_ip();');
  await until(() => semantic()?.status === 'partial', 'Missing external IP must be shown as partial');
  assert.ok(api.getTreeItem(api.getChildren()[0]).description.includes('不完整'));
  assert.equal(treeNodes().find(node => node.label === 'missing_ip').elaborated.kind, 'unresolved');
  await fs.writeFile(header, 'leaf restored();');
  await until(() => semantic()?.status === 'complete' && treeNodes().some(node => node.label === 'restored'),
    'External header watcher must recover when the source is fixed');
  reports.push('外部头文件磁盘变更自动刷新，缺失 IP 明确标成不完整并可恢复');
  const report = { result: 'PASS', checks: reports, vscodeVersion: vscode.version, checkedAt: new Date().toISOString() };
  await fs.mkdir(process.env.RTL_TEST_REPORT_DIR, { recursive: true });
  await fs.writeFile(path.join(process.env.RTL_TEST_REPORT_DIR, 'host-report.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
};
