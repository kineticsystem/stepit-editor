// An index over all the behavior files of a folder: which trees exist and
// where, and which node types are known. BehaviorTree.CPP applications
// typically register every file of the folder in the same factory, so trees in
// one file can use trees and node models of any other.

import { BUILTIN_MODELS } from './builtins';
import { flatten } from './treeOps';
import { type BehaviorTreeDef, type BTDocument, type BTNode, isNodeTypeCategory, type NodeCategory, type NodeModel, type ParsedFile } from './types';
import { models as docModels, trees as docTrees } from './xml';

export interface TreeRef {
  file: string;
  tree: BehaviorTreeDef;
}

export interface Workspace {
  files: ParsedFile[];
  builtins: Map<string, NodeModel>;
  /** Custom node models by ID; the first declaration wins. */
  models: Map<string, NodeModel>;
  /** Every declaration of each custom model, to detect conflicts. */
  modelDeclarations: Map<string, NodeModel[]>;
  /** SubTree models (<SubTree ID="..."> in TreeNodesModel) describe a tree's ports. */
  subtreeModels: Map<string, NodeModel>;
  /** Trees by ID; more than one entry is a duplicate. */
  trees: Map<string, TreeRef[]>;
}

export function buildWorkspace(files: ParsedFile[], builtins: NodeModel[] = BUILTIN_MODELS): Workspace {
  const ws: Workspace = {
    files,
    builtins: new Map(builtins.map((m) => [m.id, m])),
    models: new Map(),
    modelDeclarations: new Map(),
    subtreeModels: new Map(),
    trees: new Map(),
  };
  for (const f of files) {
    if (!f.doc) continue;
    for (const m of docModels(f.doc)) {
      const declared = { ...m, file: f.path };
      if (m.category === 'SubTree') {
        if (!ws.subtreeModels.has(m.id)) ws.subtreeModels.set(m.id, declared);
        continue;
      }
      const list = ws.modelDeclarations.get(m.id) ?? [];
      list.push(declared);
      ws.modelDeclarations.set(m.id, list);
      if (!ws.models.has(m.id)) ws.models.set(m.id, declared);
    }
    for (const t of docTrees(f.doc)) {
      const list = ws.trees.get(t.id) ?? [];
      list.push({ file: f.path, tree: t });
      ws.trees.set(t.id, list);
    }
  }
  return ws;
}

export function modelOf(ws: Workspace, id: string): NodeModel | undefined {
  return ws.builtins.get(id) ?? ws.models.get(id);
}

export function categoryOf(ws: Workspace, node: BTNode): NodeCategory | undefined {
  const model = modelOf(ws, node.id);
  if (model) return model.category;
  // An undeclared node written in the explicit form still tells its category.
  if (node.tag !== node.id && isNodeTypeCategory(node.tag)) return node.tag;
  return undefined;
}

export function findTree(ws: Workspace, id: string): TreeRef | undefined {
  return ws.trees.get(id)?.[0];
}

/** The trees referenced by SubTree nodes below `nodes`. */
export function subtreeRefs(nodes: BTNode[]): BTNode[] {
  return flatten(nodes).filter((n) => n.id === 'SubTree');
}

/** Which trees contain a SubTree node pointing at `treeId`. */
export function referencesTo(ws: Workspace, treeId: string): TreeRef[] {
  const out: TreeRef[] = [];
  for (const refs of ws.trees.values()) {
    for (const ref of refs) {
      if (subtreeRefs(ref.tree.children).some((n) => n.attrs.ID === treeId)) out.push(ref);
    }
  }
  return out;
}

/** The nodes of type `id` in each tree that uses it. */
export function usagesOf(ws: Workspace, id: string): { ref: TreeRef; nodes: BTNode[] }[] {
  const out: { ref: TreeRef; nodes: BTNode[] }[] = [];
  for (const refs of ws.trees.values()) {
    for (const ref of refs) {
      const nodes = flatten(ref.tree.children).filter((n) => n.id === id);
      if (nodes.length) out.push({ ref, nodes });
    }
  }
  return out;
}

/** Custom node types (not built in, not SubTree interfaces), sorted by ID. */
export function customModels(ws: Workspace): NodeModel[] {
  return [...ws.models.values()].sort((a, b) => a.id.localeCompare(b.id));
}

/** How many nodes of type `id` the workspace has, in all trees. */
/**
 * Whether a tree is an objective, one that runs on its own: the main tree of
 * its file (main_tree_to_execute). Any other tree is a subtree, which only runs
 * when another tree includes it with a SubTree node.
 */
export function isObjective(doc: BTDocument | undefined, treeId: string): boolean {
  return !!treeId && doc?.rootAttrs.main_tree_to_execute === treeId;
}

/** How many SubTree nodes include the tree, across the workspace. */
export function subtreeCount(ws: Workspace, treeId: string): number {
  let count = 0;
  for (const refs of ws.trees.values()) {
    for (const ref of refs) count += subtreeRefs(ref.tree.children).filter((n) => n.attrs.ID === treeId).length;
  }
  return count;
}

export function usageCount(ws: Workspace, id: string): number {
  return usagesOf(ws, id).reduce((n, u) => n + u.nodes.length, 0);
}

export function allModels(ws: Workspace): NodeModel[] {
  return [...ws.builtins.values(), ...ws.models.values()];
}

/**
 * The file where new node types are declared: the one that already declares
 * the most, or `current` when none declares more than it.
 */
export function defaultModelsFile(files: ParsedFile[], current: string): string {
  const count = (f?: ParsedFile) => (f?.doc ? docModels(f.doc).filter((m) => m.category !== 'SubTree').length : 0);
  let best = current;
  let most = count(files.find((f) => f.path === current));
  for (const f of files) {
    const n = count(f);
    if (n > most) {
      best = f.path;
      most = n;
    }
  }
  return best;
}
