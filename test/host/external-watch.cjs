// 2026/10/19 10:09:00 by liaoweipeng1
const fs = require('node:fs/promises');
const path = require('node:path');
const assert = require('node:assert/strict');

// 在树首次发布时立即修改文件，覆盖跨进程建立外部监听时可能丢失的事件。
exports.verifyImmediateExternalEdits = async (api, root) => {
  for (let i = 0; i < 10; i++) {
    const directory = path.join(path.dirname(root), `immediate-external-${i}`);
    await fs.mkdir(directory);
    const file = path.join(directory, 'shared.v');
    await fs.writeFile(file, `module before_${i}; endmodule`);
    let changed;
    let writeError;
    const subscription = api.onDidChangeTreeData(() => {
      if (!changed && api.getSnapshots()[0].modules.some(mod => mod.name === `before_${i}`)) {
        changed = fs.writeFile(file, `module after_${i}; endmodule`).catch(error => { writeError = error; });
      }
    });
    try {
      await fs.appendFile(path.join(root, 'rtl.f'), `\n../immediate-external-${i}/shared.v\n`);
      const deadline = Date.now() + 5000;
      while (Date.now() < deadline && !api.getSnapshots()[0].modules.some(mod => mod.name === `after_${i}`)) {
        await new Promise(resolve => setTimeout(resolve, 20));
      }
      if (changed) { await changed; }
      if (writeError) { throw writeError; }
      assert.ok(api.getSnapshots()[0].modules.some(mod => mod.name === `after_${i}`),
        `新增外部文件 ${i} 首次展示后立刻修改必须更新`);
    } finally {
      subscription.dispose();
    }
  }
};
