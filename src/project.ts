// 2026/10/16 16:47:15 by liaoweipeng1
import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import picomatch from 'picomatch';
import { CompilationOptions, Issue, ParsedFile, ProjectChanges, ProjectConfig, ProjectSnapshot } from './model';
import { RtlParser } from './parser';

export function tokenizeFileList(source: string): string[] {
  const tokens: string[] = [];
  let value = '';
  let quote = '';
  for (let i = 0; i < source.length; i++) {
    const ch = source[i];
    if (quote) {
      if (ch === quote) { quote = ''; } else { value += ch; }
    } else if (ch === '"' || (ch === "'" && !value)) {
      quote = ch;
    } else if (ch === '/' && source[i + 1] === '*') {
      const end = source.indexOf('*/', i + 2);
      if (end < 0) { throw new Error('文件列表中的块注释未闭合'); }
      if (value) { tokens.push(value); value = ''; }
      i = end + 1;
    } else if (!value && ((ch === '/' && source[i + 1] === '/') || ch === '#')) {
      const end = source.indexOf('\n', i);
      i = end < 0 ? source.length : end;
    } else if (/\s/.test(ch)) {
      if (value) { tokens.push(value); value = ''; }
    } else {
      value += ch;
    }
  }
  if (quote) { throw new Error('文件列表中的引号未闭合'); }
  if (value) { tokens.push(value); }
  return tokens;
}

export interface SourceDiscovery {
  files: string[];
  listFiles: string[];
  excludedFiles: string[];
  issues: Issue[];
  compilation: CompilationOptions;
}

export function fileKey(file: string): string {
  const absolute = path.resolve(file);
  return process.platform === 'win32' ? absolute.toLowerCase() : absolute;
}

export async function discover(config: ProjectConfig): Promise<SourceDiscovery> {
  const files = new Set<string>();
  const listFiles = new Set<string>();
  const excludedFiles = new Set<string>();
  const issues: Issue[] = [];
  const exact = config.analysisMode === 'elaborated';
  const compilation: CompilationOptions = {
    includeDirectories: [], defines: [], parameters: [], topModules: [], libraryFiles: [], singleUnit: false,
  };
  const matchExclude = picomatch(config.exclude, { dot: true, nocase: process.platform === 'win32' });
  const matchInclude = picomatch(config.include, { dot: true, nocase: process.platform === 'win32' });
  const normalize = (file: string) => path.relative(config.root, file).replace(/\\/g, '/');
  const excluded = (file: string) => matchExclude(normalize(file));
  let capped = false;
  const warn = (message: string) => { if (issues.length < 200) { issues.push({ severity: exact ? 'error' : 'warning', message }); } };
  const add = async (file: string) => {
    if (excluded(file)) { excludedFiles.add(file); return; }
    file = await fs.realpath(file).catch(() => path.resolve(file));
    if (excluded(file)) { excludedFiles.add(file); return; }
    if (files.has(file)) { return; }
    if (files.size >= config.maxFiles) {
      if (!capped) { warn(`达到 ${config.maxFiles} 个文件上限，索引不完整；请缩小范围或提高 maxFiles。`); }
      capped = true;
      return;
    }
    files.add(file);
  };
  const active = new Set<string>();
  async function readList(file: string): Promise<void> {
    file = await fs.realpath(file).catch(() => path.resolve(file));
    if (active.has(file)) { warn(`文件列表循环引用：${file}`); return; }
    if (listFiles.has(file)) { return; }
    if (active.size >= 64 || listFiles.size >= 1000) { warn(`文件列表嵌套/数量超过限制：${file}`); return; }
    listFiles.add(file);
    active.add(file);
    try {
      if ((await fs.stat(file)).size > 1024 * 1024) { throw new Error('文件列表超过 1 MiB'); }
      const tokens = tokenizeFileList(new TextDecoder('utf-8', { fatal: true }).decode(await fs.readFile(file)));
      const base = config.fileListBase === 'workspace' ? config.root : path.dirname(file);
      for (let i = 0; i < tokens.length; i++) {
        const token = tokens[i];
        if (token === '-f' || token === '-F') {
          const nested = tokens[++i];
          if (!nested) { warn(`${file}: ${token} 缺少路径`); break; }
          await readList(path.resolve(base, nested));
        } else if (token === '-v') {
          const source = tokens[++i];
          if (source) {
            const absolute = path.resolve(base, source);
            await add(absolute);
            compilation.libraryFiles.push(await fs.realpath(absolute).catch(() => absolute));
          }
          else { warn(`${file}: -v 缺少路径`); }
        } else if (token.startsWith('+incdir+') || token.startsWith('+define+')) {
          const values = token.slice(token.indexOf('+', 1) + 1).split('+');
          if (values.some(value => !value)) { warn(`${file}: ${token} 包含空值`); }
          if (token.startsWith('+incdir+')) {
            compilation.includeDirectories.push(...values.filter(Boolean).map(value => path.resolve(base, value)));
          } else { compilation.defines.push(...values.filter(Boolean)); }
          if (!exact) { warn(`${file}: 已读取 ${token}；静态模式不展开 include/宏，也不按宏筛选分支。`); }
        } else if (['-I', '-D', '-G', '-top', '--top'].includes(token) || /^-[IDG].+/.test(token)) {
          const flag = /^-[IDG]/.test(token) ? token.slice(0, 2) : token;
          const value = token.length > 2 && /^-[IDG]/.test(token) ? token.slice(2) : tokens[++i];
          if (!value) { warn(`${file}: ${token} 缺少值`); continue; }
          if (flag === '-I') { compilation.includeDirectories.push(path.resolve(base, value)); }
          else if (flag === '-D') { compilation.defines.push(value); }
          else if (flag === '-G') { compilation.parameters.push(value); }
          else { compilation.topModules.push(value); }
          if (!exact) { warn(`${file}: 静态模式不应用 ${token}`); }
        } else if (token === '--single-unit') {
          compilation.singleUnit = true;
          if (!exact) { warn(`${file}: 静态模式不应用 --single-unit`); }
        } else if (token.startsWith('-') || token.startsWith('+')) {
          warn(`${file}: 不支持选项 ${token}，请使用显式源文件列表。`);
          if (['-y', '-I', '-D', '-top', '--top'].includes(token)) { i++; }
        } else if (token.includes('$')) {
          warn(`${file}: 不展开环境变量路径 ${token}`);
        } else if (/\.(v|sv|vh|svh)$/i.test(token)) {
          await add(path.resolve(base, token));
        } else {
          warn(`${file}: 无法识别列表项 ${token}`);
        }
      }
    } catch (error) {
      issues.push({ severity: 'error', message: `无法读取文件列表 ${file}: ${String(error)}` });
    } finally { active.delete(file); }
  }
  async function scan(directory: string): Promise<void> {
    let entries;
    try { entries = await fs.readdir(directory, { withFileTypes: true }); }
    catch (error) { warn(`无法扫描 ${directory}: ${String(error)}`); return; }
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      const file = path.join(directory, entry.name);
      if (entry.isSymbolicLink()) { continue; }
      if (excluded(file) || (entry.isDirectory() && excluded(path.join(file, '__scope_probe__')))) {
        if (excludedFiles.size < 1000) { excludedFiles.add(file); }
        continue;
      }
      if (entry.isDirectory()) { await scan(file); }
      else if (entry.isFile() && matchInclude(normalize(file))) { await add(file); }
      if (capped) { break; }
    }
  }
  if (config.fileLists.length) {
    for (const item of config.fileLists) { await readList(path.resolve(config.root, item)); }
  } else {
    await scan(config.root);
  }
  compilation.includeDirectories.push(...(config.includeDirectories ?? []).map(dir => path.resolve(config.root, dir)));
  compilation.defines.push(...(config.defines ?? []));
  compilation.parameters.push(...(config.parameters ?? []));
  if (config.topModule) { compilation.topModules = [config.topModule]; }
  compilation.singleUnit ||= !!config.singleUnit;
  return { files: exact ? [...files] : [...files].sort(), listFiles: [...listFiles],
    excludedFiles: [...excludedFiles].sort(), issues, compilation };
}

interface CachedFile {
  hash?: string;
  signature?: string;
  overlay?: string;
  result: ParsedFile;
}

export class ProjectIndexer {
  private readonly cache = new Map<string, CachedFile>();
  private discovery?: SourceDiscovery;
  private configSignature = '';
  constructor(private readonly parser: RtlParser) {}

  async update(config: ProjectConfig, overlays: Record<string, string> = {}, force = false,
    changes?: ProjectChanges): Promise<ProjectSnapshot> {
    const start = performance.now();
    if (force) { this.cache.clear(); }
    const signature = JSON.stringify(config);
    const configChanged = signature !== this.configSignature;
    const dirty = new Set((changes?.changedFiles ?? []).map(fileKey));
    const listChanged = this.discovery?.listFiles.some(file => dirty.has(fileKey(file)));
    const rediscover = !this.discovery || configChanged || force || !changes || changes.rediscover || listChanged;
    if (rediscover) { this.discovery = await discover(config); }
    this.configSignature = signature;
    const discovered = this.discovery!;
    const snapshot: ProjectSnapshot = { root: config.root, ...discovered, issues: [...discovered.issues], modules: [],
      parsedCount: 0, cachedCount: 0, elapsedMs: 0, readCount: 0, statCount: 0, bytesRead: 0,
      discoveryCount: rediscover ? 1 : 0, mode: config.fileLists.length ? 'fileList' : 'scan' };
    const active = new Set(discovered.files);
    const activeKeys = new Set(discovered.files.map(fileKey));
    for (const key of this.cache.keys()) { if (!active.has(key)) { this.cache.delete(key); } }
    const canonicalOverlays = new Map<string, string>();
    for (const [file, text] of Object.entries(overlays)) {
      const key = fileKey(file);
      if (activeKeys.has(key)) {
        canonicalOverlays.set(key, text);
      }
    }
    for (const file of discovered.files) {
      const cached = this.cache.get(file);
      const overlay = canonicalOverlays.get(fileKey(file));
      const overlayChanged = overlay !== cached?.overlay;
      const touched = force || configChanged || dirty.has(fileKey(file)) || overlayChanged;
      let result: ParsedFile;
      try {
        if (cached && changes && !touched && !rediscover) {
          snapshot.cachedCount++;
          snapshot.modules.push(...cached.result.modules);
          snapshot.issues.push(...cached.result.issues);
          continue;
        }
        snapshot.statCount++;
        const stat = await fs.stat(file);
        const size = overlay === undefined ? stat.size : Buffer.byteLength(overlay, 'utf8');
        if (size > config.maxFileBytes) { throw new Error(`超过 maxFileBytes (${config.maxFileBytes})，未索引`); }
        const metadata = `${stat.size}:${stat.mtimeMs}:${stat.ctimeMs}:${stat.ino}`;
        if (cached?.hash && !touched && cached.signature === metadata) {
          result = cached.result;
          snapshot.cachedCount++;
        } else {
          let source = overlay;
          if (source === undefined) {
            snapshot.readCount++;
            const buffer = await fs.readFile(file);
            snapshot.bytesRead += buffer.length;
            if (buffer.length > config.maxFileBytes) { throw new Error(`读取期间文件超过 maxFileBytes (${config.maxFileBytes})`); }
            source = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(buffer);
          }
          const hash = createHash('sha256').update(source).digest('hex');
          if (cached?.hash === hash) {
            result = cached.result;
            snapshot.cachedCount++;
          } else {
            result = this.parser.parse(file, source);
            snapshot.parsedCount++;
          }
          this.cache.set(file, { hash, signature: metadata, overlay, result });
        }
      } catch (error) {
        result = { file, modules: [], issues: [{ severity: 'error', message: `无法索引 ${file}: ${String(error)}` }] };
        this.cache.set(file, { overlay, result });
      }
      snapshot.modules.push(...result.modules);
      snapshot.issues.push(...result.issues);
    }
    const names = new Map<string, typeof snapshot.modules>();
    for (const mod of snapshot.modules) {
      const matches = names.get(mod.name) ?? [];
      matches.push(mod);
      names.set(mod.name, matches);
    }
    for (const [name, matches] of names) {
      if (matches.length < 2) { continue; }
      for (const mod of matches) {
        snapshot.issues.push({ severity: 'warning', location: mod.location,
          message: `模块 ${name} 有 ${matches.length} 个定义；不会自动选取其中一个，请收窄文件列表。` });
      }
    }
    snapshot.elapsedMs = Math.round(performance.now() - start);
    return snapshot;
  }
}
