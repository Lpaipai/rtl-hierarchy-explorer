// 2026/10/16 16:47:15 by liaoweipeng1
const path = require('node:path');
const fs = require('node:fs/promises');
const { runTests } = require('@vscode/test-electron');

async function main() {
  const executable = process.env.VSCODE_EXECUTABLE_PATH;
  if (!executable) {
    throw new Error('请将 VSCODE_EXECUTABLE_PATH 设置为本机 VS Code 可执行文件的绝对路径；测试不会自动下载安装编辑器。');
  }
  const root = path.resolve(__dirname, '..');
  const run = path.join(root, '.vscode-test', `run-${Date.now()}`);
  const workspace = path.join(run, 'workspace');
  const userData = path.join(run, 'user-data');
  const extensions = path.join(run, 'extensions');
  const portable = path.join(run, 'portable');
  const temp = path.join(run, 'tmp');
  for (const directory of [userData, extensions, portable, temp]) { await fs.mkdir(directory, { recursive: true }); }
  await fs.cp(path.join(root, 'test/fixtures/project'), workspace, { recursive: true });
  const other = path.join(run, 'workspace-other');
  await fs.mkdir(path.join(other, '.vscode'), { recursive: true });
  await fs.writeFile(path.join(other, 'top.v'), 'module demo_top; leaf other_only(); endmodule module leaf; endmodule');
  await fs.writeFile(path.join(other, 'rtl.f'), 'top.v');
  await fs.writeFile(path.join(other, '.vscode/settings.json'), JSON.stringify({
    'rtlHierarchy.analysisMode': 'static',
    'rtlHierarchy.fileLists': ['rtl.f'], 'rtlHierarchy.topModule': 'demo_top', 'rtlHierarchy.debounceMs': 100,
  }));
  const workspaceFile = path.join(run, 'test.code-workspace');
  await fs.writeFile(workspaceFile, JSON.stringify({ folders: [{ path: workspace }, { path: other }] }));
  process.env.VSCODE_PORTABLE = portable;
  process.env.TEMP = temp;
  process.env.TMP = temp;
  const developmentPath = process.env.RTL_TEST_EXTENSION_PATH || root;
  await runTests({
    vscodeExecutablePath: executable,
    extensionDevelopmentPath: developmentPath,
    extensionTestsPath: path.join(root, 'test/host/suite.cjs'),
    extensionTestsEnv: { RTL_TEST_REPORT_DIR: path.join(root, 'verification'),
      VSCODE_PORTABLE: portable, TEMP: temp, TMP: temp },
    launchArgs: [workspaceFile, '--user-data-dir', userData, '--extensions-dir', extensions,
      '--disable-extensions', '--disable-workspace-trust', '--skip-welcome', '--skip-release-notes',
      '--disable-updates', '--disable-telemetry', '--disable-gpu'],
  });
}
main().catch(error => { console.error(error); process.exitCode = 1; });
