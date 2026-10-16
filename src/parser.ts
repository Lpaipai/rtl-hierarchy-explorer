// 2026/10/16 16:47:15 by liaoweipeng1
import path from 'node:path';
import { Language, Parser, Node } from 'web-tree-sitter';
import { Instance, Location, ModuleDefinition, ParsedFile } from './model';

const declarations = new Set(['module_declaration', 'interface_declaration', 'program_declaration']);
const instantiations = new Set(['module_instantiation', 'interface_instantiation', 'program_instantiation']);
const conditionalGenerate = new Set(['if_generate_construct', 'case_generate_construct']);

function location(file: string, node: Node): Location {
  return { file, line: node.startPosition.row, column: node.startPosition.column,
    endLine: node.endPosition.row, endColumn: node.endPosition.column };
}

function compact(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

function children(node: Node): Node[] {
  return node.namedChildren.filter((child): child is Node => child !== null);
}

function walk(node: Node, visit: (node: Node) => boolean | void): void {
  const pending = [node];
  while (pending.length) {
    const current = pending.pop()!;
    if (visit(current) !== false) { pending.push(...children(current).reverse()); }
  }
}

function definitionName(node: Node): Node | null {
  const direct = node.childForFieldName('name');
  if (direct) { return direct; }
  for (const child of children(node)) {
    if (child.type.endsWith('_header')) {
      return child.childForFieldName('name');
    }
  }
  return null;
}

export class RtlParser {
  private constructor(private readonly parser: Parser) {}

  static async create(assetDirectory: string): Promise<RtlParser> {
    await Parser.init({ locateFile: () => path.join(assetDirectory, 'tree-sitter.wasm') });
    const language = await Language.load(path.join(assetDirectory, 'tree-sitter-systemverilog.wasm'));
    const parser = new Parser();
    parser.setLanguage(language);
    return new RtlParser(parser);
  }

  parse(file: string, source: string): ParsedFile {
    // VS Code removes the encoding marker from the visible document.
    if (source.startsWith('\uFEFF')) { source = source.slice(1); }
    const result: ParsedFile = { file, modules: [], issues: [] };
    const start = performance.now();
    const tree = this.parser.parse(source, undefined, {
      progressCallback: ({ currentOffset }) => currentOffset >= 0 && performance.now() - start > 3000,
    });
    function note(message: string, node: Node): void {
      if (result.issues.length < 100) {
        result.issues.push({ message, location: location(file, node), severity: 'warning' });
      }
    }
    if (!tree) {
      this.parser.reset();
      return { ...result, issues: [{ severity: 'error', message: `${file}: 解析超过 3 秒或被中断，未索引此文件。` }] };
    }
    try {
      let preprocessor = false;
      walk(tree.rootNode, node => {
        if (node.type === 'ERROR' || node.isMissing) {
          note('语法恢复节点：此文件的层次可能不完整。', node);
          return false;
        }
        if (/conditional_compilation|text_macro|include_compiler|include_directive/.test(node.type)) {
          preprocessor = true;
        }
        if (node.type === 'bind_directive' || node.type === 'config_declaration') {
          note('bind/config 尚未解析绑定关系，请使用 elaborator 核实。', node);
        }
      });
      if (preprocessor) {
        note('含宏、include 或条件编译：未运行预处理器，显示可见语法，可能含非活动分支或缺少宏生成实例。', tree.rootNode);
      }
      walk(tree.rootNode, node => {
        if (!declarations.has(node.type)) { return; }
        const name = definitionName(node);
        if (!name) {
          note('无法提取声明名称。', node);
          return false;
        }
        const ordinal = result.modules.filter(item => item.name === name.text).length;
        const mod: ModuleDefinition = {
          id: `${file}::${name.text}::${ordinal}`,
          name: name.text,
          kind: node.type.replace('_declaration', ''),
          location: location(file, name),
          instances: [],
          notes: [],
        };
        if (preprocessor) { mod.notes.push('预处理未求值'); }
        if (node.hasError) { mod.notes.push('语法恢复，可能不完整'); }
        walk(node, child => {
          if (child.id !== node.id && declarations.has(child.type)) {
            note('嵌套声明尚不支持作用域绑定，未作为全局模块索引。', child);
            mod.notes.push('嵌套声明未绑定');
            return false;
          }
          if (!instantiations.has(child.type)) { return; }
          const type = child.childForFieldName('instance_type') ?? children(child)[0];
          if (!type) { return false; }
          const scopes: string[] = [];
          const notes: string[] = [];
          for (let parent = child.parent; parent && parent.id !== node.id; parent = parent.parent) {
            if (parent.type === 'generate_block') {
              const blockName = parent.childForFieldName('name');
              if (blockName) { scopes.unshift(blockName.text); }
            }
            if (parent.type === 'loop_generate_construct') { notes.push('generate 循环未展开'); }
            if (conditionalGenerate.has(parent.type)) { notes.push('generate 条件未求值'); }
          }
          for (const hierarchical of children(child).filter(item => item.type === 'hierarchical_instance')) {
            const holder = children(hierarchical).find(item => item.type === 'name_of_instance');
            const instanceName = holder?.childForFieldName('instance_name');
            if (!holder || !instanceName) {
              note('实例名称无法提取，层次可能不完整。', hierarchical);
              continue;
            }
            const dimensions = children(holder).filter(item => item.type === 'unpacked_dimension');
            const instance: Instance = {
              name: instanceName.text + dimensions.map(item => compact(item.text)).join(''),
              type: type.text,
              location: location(file, instanceName),
              scopes,
              notes: [...new Set([...notes, ...mod.notes, ...(dimensions.length ? ['实例数组未展开'] : [])])],
              parameters: compact(children(child).find(item => item.type === 'parameter_value_assignment')?.text ?? ''),
            };
            mod.instances.push(instance);
          }
          return false;
        });
        result.modules.push(mod);
        return false;
      });
      return result;
    } finally {
      tree.delete();
    }
  }

  dispose(): void { this.parser.delete(); }
}
