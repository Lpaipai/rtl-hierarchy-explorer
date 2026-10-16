// 2026/10/16 16:47:15 by liaoweipeng1
import { Instance, ModuleDefinition } from './model';

export interface HierarchyNode {
  id: string;
  label: string;
  module?: ModuleDefinition;
  instance?: Instance;
  candidates: ModuleDefinition[];
  ancestors: string[];
  notes: string[];
  terminal: boolean;
}

export class Hierarchy {
  readonly byName = new Map<string, ModuleDefinition[]>();
  constructor(readonly modules: ModuleDefinition[]) {
    for (const mod of modules) {
      this.byName.set(mod.name, [...(this.byName.get(mod.name) ?? []), mod]);
    }
  }

  roots(selected?: string): HierarchyNode[] {
    if (selected) {
      return this.modules.filter(mod => mod.id === selected || mod.name === selected).map(mod => this.root(mod));
    }
    const referenced = new Set(this.modules.flatMap(mod => mod.instances.map(item => item.type)));
    const roots = this.modules.filter(mod => !referenced.has(mod.name));
    const visited = new Set<string>();
    const visit = (root: ModuleDefinition) => {
      const pending = [root];
      while (pending.length) {
        const mod = pending.pop()!;
        if (visited.has(mod.id)) { continue; }
        visited.add(mod.id);
        for (const instance of mod.instances) { pending.push(...(this.byName.get(instance.type) ?? [])); }
      }
    };
    roots.forEach(visit);
    for (const mod of this.modules) {
      if (!visited.has(mod.id)) { roots.push(mod); visit(mod); }
    }
    return roots.map(mod => this.root(mod));
  }

  private root(mod: ModuleDefinition): HierarchyNode {
    return { id: mod.id, label: mod.name, module: mod, candidates: [mod], ancestors: [],
      notes: [...mod.notes], terminal: false };
  }

  children(node: HierarchyNode): HierarchyNode[] {
    if (node.terminal) { return []; }
    if (!node.module) {
      return node.candidates.map(mod => ({ ...this.root(mod), id: `${node.id}/definition:${mod.id}`,
        ancestors: node.ancestors, notes: [...mod.notes, '重名定义候选，未自动绑定'],
        terminal: node.ancestors.includes(mod.id) }));
    }
    const ancestors = [...node.ancestors, node.module.id];
    const occurrence = new Map<string, number>();
    return node.module.instances.map(instance => {
      const candidates = this.byName.get(instance.type) ?? [];
      const mod = candidates.length === 1 ? candidates[0] : undefined;
      const label = [...instance.scopes, instance.name].join('.');
      const identity = `${label}:${instance.type}`;
      const ordinal = occurrence.get(identity) ?? 0;
      occurrence.set(identity, ordinal + 1);
      const notes = [...instance.notes];
      const recursive = !!mod && ancestors.includes(mod.id);
      if (!candidates.length) { notes.push('未找到定义 / 外部 IP'); }
      if (candidates.length > 1) { notes.push(`${candidates.length} 个重名定义，展开选择候选`); }
      if (recursive) { notes.push('递归引用，已停止展开'); }
      if (ancestors.length >= 128) { notes.push('达到显示深度上限'); }
      return { id: `${node.id}/${encodeURIComponent(identity)}:${ordinal}`, label, instance, module: mod,
        candidates, ancestors, notes, terminal: recursive || ancestors.length >= 128 };
    });
  }
}
