// 2026/10/16 17:38:05 by liaoweipeng1
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { discover, fileKey, SourceDiscovery } from './project';
import { ElaboratedNode, Issue, Location, ModuleDefinition, ProjectChanges, ProjectConfig, ProjectSnapshot } from './model';
import runtimeManifest from '../vendor/slang-runtime-manifest.json';

// The backend and its JSON schema are pinned together. Never execute a workspace-supplied tool.
const maxJsonBytes = 256 * 1024 * 1024;
type SymbolJson = Record<string, any>;
export type ChildObserver = (pid: number, running: boolean) => void;

function quoteArgument(value: string): string {
  if (/[\r\n\0]/.test(value)) { throw new Error('编译选项不能包含换行或 NUL'); }
  return '"' + value.replace(/\\/g, '\\\\').replace(/"/g, '\\"') + '"';
}

function symbolName(link: string): string { return link.slice(link.indexOf(' ') + 1); }

function integer(value: string): number {
  if (/^-?\d+$/.test(value)) { return Number(value); }
  const match = /^(\d+)?'s?([dhob])([0-9a-f]+)$/i.exec(value);
  if (!match) { throw new Error(`无法读取已求值的下标 ${value}`); }
  return parseInt(match[3], { d: 10, h: 16, o: 8, b: 2 }[match[2].toLowerCase()]!);
}

export async function decodeDesign(document: SymbolJson, root: string): Promise<{
  roots: ElaboratedNode[]; modules: ModuleDefinition[]; issues: Issue[];
}> {
  if (document.design?.kind !== 'Root' || !Array.isArray(document.definitions)) {
    throw new Error('slang AST 格式不匹配，未把结果作为有效层次');
  }
  const symbols = new Map<string, SymbolJson>();
  const sources = new Set<string>();
  const pending = [document.design, ...document.definitions];
  while (pending.length) {
    const item = pending.pop()!;
    if (!item || typeof item !== 'object') { continue; }
    if (item.addr !== undefined) { symbols.set(String(item.addr), item); }
    if (item.source_file && !/^<.*>$/.test(item.source_file)) { sources.add(path.resolve(root, item.source_file)); }
    if (typeof item.body === 'object') { pending.push(item.body); }
    pending.push(...(item.members ?? []));
  }
  const lines = new Map<string, string[]>();
  for (const file of sources) {
    lines.set(fileKey(file), (await fs.readFile(file, 'utf8')).split(/\r?\n/));
  }
  const location = (item?: SymbolJson): Location | undefined => {
    if (!item?.source_file || !item.source_line || /^<.*>$/.test(item.source_file)) { return undefined; }
    const file = path.resolve(root, item.source_file);
    const line = item.source_line - 1;
    const text = lines.get(fileKey(file))?.[line] ?? '';
    const byteColumn = Math.max(0, (item.source_column ?? 1) - 1);
    const column = Math.max(0, Buffer.from(text, 'utf8').subarray(0, byteColumn).toString('utf8').length -
      (line === 0 && text.startsWith('\uFEFF') ? 1 : 0));
    return { file, line, column, endLine: line, endColumn: column };
  };
  const resolve = (item: SymbolJson | string | undefined): SymbolJson | undefined =>
    typeof item === 'string' ? symbols.get(item.split(' ', 1)[0]) : item;
  const issues: Issue[] = [];
  let count = 0;
  const convert = (item: SymbolJson, parent: string, givenName?: string, depth = 0): ElaboratedNode | undefined => {
    if (item.isUninstantiated) { return undefined; }
    if (!['Instance', 'InstanceArray', 'GenerateBlock', 'GenerateBlockArray', 'PrimitiveInstance', 'UninstantiatedDef'].includes(item.kind)) {
      return undefined;
    }
    if (++count > 100_000 || depth > 256) { throw new Error('活动层次超过 100000 节点或 256 层显示上限'); }
    const name = givenName ?? (item.name || `genblk${item.constructIndex ?? 0}`);
    const id = `${parent}/${encodeURIComponent(name)}`;
    const node: ElaboratedNode = { id, name, type: '', kind: 'generate', location: location(item),
      parameters: [], children: [], notes: [] };
    let children = item.members ?? [];
    if (item.kind === 'Instance') {
      const body = resolve(item.body);
      if (!body || body.kind !== 'InstanceBody') { throw new Error(`实例 ${id} 的缓存实体引用无效`); }
      node.kind = 'instance';
      node.type = body.name;
      node.definition = location(resolve(body.definition)) ?? location(body);
      node.parameters = (body.members ?? []).filter((member: SymbolJson) =>
        (member.kind === 'Parameter' || member.kind === 'TypeParameter') && !member.isLocal)
        .map((member: SymbolJson) => `${member.name} = ${member.value ?? member.targetType ?? member.type ?? '?'}`);
      children = body.members ?? [];
    } else if (item.kind === 'UninstantiatedDef') {
      node.kind = 'unresolved';
      node.type = item.definitionName;
      node.notes.push('未解析定义 / 外部 IP，内部层次未知');
      issues.push({ severity: 'error', location: node.location, message: `${id}: ${node.notes[0]} (${node.type})` });
    } else if (item.kind === 'PrimitiveInstance') {
      node.kind = 'primitive';
      node.type = symbolName(item.primitiveType ?? ' primitive');
      node.definition = location(resolve(item.primitiveType));
    } else if (item.kind === 'InstanceArray') {
      node.kind = 'array';
      node.type = item.range;
      const range = /^\[(-?\d+):(-?\d+)\]$/.exec(item.range ?? '');
      if (!range) { throw new Error(`实例数组 ${id} 缺少有效范围`); }
      // slang stores instance elements from the numeric lower bound, even for descending ranges.
      const lower = Math.min(Number(range[1]), Number(range[2]));
      node.children = children.map((child: SymbolJson, index: number) =>
        convert(child, id, `[${lower + index}]`, depth + 1)).filter(Boolean);
      return node;
    } else if (item.kind === 'GenerateBlockArray') {
      node.kind = 'array';
      node.type = 'generate for';
      const variable = symbolName(item.loopVariable ?? ' ');
      node.children = children.filter((child: SymbolJson) => child.kind === 'GenerateBlock')
        .map((child: SymbolJson) => {
          const parameter = child.members?.find((member: SymbolJson) => member.kind === 'Parameter' && member.name === variable);
          const index = child.arrayIndex ?? parameter?.value;
          if (index === undefined) { throw new Error(`generate ${id} 缺少循环下标`); }
          return convert(child, id, `[${integer(index)}]`, depth + 1);
        }).filter(Boolean);
      return node;
    } else {
      node.type = 'generate';
    }
    node.children = children.map((child: SymbolJson) => convert(child, id, undefined, depth + 1)).filter(Boolean);
    return node;
  };
  const roots = (document.design.members ?? []).filter((item: SymbolJson) => item.kind === 'Instance')
    .map((item: SymbolJson) => convert(item, 'elaborated')).filter(Boolean) as ElaboratedNode[];
  const modules = document.definitions.filter((item: SymbolJson) => location(item)).map((item: SymbolJson) => ({
    id: `definition:${item.source_file}:${item.name}`, name: item.name, kind: item.definitionKind?.toLowerCase() ?? 'module',
    location: location(item)!, instances: [], notes: [],
  }));
  return { roots, modules, issues };
}

async function readLimited(file: string, limit = maxJsonBytes): Promise<Buffer> {
  if ((await fs.stat(file)).size > limit) { throw new Error(`解析输出超过 ${limit / 1024 / 1024} MiB 上限`); }
  const buffer = await fs.readFile(file);
  if (buffer.length > limit) { throw new Error('读取期间解析输出超过上限'); }
  return buffer;
}

export class SlangProject {
  private discovery?: SourceDiscovery;
  private signature = '';
  private cached?: ProjectSnapshot;
  private verified = false;

  constructor(private readonly assetDirectory: string, private readonly observeChild?: ChildObserver,
    private readonly timeoutMs = 30_000) {}

  async update(config: ProjectConfig, dirtyFiles: string[] = [], force = false,
    changes?: ProjectChanges): Promise<ProjectSnapshot> {
    const start = performance.now();
    const signature = JSON.stringify(config);
    const dirty = new Set((changes?.changedFiles ?? []).map(fileKey));
    const rediscover = !this.discovery || signature !== this.signature || force || !changes || changes.rediscover ||
      this.discovery.listFiles.some(file => dirty.has(fileKey(file)));
    if (rediscover) { this.discovery = await discover({ ...config, analysisMode: 'elaborated' }); }
    this.signature = signature;
    const discovered = this.discovery!;
    const dependencies = this.cached?.elaboration?.dependencies ?? [];
    const watchDirectories = [...new Set([...discovered.compilation.includeDirectories, ...discovered.files.map(file => path.dirname(file))])];
    const relevant = (file: string) => [...discovered.files, ...discovered.listFiles, ...dependencies].some(known => fileKey(known) === fileKey(file)) ||
      (/\.(v|sv|vh|svh)$/i.test(file) && [config.root, ...watchDirectories].some(dir => fileKey(file).startsWith(fileKey(dir) + path.sep)));
    const unsaved = dirtyFiles.filter(relevant);
    const snapshot: ProjectSnapshot = { root: config.root, ...discovered, issues: [...discovered.issues], modules: [],
      parsedCount: 0, cachedCount: 0, elapsedMs: 0, readCount: 0, statCount: 0, bytesRead: 0,
      discoveryCount: rediscover ? 1 : 0, mode: config.fileLists.length ? 'fileList' : 'scan',
      elaboration: { status: 'failed', roots: [], dependencies, watchDirectories, elapsedMs: 0, cached: false } };
    const finish = () => {
      snapshot.elapsedMs = Math.round(performance.now() - start);
      snapshot.elaboration!.elapsedMs = snapshot.elapsedMs;
      return snapshot;
    };
    if (unsaved.length) {
      snapshot.elaboration!.status = 'pending';
      snapshot.modules = this.cached?.modules ?? [];
      snapshot.issues.push({ severity: 'warning', message: `精确层次等待保存：${unsaved.map(file => path.relative(config.root, file)).join('、')}。保存后自动展开；实时查看编辑文本可切换到静态模式。` });
      return finish();
    }
    if (!rediscover && this.cached && !changes?.changedFiles.some(relevant)) {
      return { ...this.cached, elapsedMs: 0, discoveryCount: 0, parsedCount: 0, readCount: 0, statCount: 0,
        bytesRead: 0, cachedCount: this.cached.files.length,
        elaboration: { ...this.cached.elaboration!, cached: true, elapsedMs: 0 } };
    }
    if (!discovered.files.length || discovered.issues.some(issue => issue.severity === 'error')) {
      snapshot.issues.push({ severity: 'error', message: '工程输入不完整，未运行精确展开。请修复文件列表或索引范围。' });
      return finish();
    }
    let temporary: string | undefined;
    try {
      if (process.platform !== 'win32' || process.arch !== 'x64') {
        throw new Error('包内精确后端仅支持 Windows x64；此平台请切换静态模式');
      }
      const runtime = path.join(this.assetDirectory, 'slang-runtime');
      const executable = path.join(runtime, 'rtl-python.exe');
      if (!this.verified) {
        try {
          for (const [file, expected] of Object.entries(runtimeManifest)) {
            const digest = createHash('sha256').update(await fs.readFile(path.join(runtime, file))).digest('hex');
            if (digest !== expected) { throw new Error(file); }
          }
        } catch (error) { throw new Error(`slang 运行时校验失败，请重新安装完整扩展：${String(error)}`); }
        this.verified = true;
      }
      // Validate the configured translation units before handing them to the compiler.
      for (const file of discovered.files) {
        const stat = await fs.stat(file);
        snapshot.statCount++;
        if (stat.size > config.maxFileBytes) { throw new Error(`${file} 超过 maxFileBytes`); }
      }
      temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'rtl-hierarchy-'));
      const astFile = path.join(temporary, 'design.json');
      const diagFile = path.join(temporary, 'diagnostics.json');
      const depsFile = path.join(temporary, 'dependencies.f');
      const args = ['--std=1800-2017',
        '--error-limit=100', '--max-hierarchy-depth=128', '--max-generate-steps=16384',
        '--max-instance-array=16384', '--max-include-depth=128', '-Werror=duplicate-definition'];
      const options = discovered.compilation;
      if (options.singleUnit) { args.push('--single-unit'); }
      if (config.defaultTimescale) { args.push('--timescale', config.defaultTimescale); }
      for (const dir of options.includeDirectories) { args.push('-I', dir); }
      const lastValues = (values: string[]) => [...new Map(values.map(value => [value.split('=', 1)[0], value])).values()];
      for (const define of lastValues(options.defines)) { args.push('-D', define); }
      for (const parameter of lastValues(options.parameters)) {
        if (!parameter.includes('=')) { throw new Error(`参数必须使用 NAME=VALUE：${parameter}`); }
        args.push('-G', parameter);
      }
      for (const top of options.topModules) { args.push('--top', top); }
      const libraries = new Set(options.libraryFiles.map(fileKey));
      for (const file of discovered.files) {
        if (libraries.has(fileKey(file))) { args.push('-v', file); }
        else { args.push(file); }
      }
      const commandFile = path.join(temporary, 'arguments.f');
      await fs.writeFile(commandFile, args.map(quoteArgument).join('\n'), 'utf8');
      const result = await this.execute(executable, commandFile, config.root, temporary, astFile);
      if (!(await fs.stat(diagFile).catch(() => undefined))) {
        throw new Error(`解析器未生成诊断，退出码 ${result.code}：${result.output}`);
      }
      const rawDiagnostics = JSON.parse((await readLimited(diagFile, 8 * 1024 * 1024)).toString('utf8'));
      if (!Array.isArray(rawDiagnostics)) { throw new Error('slang 诊断格式无效'); }
      for (const diagnostic of rawDiagnostics) {
        if (diagnostic.severity === 'note') { continue; }
        const location = diagnostic.source_file && diagnostic.source_line ? {
          file: path.resolve(config.root, diagnostic.source_file), line: diagnostic.source_line - 1,
          column: diagnostic.utf16_column ?? 0, endLine: diagnostic.source_line - 1, endColumn: diagnostic.utf16_column ?? 0,
        } : undefined;
        snapshot.issues.push({ severity: diagnostic.severity === 'error' || diagnostic.severity === 'fatal' ? 'error' : 'warning', location,
          message: `[slang ${diagnostic.code}] ${diagnostic.location ?? ''}: ${diagnostic.message}` });
      }
      const depText = (await readLimited(depsFile, 8 * 1024 * 1024)).toString('utf8');
      snapshot.elaboration!.dependencies = [...new Set(depText.split(/\r?\n/).filter(file => file && !/^<.*>$/.test(file)).map(file => path.resolve(config.root, file)))];
      const design = await decodeDesign(JSON.parse((await readLimited(astFile)).toString('utf8')), config.root);
      snapshot.modules = design.modules;
      snapshot.elaboration!.roots = design.roots;
      snapshot.issues.push(...design.issues);
      const failed = result.code !== 0 || snapshot.issues.some(issue => issue.severity === 'error');
      snapshot.elaboration!.status = failed ? (design.roots.length ? 'partial' : 'failed') : 'complete';
      if (!design.roots.length) {
        snapshot.elaboration!.status = 'failed';
        snapshot.issues.push({ severity: 'error', message: '未生成活动顶层，请选择有效 topModule。' });
      }
      if (failed && !snapshot.issues.some(issue => issue.severity === 'error')) {
        snapshot.issues.push({ severity: 'error', message: `slang 返回 ${result.code}: ${result.output}` });
      }
      snapshot.parsedCount = discovered.files.length;
      // Native compiler I/O is not measured by the static indexer's counters.
      this.cached = finish();
      return this.cached;
    } catch (error) {
      snapshot.elaboration!.status = 'failed';
      snapshot.elaboration!.roots = [];
      snapshot.issues.push({ severity: 'error', message: `精确展开失败：${String(error)}` });
      this.cached = undefined;
      return finish();
    } finally {
      if (temporary) { await fs.rm(temporary, { recursive: true, force: true }).catch(() => undefined); }
    }
  }

  private execute(executable: string, commandFile: string, cwd: string, temporary: string,
    astFile: string): Promise<{ code: number | null; output: string }> {
    return new Promise((resolve, reject) => {
      const child = spawn(executable, ['-I', '-B', '-S', '-X', 'utf8', path.join(path.dirname(executable), 'slang_bridge.py'), commandFile, temporary], { cwd, windowsHide: true, shell: false,
        env: { ...process.env, TEMP: temporary, TMP: temporary }, stdio: ['ignore', 'pipe', 'pipe'] });
      let output = '';
      let failure: Error | undefined;
      const abort = (message: string) => { failure ??= new Error(message); child.kill('SIGKILL'); };
      const receive = (chunk: Buffer) => {
        if (output.length + chunk.length > 2 * 1024 * 1024) { abort('slang 控制台输出超过上限'); }
        else { output += chunk.toString('utf8'); }
      };
      child.stdout.on('data', receive);
      child.stderr.on('data', receive);
      child.on('spawn', () => { if (child.pid) { this.observeChild?.(child.pid, true); } });
      const timeout = setTimeout(() => abort(`slang 超过 ${this.timeoutMs / 1000} 秒，已结束解析进程`), this.timeoutMs);
      const sizeGuard = setInterval(() => {
        void fs.stat(astFile).then(stat => {
          if (stat.size > maxJsonBytes) { abort('slang AST 超过 256 MiB，已结束解析进程'); }
        }).catch(() => undefined);
      }, 100);
      child.on('error', error => { failure = error; });
      child.on('close', code => {
        clearTimeout(timeout);
        clearInterval(sizeGuard);
        if (child.pid) { this.observeChild?.(child.pid, false); }
        if (failure) { reject(failure); } else { resolve({ code, output }); }
      });
    });
  }
}
