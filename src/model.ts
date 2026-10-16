// 2026/10/16 16:47:15 by liaoweipeng1
export interface Location {
  file: string;
  line: number;
  column: number;
  endLine: number;
  endColumn: number;
}

export interface Issue {
  message: string;
  location?: Location;
  severity: 'warning' | 'error';
}

export interface Instance {
  name: string;
  type: string;
  location: Location;
  scopes: string[];
  notes: string[];
  parameters: string;
}

export interface ModuleDefinition {
  id: string;
  name: string;
  kind: string;
  location: Location;
  instances: Instance[];
  notes: string[];
}

export interface ParsedFile {
  file: string;
  modules: ModuleDefinition[];
  issues: Issue[];
}

export interface ProjectConfig {
  root: string;
  fileLists: string[];
  fileListBase?: 'file' | 'workspace';
  include: string[];
  exclude: string[];
  maxFiles: number;
  maxFileBytes: number;
  analysisMode?: 'static' | 'elaborated';
  topModule?: string;
  includeDirectories?: string[];
  defines?: string[];
  parameters?: string[];
  singleUnit?: boolean;
  defaultTimescale?: string;
}

export interface CompilationOptions {
  includeDirectories: string[];
  defines: string[];
  parameters: string[];
  topModules: string[];
  libraryFiles: string[];
  singleUnit: boolean;
}

export interface ElaboratedNode {
  id: string;
  name: string;
  type: string;
  kind: 'instance' | 'generate' | 'array' | 'primitive' | 'unresolved';
  location?: Location;
  definition?: Location;
  parameters: string[];
  children: ElaboratedNode[];
  notes: string[];
}

export interface ElaborationResult {
  status: 'complete' | 'partial' | 'failed' | 'pending';
  roots: ElaboratedNode[];
  dependencies: string[];
  watchDirectories: string[];
  elapsedMs: number;
  cached: boolean;
}

export interface ProjectChanges {
  changedFiles: string[];
  rediscover: boolean;
}

export interface ProjectSnapshot {
  root: string;
  files: string[];
  listFiles: string[];
  excludedFiles: string[];
  modules: ModuleDefinition[];
  issues: Issue[];
  parsedCount: number;
  cachedCount: number;
  elapsedMs: number;
  readCount: number;
  statCount: number;
  bytesRead: number;
  discoveryCount: number;
  mode: 'fileList' | 'scan';
  compilation?: CompilationOptions;
  elaboration?: ElaborationResult;
}

export const defaultConfig: Omit<ProjectConfig, 'root'> = {
  fileLists: [],
  fileListBase: 'file',
  include: ['**/*.{v,sv}'],
  exclude: ['**/node_modules/**', '**/.git/**', '**/db/**', '**/incremental_db/**',
    '**/output_files/**', '**/build/**', '**/dist/**', '**/backup/**', '**/archive/**'],
  maxFiles: 5000,
  maxFileBytes: 8 * 1024 * 1024,
};
