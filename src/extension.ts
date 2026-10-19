// 2026/10/16 16:47:15 by liaoweipeng1
import * as vscode from 'vscode';
import path from 'node:path';
import { watch, FSWatcher } from 'node:fs';
import picomatch from 'picomatch';
import { ParserWorker } from './worker-client';
import { defaultConfig, ElaboratedNode, Issue, Location, ProjectChanges, ProjectConfig, ProjectSnapshot } from './model';
import { Hierarchy, HierarchyNode } from './hierarchy';

interface ViewNode {
  id: string;
  label: string;
  root?: string;
  hierarchy?: HierarchyNode;
  elaborated?: ElaboratedNode;
  issue?: Issue;
  issueGroup?: Issue[];
  project?: ProjectSnapshot;
  scope?: ProjectSnapshot;
  sourceGroup?: string[];
  source?: string;
  excludedGroup?: boolean;
  excludedPath?: string;
}

function pathKey(file: string): string {
  const absolute = path.resolve(file);
  return process.platform === 'win32' ? absolute.toLowerCase() : absolute;
}

class Explorer implements vscode.TreeDataProvider<ViewNode>, vscode.Disposable {
  private readonly emitter = new vscode.EventEmitter<ViewNode | undefined>();
  readonly onDidChangeTreeData = this.emitter.event;
  readonly output = vscode.window.createOutputChannel('RTL Hierarchy');
  private readonly diagnostics = vscode.languages.createDiagnosticCollection('rtlHierarchy');
  private readonly view: vscode.TreeView<ViewNode>;
  private worker?: ParserWorker;
  private readonly models = new Map<string, Hierarchy>();
  private snapshots: ProjectSnapshot[] = [];
  private readonly selections: Record<string, string>;
  private timer?: ReturnType<typeof setTimeout>;
  private running?: Promise<void>;
  private revision = 0;
  private disposed = false;
  private force = false;
  private readonly externalWatchers = new Map<string, vscode.FileSystemWatcher>();
  private readonly nativeExternalWatchers = new Map<string, { watcher: FSWatcher; files: Set<string> }>();
  private watchSignature = '';
  private readonly pendingChanges = new Map<string, { files: Set<string>; rediscover: boolean }>();

  constructor(private readonly context: vscode.ExtensionContext) {
    this.selections = { ...context.workspaceState.get<Record<string, string>>('selectedTops', {}) };
    this.view = vscode.window.createTreeView('rtlHierarchy.tree', { treeDataProvider: this, showCollapseAll: true });
    context.subscriptions.push(this, this.view, this.output, this.diagnostics, this.emitter);
    const commands: Record<string, (...args: any[]) => unknown> = {
      refresh: () => this.refresh(true),
      selectTop: () => this.selectTop(),
      selectFileList: () => this.selectFileList(),
      manageScope: () => this.manageScope(),
      selectMode: () => this.selectMode(),
      openSource: (node: ViewNode) => this.open(node?.source ? {
        file: node.source, line: 0, column: 0, endLine: 0, endColumn: 0,
      } : undefined),
      openInstance: (node: ViewNode) => this.open(node?.elaborated?.location ?? node?.hierarchy?.instance?.location ?? node?.hierarchy?.module?.location ?? node?.issue?.location),
      openDefinition: (node: ViewNode) => this.openDefinition(node),
      showLog: () => this.output.show(),
    };
    for (const [name, callback] of Object.entries(commands)) {
      context.subscriptions.push(vscode.commands.registerCommand(`rtlHierarchy.${name}`, callback));
    }
    const watcher = vscode.workspace.createFileSystemWatcher('**/*');
    const changed = (uri: vscode.Uri) => this.fileChanged(uri, false);
    const structural = (uri: vscode.Uri) => this.fileChanged(uri, true);
    context.subscriptions.push(watcher, watcher.onDidChange(changed), watcher.onDidCreate(structural), watcher.onDidDelete(structural));
    context.subscriptions.push(vscode.workspace.onDidChangeTextDocument(event => {
      if (event.contentChanges.length) { changed(event.document.uri); }
    }), vscode.workspace.onDidSaveTextDocument(doc => changed(doc.uri)),
    vscode.workspace.onDidOpenTextDocument(doc => changed(doc.uri)),
    vscode.workspace.onDidCloseTextDocument(doc => changed(doc.uri)),
    vscode.workspace.onDidChangeWorkspaceFolders(() => this.schedule()),
    vscode.workspace.onDidGrantWorkspaceTrust(() => this.schedule()),
    vscode.workspace.onDidChangeConfiguration(event => {
      if (event.affectsConfiguration('rtlHierarchy')) { this.schedule(); }
    }));
    this.schedule();
  }

  private configs(): ProjectConfig[] {
    return (vscode.workspace.workspaceFolders ?? []).filter(folder => folder.uri.scheme === 'file').map(folder => {
      const cfg = vscode.workspace.getConfiguration('rtlHierarchy', folder.uri);
      const selection = this.selected(folder.uri.fsPath);
      const selectedModule = this.snapshots.find(item => item.root === folder.uri.fsPath)?.modules.find(mod => mod.id === selection);
      const legacyName = selection && /::\d+$/.test(selection) ?
        selection.slice(selection.indexOf('::') + 2, selection.lastIndexOf('::')) : undefined;
      return { root: folder.uri.fsPath,
        analysisMode: vscode.workspace.isTrusted ? cfg.get('analysisMode', 'elaborated') : 'static',
        topModule: selectedModule?.name ?? legacyName ?? selection,
        includeDirectories: cfg.get('includeDirectories', []), defines: cfg.get('defines', []),
        parameters: cfg.get('parameters', []), singleUnit: cfg.get('singleUnit', false),
        defaultTimescale: cfg.get('defaultTimescale', ''),
        fileLists: cfg.get('fileLists', defaultConfig.fileLists),
        fileListBase: cfg.get('fileListBase', defaultConfig.fileListBase),
        include: cfg.get('include', defaultConfig.include), exclude: cfg.get('exclude', defaultConfig.exclude),
        maxFiles: cfg.get('maxFiles', defaultConfig.maxFiles), maxFileBytes: cfg.get('maxFileBytes', defaultConfig.maxFileBytes) };
    });
  }

  private selected(root: string): string | undefined {
    return this.selections[root] || vscode.workspace.getConfiguration('rtlHierarchy', vscode.Uri.file(root)).get<string>('topModule') || undefined;
  }

  private schedule(): void {
    for (const config of this.configs()) {
      const pending = this.pendingChanges.get(config.root) ?? { files: new Set<string>(), rediscover: false };
      pending.rediscover = true;
      this.pendingChanges.set(config.root, pending);
    }
    this.debounce();
  }

  private fileChanged(uri: vscode.Uri, structural: boolean): void {
    if (uri.scheme !== 'file' || this.disposed) { return; }
    const key = pathKey(uri.fsPath);
    let relevant = false;
    for (const config of this.configs()) {
      const snapshot = this.snapshots.find(item => pathKey(item.root) === pathKey(config.root));
      const related = (file: string) => pathKey(file) === key || (structural && pathKey(file).startsWith(key + path.sep));
      const files = snapshot?.files.filter(related) ?? [];
      const dependencyChanged = snapshot?.elaboration?.dependencies.some(related);
      const headerChanged = config.analysisMode === 'elaborated' &&
        /\.(v|sv|vh|svh)$/i.test(uri.fsPath) && snapshot?.elaboration?.watchDirectories.some(dir => key.startsWith(pathKey(dir) + path.sep));
      const listChanged = snapshot?.listFiles.some(related) || config.fileLists.some(file => related(path.resolve(config.root, file)));
      const relative = path.relative(config.root, uri.fsPath).replace(/\\/g, '/');
      const inside = relative === '' || (relative !== '..' && !relative.startsWith('../') && !path.isAbsolute(relative));
      const excluded = picomatch(config.exclude, { dot: true, nocase: process.platform === 'win32' });
      const included = picomatch(config.include, { dot: true, nocase: process.platform === 'win32' });
      const scanChanged = !config.fileLists.length && inside && !excluded(relative) &&
        !excluded(`${relative}/__scope_probe__`) && (structural || included(relative));
      const initializing = !snapshot && inside && /\.(v|sv|vh|svh)$/i.test(uri.fsPath);
      if (!files.length && !listChanged && !scanChanged && !initializing && !dependencyChanged && !headerChanged) { continue; }
      const pending = this.pendingChanges.get(config.root) ?? { files: new Set<string>(), rediscover: false };
      files.forEach(file => pending.files.add(file));
      pending.files.add(uri.fsPath);
      pending.rediscover ||= !!listChanged || (scanChanged && structural);
      this.pendingChanges.set(config.root, pending);
      relevant = true;
    }
    if (relevant) { this.debounce(); }
  }

  private debounce(): void {
    this.revision++;
    if (this.timer) { clearTimeout(this.timer); }
    const delay = vscode.workspace.getConfiguration('rtlHierarchy').get<number>('debounceMs', 350);
    this.timer = setTimeout(() => { void this.refresh(); }, delay);
  }

  async refresh(force = false): Promise<void> {
    if (this.disposed) { return; }
    this.force ||= force;
    this.revision++;
    if (this.timer) { clearTimeout(this.timer); this.timer = undefined; }
    if (!this.running) {
      this.running = this.run().finally(() => { this.running = undefined; });
    }
    return this.running;
  }

  private async run(): Promise<void> {
    let processed = -1;
    while (!this.disposed && processed !== this.revision) {
      processed = this.revision;
      const force = this.force;
      this.force = false;
      this.view.message = '正在本地索引…';
      try {
        if (!this.worker) { this.worker = new ParserWorker(this.context.asAbsolutePath('dist')); }
        const configs = this.configs();
        const changes: Record<string, ProjectChanges> = {};
        for (const config of configs) {
          const pending = this.pendingChanges.get(config.root);
          changes[config.root] = { changedFiles: [...(pending?.files ?? [])], rediscover: pending?.rediscover ?? false };
        }
        this.pendingChanges.clear();
        const overlays: Record<string, string> = {};
        for (const doc of vscode.workspace.textDocuments) {
          if (doc.uri.scheme === 'file' && /\.(v|sv|vh|svh)$/i.test(doc.uri.fsPath)) {
            overlays[doc.uri.fsPath] = doc.getText();
          }
        }
        const dirtyFiles = vscode.workspace.textDocuments.filter(doc => doc.uri.scheme === 'file' && doc.isDirty).map(doc => doc.uri.fsPath);
        const snapshots = await this.worker.update(configs, overlays, force, changes, dirtyFiles);
        if (this.disposed || processed !== this.revision) { continue; }
        this.snapshots = snapshots;
        this.models.clear();
        const diagnostics = new Map<string, vscode.Diagnostic[]>();
        for (const snapshot of snapshots) {
          this.models.set(snapshot.root, new Hierarchy(snapshot.modules));
          this.output.appendLine(snapshot.elaboration ?
            `${snapshot.root}: slang ${snapshot.elaboration.status}，${snapshot.modules.length} 个定义，${snapshot.elaboration.dependencies.length} 个依赖；${snapshot.elaboration.cached ? '复用缓存' : '完整展开'}，${snapshot.elapsedMs} ms（原生文件 I/O 未计数）` :
            `${snapshot.root}: ${snapshot.modules.length} 个声明，${snapshot.files.length} 个文件；解析 ${snapshot.parsedCount}，缓存 ${snapshot.cachedCount}，读取 ${snapshot.readCount}，stat ${snapshot.statCount}，范围发现 ${snapshot.discoveryCount}，${snapshot.elapsedMs} ms`);
          for (const issue of snapshot.issues) {
            this.output.appendLine(`${issue.severity}: ${issue.message}`);
            if (issue.location) {
              const loc = issue.location;
              const list = diagnostics.get(loc.file) ?? [];
              const diagnostic = new vscode.Diagnostic(new vscode.Range(loc.line, loc.column, loc.endLine, loc.endColumn), issue.message,
                issue.severity === 'error' ? vscode.DiagnosticSeverity.Error : vscode.DiagnosticSeverity.Warning);
              diagnostic.source = 'RTL Hierarchy';
              list.push(diagnostic);
              diagnostics.set(loc.file, list);
            }
          }
        }
        this.diagnostics.clear();
        for (const [file, list] of diagnostics) { this.diagnostics.set(vscode.Uri.file(file), list); }
        const count = snapshots.reduce((sum, s) => sum + s.modules.length, 0);
        const states = snapshots.map(snapshot => snapshot.elaboration ? this.semanticStatus(snapshot) : '静态语法（未展开）');
        this.view.message = snapshots.length ? `${count} 个定义 · ${[...new Set(states)].join(' / ')}${vscode.workspace.isTrusted ? '' : ' · 受限工作区仅静态模式'}` : '打开一个本地 RTL 工程文件夹开始。';
        this.updateExternalWatchers();
        this.emitter.fire(undefined);
      } catch (error) {
        if (this.disposed) { return; }
        this.view.message = `索引失败，旧结果可能过期：${String(error)}`;
        this.output.appendLine(String(error));
        this.worker?.dispose();
        this.worker = undefined;
      }
    }
  }

  private updateExternalWatchers(): void {
    const external = this.snapshots.flatMap(snapshot => [...snapshot.files, ...snapshot.listFiles, ...(snapshot.elaboration?.dependencies ?? [])]
      .filter(file => !vscode.workspace.getWorkspaceFolder(vscode.Uri.file(file))));
    const directories = this.snapshots.flatMap(snapshot => snapshot.elaboration?.watchDirectories ?? [])
      .filter(dir => !vscode.workspace.getWorkspaceFolder(vscode.Uri.file(dir)));
    const signature = JSON.stringify([[...new Set(external)].sort(), [...new Set(directories)].sort()]);
    if (signature === this.watchSignature) { return; }
    this.watchSignature = signature;
    const desired = new Map<string, vscode.RelativePattern>();
    const parents = new Map<string, { directory: string; files: Set<string> }>();
    const added: string[] = [];
    for (const file of new Set(external)) {
      const key = `file:${pathKey(file)}`;
      desired.set(key, new vscode.RelativePattern(path.dirname(file), path.basename(file)));
      if (!this.externalWatchers.has(key)) { added.push(file); }
      const directory = path.dirname(file);
      const parent = parents.get(pathKey(directory)) ?? { directory, files: new Set<string>() };
      parent.files.add(file);
      parents.set(pathKey(directory), parent);
    }
    for (const dir of new Set(directories)) {
      desired.set(`dir:${pathKey(dir)}`, new vscode.RelativePattern(dir, '**/*.{v,sv,vh,svh}'));
    }
    // 保留未变化的监听，避免每次范围变化都拆掉已有文件的监听。
    for (const [key, watcher] of this.externalWatchers) {
      if (!desired.has(key)) { watcher.dispose(); this.externalWatchers.delete(key); }
    }
    for (const [key, pattern] of desired) {
      if (this.externalWatchers.has(key)) { continue; }
      const watcher = vscode.workspace.createFileSystemWatcher(pattern);
      watcher.onDidChange(uri => this.fileChanged(uri, false));
      watcher.onDidCreate(uri => this.fileChanged(uri, true));
      watcher.onDidDelete(uri => this.fileChanged(uri, true));
      this.externalWatchers.set(key, watcher);
    }
    // VS Code 的外部监听跨进程异步建立；按父目录同步监听，覆盖首次展示后的空窗。
    // 原有 VS Code 监听仍负责缺失目录恢复与递归 include；不增加周期性文件扫描。
    for (const [key, entry] of this.nativeExternalWatchers) {
      if (!parents.has(key)) { entry.watcher.close(); this.nativeExternalWatchers.delete(key); }
    }
    for (const [key, parent] of parents) {
      const existing = this.nativeExternalWatchers.get(key);
      if (existing) { existing.files = parent.files; continue; }
      try {
        const watcher = watch(parent.directory, { persistent: false }, (event, filename) => {
          const files = this.nativeExternalWatchers.get(key)?.files ?? [];
          const changed = filename ? pathKey(path.join(parent.directory, filename.toString())) : undefined;
          for (const file of files) {
            if (!changed || changed === pathKey(file) || (event === 'rename' && filename === path.basename(parent.directory))) {
              this.fileChanged(vscode.Uri.file(file), event === 'rename');
            }
          }
        });
        this.nativeExternalWatchers.set(key, { watcher, files: parent.files });
        watcher.on('error', error => {
          watcher.close();
          if (this.nativeExternalWatchers.get(key)?.watcher !== watcher) { return; }
          this.nativeExternalWatchers.delete(key);
          this.watchSignature = '';
          this.output.appendLine(`外部目录同步监听中断，保留 VS Code 监听：${String(error)}`);
          for (const file of parent.files) { this.fileChanged(vscode.Uri.file(file), true); }
        });
      } catch (error) {
        this.output.appendLine(`外部目录同步监听暂不可用，保留 VS Code 监听：${String(error)}`);
      }
    }
    // 首次读取与开始监听之间也可能发生变化；仅补查新加入的外部文件。
    for (const file of added) { this.fileChanged(vscode.Uri.file(file), true); }
  }

  private semanticStatus(snapshot?: ProjectSnapshot): string {
    if (!snapshot?.elaboration) { return '层次已更新，请重新展开'; }
    return { complete: '精确展开完成', partial: '展开不完整，请查看错误', failed: '精确展开失败', pending: '有修改未保存，等待展开' }[snapshot.elaboration!.status];
  }

  getChildren(node?: ViewNode): ViewNode[] {
    if (!node) {
      return this.snapshots.map(project => ({ id: project.root, label: path.basename(project.root), root: project.root, project }));
    }
    if (node.issueGroup) {
      return node.issueGroup.map((issue, i) => ({ id: `${node.id}/${i}`, label: issue.message, issue }));
    }
    if (node.scope) {
      const scope = node.scope;
      return [
        { id: `${node.id}/lists`, label: `文件列表 (${scope.listFiles.length})`, sourceGroup: scope.listFiles, root: node.root },
        { id: `${node.id}/sources`, label: `已纳入源文件 (${scope.files.length})`, sourceGroup: scope.files, root: node.root },
        ...(scope.elaboration ? [{ id: `${node.id}/dependencies`, label: `展开依赖（含 include）(${scope.elaboration.dependencies.length})`, sourceGroup: scope.elaboration.dependencies, root: node.root }] : []),
        { id: `${node.id}/excluded`, label: `被排除的文件或目录 (${scope.excludedFiles.length})`, sourceGroup: scope.excludedFiles, root: node.root, excludedGroup: true },
      ];
    }
    if (node.elaborated) {
      return node.elaborated.children.map(elaborated => ({ id: `${node.root}/${elaborated.id}`, label: elaborated.name, root: node.root, elaborated }));
    }
    if (node.sourceGroup) {
      return node.sourceGroup.map(file => ({ id: `${node.id}/${file}`, label: node.root ? path.relative(node.root, file) : file,
        source: node.excludedGroup ? undefined : file, excludedPath: node.excludedGroup ? file : undefined }));
    }
    const model = node.root ? this.models.get(node.root) : undefined;
    if (!model) { return []; }
    if (node.project) {
      const result: ViewNode[] = [{ id: `${node.id}/scope`, label: '索引范围', scope: node.project, root: node.root }];
      if (node.project.issues.length) {
        result.push({ id: `${node.id}/issues`, label: `${node.project.issues.length} 条索引提示`, issueGroup: node.project.issues });
      }
      if (node.project.elaboration) {
        const exact = node.project.elaboration;
        if (exact.status !== 'complete') {
          result.push({ id: `${node.id}/status`, label: this.semanticStatus(node.project) });
        }
        result.push(...exact.roots.map(elaborated => ({ id: `${node.root}/${elaborated.id}`, label: elaborated.name, root: node.root, elaborated })));
        return result;
      }
      const selected = this.selected(node.root!);
      const roots = model.roots(selected);
      if (!roots.length) {
        result.push({ id: `${node.id}/empty`, label: selected ? '所选顶层已不存在，请重新选择顶层。' : '未发现模块，请检查 .f、扫描范围和索引提示。' });
      }
      result.push(...roots.map(hierarchy => ({ id: `${node.root}/${hierarchy.id}`, label: hierarchy.label, root: node.root, hierarchy })));
      return result;
    }
    return node.hierarchy ? model.children(node.hierarchy).map(hierarchy => ({ id: `${node.root}/${hierarchy.id}`, label: hierarchy.label, root: node.root, hierarchy })) : [];
  }

  getTreeItem(node: ViewNode): vscode.TreeItem {
    const expandable = !!node.project || !!node.scope || !!node.issueGroup || this.getChildren(node).length > 0;
    const item = new vscode.TreeItem(node.label, expandable ?
      (node.project ? vscode.TreeItemCollapsibleState.Expanded : vscode.TreeItemCollapsibleState.Collapsed) : vscode.TreeItemCollapsibleState.None);
    item.id = node.id;
    if (node.project) {
      item.description = `${node.project.mode === 'fileList' ? '.f' : '扫描'} · ${node.project.files.length} 文件 · ${node.project.elaboration ? this.semanticStatus(node.project) : '静态'}`;
      item.iconPath = new vscode.ThemeIcon('project');
      item.tooltip = node.project.root;
    } else if (node.scope || node.sourceGroup) {
      item.iconPath = new vscode.ThemeIcon('folder-library');
    } else if (node.source) {
      item.resourceUri = vscode.Uri.file(node.source);
      item.tooltip = node.source;
      item.iconPath = vscode.ThemeIcon.File;
      item.command = { command: 'rtlHierarchy.openSource', title: '打开源文件', arguments: [node] };
    } else if (node.excludedPath) {
      item.iconPath = new vscode.ThemeIcon('exclude');
      item.tooltip = `已被 exclude 规则排除：${node.excludedPath}`;
    } else if (node.elaborated) {
      const entry = node.elaborated;
      item.contextValue = 'rtlModule';
      item.description = `${entry.type}${entry.notes.length ? ' · ⚠ ' + entry.notes.join('；') : ''}`;
      item.iconPath = new vscode.ThemeIcon(entry.notes.length ? 'warning' : entry.kind === 'instance' ? 'symbol-class' : 'symbol-namespace');
      item.command = { command: 'rtlHierarchy.openInstance', title: '跳转实例位置', arguments: [node] };
      item.tooltip = [entry.name, entry.type, ...entry.parameters, ...entry.notes,
        entry.location ? `${entry.location.file}:${entry.location.line + 1}:${entry.location.column + 1}` : '',
        'slang 按已保存源码、当前宏和参数展开。',
        this.semanticStatus(this.snapshots.find(snapshot => snapshot.root === node.root)!)].filter(Boolean).join('\n');
    } else if (node.hierarchy) {
      const entry = node.hierarchy;
      item.contextValue = 'rtlModule';
      const type = entry.instance?.type ?? entry.module?.kind ?? '';
      item.description = `${type}${entry.notes.length ? ' · ⚠ ' + entry.notes.join('；') : ''}`;
      item.iconPath = new vscode.ThemeIcon(entry.notes.length ? 'warning' : entry.instance ? 'symbol-method' : 'symbol-class');
      item.command = { command: 'rtlHierarchy.openInstance', title: '跳转实例位置', arguments: [node] };
      const loc = entry.instance?.location ?? entry.module?.location;
      item.tooltip = [node.label, type, entry.instance?.parameters, ...entry.notes,
        loc ? `${loc.file}:${loc.line + 1}:${loc.column + 1}` : '', '静态语法层次；参数、generate 和预处理未展开。'].filter(Boolean).join('\n');
    } else if (node.issue || node.issueGroup) {
      item.iconPath = new vscode.ThemeIcon('warning');
      item.tooltip = node.label;
      if (node.issue?.location) { item.command = { command: 'rtlHierarchy.openInstance', title: '跳转提示位置', arguments: [node] }; }
    }
    return item;
  }

  private async open(location?: Location): Promise<void> {
    if (!location) { return; }
    try {
      const document = await vscode.workspace.openTextDocument(vscode.Uri.file(location.file));
      const range = new vscode.Range(location.line, location.column, location.endLine, location.endColumn);
      const editor = await vscode.window.showTextDocument(document, { preview: true, selection: range });
      editor.revealRange(range, vscode.TextEditorRevealType.InCenterIfOutsideViewport);
    } catch (error) {
      void vscode.window.showWarningMessage(`无法打开 ${location.file}: ${String(error)}`);
    }
  }

  private async openDefinition(node?: ViewNode): Promise<void> {
    if (node?.elaborated) {
      if (node.elaborated.definition) { await this.open(node.elaborated.definition); }
      else { void vscode.window.showInformationMessage('此节点没有可导航的模块定义。'); }
      return;
    }
    const entry = node?.hierarchy;
    if (!entry) { return; }
    if (entry.module) { await this.open(entry.module.location); return; }
    if (!entry.candidates.length) {
      void vscode.window.showInformationMessage('未找到模块定义，请检查 .f 或外部 IP 源文件。');
      return;
    }
    const picked = await vscode.window.showQuickPick(entry.candidates.map(mod => ({ label: mod.name, description: mod.location.file, mod })),
      { placeHolder: '存在重名模块，请选择要查看的定义（不会改变绑定）' });
    if (picked) { await this.open(picked.mod.location); }
  }

  private async chooseProject(): Promise<ProjectSnapshot | undefined> {
    await this.refresh();
    if (this.snapshots.length === 1) { return this.snapshots[0]; }
    const picked = await vscode.window.showQuickPick(this.snapshots.map(project => ({ label: path.basename(project.root), description: project.root, project })), { placeHolder: '选择工程' });
    return picked?.project;
  }

  private async selectTop(): Promise<void> {
    const project = await this.chooseProject();
    if (!project) { return; }
    const items = [{ label: '自动发现 / 使用 topModule 设置', description: '', id: '' },
      ...project.modules.map(mod => ({ label: mod.name, description: path.relative(project.root, mod.location.file), id: project.elaboration ? mod.name : mod.id }))];
    const picked = await vscode.window.showQuickPick(items, { placeHolder: '选择顶层模块', matchOnDescription: true });
    if (!picked) { return; }
    this.selections[project.root] = picked.id;
    await this.context.workspaceState.update('selectedTops', this.selections);
    if (project.elaboration) { await this.refresh(); } else { this.emitter.fire(undefined); }
  }

  private async selectMode(): Promise<void> {
    const project = await this.chooseProject();
    if (!project) { return; }
    const picked = await vscode.window.showQuickPick([
      { label: '精确活动层次', description: 'Windows x64 · slang · 保存后计算宏、参数和 generate', mode: 'elaborated' },
      { label: '静态语法层次', description: '实时显示未保存文本 · 不计算活动分支', mode: 'static' },
    ], { placeHolder: '选择当前工程的解析模式' });
    if (picked) {
      const selection = this.selected(project.root);
      this.selections[project.root] = project.modules.find(mod => mod.id === selection)?.name ?? selection ?? '';
      await this.context.workspaceState.update('selectedTops', this.selections);
      await vscode.workspace.getConfiguration('rtlHierarchy', vscode.Uri.file(project.root))
        .update('analysisMode', picked.mode, vscode.ConfigurationTarget.WorkspaceFolder);
    }
  }

  private async selectFileList(): Promise<void> {
    const project = await this.chooseProject();
    if (!project) { return; }
    await this.selectFileListFor(project);
  }

  private async selectFileListFor(project: ProjectSnapshot): Promise<void> {
    const picked = await vscode.window.showOpenDialog({ canSelectMany: true, filters: { 'RTL 文件列表': ['f', 'fl', 'lst'], '所有文件': ['*'] }, defaultUri: vscode.Uri.file(project.root), openLabel: '作为索引范围' });
    if (!picked?.length) { return; }
    await vscode.workspace.getConfiguration('rtlHierarchy', vscode.Uri.file(project.root)).update('fileLists',
      picked.map(uri => path.relative(project.root, uri.fsPath).replace(/\\/g, '/')), vscode.ConfigurationTarget.WorkspaceFolder);
  }

  private async manageScope(): Promise<void> {
    const project = await this.chooseProject();
    if (!project) { return; }
    const choice = await vscode.window.showQuickPick([
      { label: '选择工程文件列表', detail: '选择 .f/.fl/.lst，只索引列表中的源文件。', action: 'list' },
      { label: '切换到目录扫描', detail: '清空该工程的 fileLists，使用 include/exclude 规则。', action: 'scan' },
      { label: '设置扫描范围和列表路径规则', detail: '调整 include、exclude、fileListBase 及文件上限。', action: 'settings' },
    ], { placeHolder: `管理 ${path.basename(project.root)} 的索引范围` });
    if (choice?.action === 'list') { await this.selectFileListFor(project); }
    else if (choice?.action === 'scan') {
      await vscode.workspace.getConfiguration('rtlHierarchy', vscode.Uri.file(project.root))
        .update('fileLists', [], vscode.ConfigurationTarget.WorkspaceFolder);
    } else if (choice?.action === 'settings') {
      await vscode.commands.executeCommand('workbench.action.openSettings', '@ext:liaoweipeng1.rtl-hierarchy-explorer');
    }
  }

  getSnapshots(): ProjectSnapshot[] { return this.snapshots; }

  dispose(): void {
    this.disposed = true;
    if (this.timer) { clearTimeout(this.timer); }
    this.externalWatchers.forEach(watcher => watcher.dispose());
    this.nativeExternalWatchers.forEach(entry => entry.watcher.close());
    this.worker?.dispose();
  }
}

export function activate(context: vscode.ExtensionContext): Explorer {
  return new Explorer(context);
}
