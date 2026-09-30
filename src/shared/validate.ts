// Static checks of behavior files, mirroring what BehaviorTree.CPP 4 checks
// when it loads a tree, plus a few that it only reports at runtime (missing
// input ports, badly typed literals). The editor runs these on every change;
// the native validator in validator/ is the authoritative second opinion.
//
// Each check is a Rule: an object with a hook for each level of the workspace
// it looks at (a file, a model, a tree, a node, or the whole workspace).
// validateWorkspace walks the workspace once and calls every rule's hooks. To
// add a check, write a rule and add it to RULES.

import { childrenRange, COMMON_ATTRIBUTES } from './builtins';
import type { BehaviorTreeDef, BTDocument, BTNode, Issue, NodeModel, ParsedFile, PortModel, Severity } from './types';
import { payloadKeys } from './payload';
import { buildWorkspace, categoryOf, isObjective, modelOf, subtreeCount, subtreeRefs, type Workspace } from './workspace';
import { models as docModels, trees as docTrees } from './xml';

const NODE_STATUS = ['SUCCESS', 'FAILURE', 'RUNNING', 'IDLE', 'SKIPPED'];
const BOOLEANS = ['true', 'false', 'TRUE', 'FALSE', 'True', 'False', '1', '0'];

/** Whether a port value is a blackboard reference such as {target}. */
export function isBlackboardRef(value: string): boolean {
  return /^\{.*\}$/.test(value.trim());
}

function literalTypeError(port: PortModel, value: string): string | undefined {
  const type = (port.type ?? '').replace(/^std::/, '');
  const v = value.trim();
  if (/^(unsigned( int)?|uint\d*_t|size_t|unsigned long)$/.test(type)) {
    if (!/^\d+$/.test(v)) return `expects an unsigned integer (${port.type})`;
  } else if (/^(int|long|int\d*_t|short)$/.test(type)) {
    if (!/^[-+]?\d+$/.test(v)) return `expects an integer (${port.type})`;
  } else if (/^(double|float)$/.test(type)) {
    if (!/^[-+]?(\d+\.?\d*|\.\d+)([eE][-+]?\d+)?$/.test(v)) return `expects a number (${port.type})`;
  } else if (type === 'bool') {
    if (!BOOLEANS.includes(v)) return 'expects a boolean (true or false)';
  } else if (type === 'BT::NodeStatus') {
    if (!NODE_STATUS.includes(v)) return `expects one of ${NODE_STATUS.join(', ')}`;
  }
  return undefined;
}

/** What a rule sees: the workspace, and a way to report an issue. */
export interface Context {
  ws: Workspace;
  add(severity: Severity, file: string, message: string, extra?: Partial<Issue>): void;
}

/** Where a node is, to report its issues. */
export interface NodeAt {
  file: string;
  tree: BehaviorTreeDef;
  node: BTNode;
  /** The location of the node, to spread into an issue. */
  at: Partial<Issue>;
}

export interface Rule {
  file?(ctx: Context, path: string, doc: BTDocument): void;
  model?(ctx: Context, file: string, model: NodeModel): void;
  tree?(ctx: Context, file: string, tree: BehaviorTreeDef): void;
  node?(ctx: Context, at: NodeAt): void;
  /** Checks across files, run after every file was visited. */
  workspace?(ctx: Context): void;
}

// ---------------------------------------------------------------------------
// Files

const rootAttributes: Rule = {
  file({ ws, add }, path, doc) {
    const { rootAttrs } = doc;
    const trees = docTrees(doc);
    const format = rootAttrs.BTCPP_format;
    if (format === undefined) {
      if (trees.length) add('warning', path, '<root> has no BTCPP_format="4" attribute');
    } else if (format !== '4') {
      add('error', path, `BTCPP_format="${format}" is not supported: BehaviorTree.CPP 4 reads format 4 only`);
    }

    const main = rootAttrs.main_tree_to_execute;
    if (main !== undefined) {
      if (!trees.some((t) => t.id === main)) {
        const elsewhere = ws.trees.get(main)?.[0];
        if (elsewhere) {
          add('warning', path, `main_tree_to_execute "${main}" is defined in ${elsewhere.file}, not in this file`);
        } else {
          add('error', path, `main_tree_to_execute refers to the unknown tree "${main}"`);
        }
      }
    } else if (trees.length > 1) {
      add('warning', path,
        'The file has several trees but no main_tree_to_execute: createTreeFromFile() cannot tell which one to run');
    }
  },
};

// ---------------------------------------------------------------------------
// Models

const modelDeclarations: Rule = {
  model({ ws, add }, file, m) {
    if (!m.id) {
      add('error', file, `A <${m.category}> in TreeNodesModel has no ID`);
      return;
    }
    if (m.category !== 'SubTree' && ws.builtins.has(m.id)) {
      add('error', file, `The model "${m.id}" redefines a built-in node of BehaviorTree.CPP`);
    }
    const seen = new Set<string>();
    for (const p of m.ports) {
      if (!p.name) add('error', file, `A port of the model "${m.id}" has no name`);
      else if (seen.has(p.name)) add('error', file, `The model "${m.id}" declares the port "${p.name}" twice`);
      else if (p.name === 'name' || p.name === 'ID' || p.name.startsWith('_')) {
        add('error', file, `The model "${m.id}" uses the reserved port name "${p.name}"`);
      }
      seen.add(p.name);
    }
  },
};

const modelConflicts: Rule = {
  workspace({ ws, add }) {
    const signature = (m: NodeModel) =>
      JSON.stringify([m.category, m.ports.map((p) => [p.direction, p.name, p.type ?? '', p.default ?? ''])]);
    for (const [id, decls] of ws.modelDeclarations) {
      if (decls.length < 2) continue;
      const first = signature(decls[0]);
      for (const d of decls.slice(1)) {
        if (signature(d) !== first) add('warning', d.file!, `The model "${id}" is declared differently in ${decls[0].file}`);
      }
    }
  },
};

// ---------------------------------------------------------------------------
// Trees

const treeRoots: Rule = {
  tree({ add }, file, tree) {
    const where = { tree: tree.id, line: tree.line };
    if (!tree.id) add('error', file, '<BehaviorTree> has no ID', where);
    if (tree.children.length === 0) {
      add('error', file, `The tree "${tree.id}" is empty: it needs exactly one root node`, where);
    } else if (tree.children.length > 1) {
      add('error', file, `The tree "${tree.id}" has ${tree.children.length} root nodes: it needs exactly one`, where);
    }
  },
};

/**
 * A tree describes the entries of the global blackboard it reads, `{@key}`,
 * as the ports of its <SubTree> model, so that the Run dialog can say what
 * each one is. With a model, an entry it does not declare is a warning.
 * Without one, a tree that reads a payload gets a note: it runs the same, but
 * its payload comes with no description. It is only a note because a tree
 * that reads the global blackboard need not be one that is run on its own.
 */
const payloadDeclared: Rule = {
  tree({ ws, add }, file, tree) {
    const keys = payloadKeys(ws, tree.id);
    const where = { tree: tree.id, line: tree.line };
    const model = ws.subtreeModels.get(tree.id);
    if (!model) {
      if (keys.length) {
        const entries = keys.map((k) => `@${k}`).join(', ');
        add('info', file, `The tree "${tree.id}" reads ${entries} but does not describe them: declare them as the ports of <SubTree ID="${tree.id}"> in a TreeNodesModel`, where);
      }
      return;
    }
    const declared = new Set(model.ports.map((p) => p.name));
    for (const key of keys) {
      if (declared.has(key)) continue;
      add('warning', file, `The tree "${tree.id}" reads @${key}, which its TreeNodesModel does not declare`, where);
    }
  },
};

/**
 * A subtree, a tree that is not the main tree of its file, runs only when
 * another tree includes it: one that no tree includes never runs.
 */
const unusedSubtrees: Rule = {
  file({ ws, add }, path, doc) {
    for (const tree of docTrees(doc)) {
      if (!tree.id || isObjective(doc, tree.id) || subtreeCount(ws, tree.id) > 0) continue;
      add('warning', path, `The subtree "${tree.id}" never runs: no tree includes it, and it is not the main tree of its file`,
        { tree: tree.id, line: tree.line });
    }
  },
};

const duplicateTrees: Rule = {
  workspace({ ws, add }) {
    for (const [id, refs] of ws.trees) {
      if (!id || refs.length < 2) continue;
      const files = refs.map((r) => r.file).join(', ');
      for (const r of refs) {
        add('error', r.file, `The tree ID "${id}" is defined ${refs.length} times (${files})`, { tree: id, line: r.tree.line });
      }
    }
  },
};

/** A tree that includes itself, directly or not, can never be instantiated. */
const recursion: Rule = {
  workspace({ ws, add }) {
    const state = new Map<string, 'visiting' | 'done'>();
    const visit = (id: string, stack: string[]) => {
      const ref = ws.trees.get(id)?.[0];
      if (!ref || state.get(id) === 'done') return;
      state.set(id, 'visiting');
      for (const n of subtreeRefs(ref.tree.children)) {
        const target = n.attrs.ID;
        if (!target) continue;
        if (state.get(target) === 'visiting') {
          const path = [...stack, id];
          const cycle = [...path.slice(path.indexOf(target)), target].join(' → ');
          add('error', ref.file, `Recursive SubTree: ${cycle}`, { tree: id, nodeUid: n.uid, line: n.line });
        } else {
          visit(target, [...stack, id]);
        }
      }
      state.set(id, 'done');
    };
    for (const id of ws.trees.keys()) visit(id, []);
  },
};

// ---------------------------------------------------------------------------
// Nodes

const nodeTypes: Rule = {
  node({ ws, add }, { file, node, at }) {
    const model = modelOf(ws, node.id);
    if (!model) {
      add('error', file, `Unknown node "${node.id}": it is not built into BehaviorTree.CPP nor declared in any TreeNodesModel`, at);
    } else if (node.tag !== node.id && node.tag !== 'SubTree' && node.tag !== model.category) {
      add('error', file, `"${node.id}" is a ${model.category}, but it is written as <${node.tag}>`, at);
    }
  },
};

const childCount: Rule = {
  node({ ws, add }, { file, node, at }) {
    const category = categoryOf(ws, node);
    if (!category) return;
    const [min, max] = childrenRange(category, node.id);
    const n = node.children.length;
    if (n >= min && n <= max) return;
    const children = (k: number) => `${k} ${k === 1 ? 'child' : 'children'}`;
    let expected: string;
    if (max === 0) expected = 'no children';
    else if (min === max) expected = `exactly ${children(min)}`;
    else if (max === Infinity) expected = `at least ${children(min)}`;
    else expected = `${min} to ${max} children`;
    add('error', file, `${category} "${node.id}" must have ${expected}, but has ${n}`, at);
  },
};

function checkValue({ add }: Context, file: string, node: BTNode, port: PortModel, value: string, at: Partial<Issue>) {
  const where = { ...at, attribute: port.name };
  const v = value.trim();
  if (isBlackboardRef(v)) {
    const key = v.slice(1, -1).trim();
    if (!key) add('error', file, `The port "${port.name}" of "${node.id}" refers to an empty blackboard key`, where);
    else if (key !== '=' && !/^@?[A-Za-z_][\w.:/-]*$/.test(key)) {
      add('warning', file, `The port "${port.name}" of "${node.id}" refers to the unusual blackboard key "${key}"`, where);
    }
    return;
  }
  if (port.direction !== 'input') {
    add('error', file,
      `The ${port.direction} port "${port.name}" of "${node.id}" must be a blackboard reference such as {${port.name}}`, where);
    return;
  }
  if (/[{}]/.test(v) && port.type !== 'std::string' && !/Script|Precondition/.test(node.id)) {
    add('warning', file,
      `The port "${port.name}" of "${node.id}" contains braces but is not a blackboard reference: use {key} as the whole value`, where);
  }
  if (v === '') {
    if (port.type && port.type !== 'std::string') add('warning', file, `The port "${port.name}" of "${node.id}" is empty`, where);
    return;
  }
  const typeError = literalTypeError(port, v);
  if (typeError) add('error', file, `The port "${port.name}" of "${node.id}" ${typeError}, not "${value}"`, where);
}

/** The ports of a node that is not a SubTree: known, set, and well typed. */
const ports: Rule = {
  node(ctx, { file, node, at }) {
    const model = modelOf(ctx.ws, node.id);
    if (node.id === 'SubTree' || !model) return;
    const byName = new Map(model.ports.map((p) => [p.name, p]));
    for (const [name, value] of Object.entries(node.attrs)) {
      if (name === 'name') continue;
      if (name.startsWith('_')) {
        if (!(name in COMMON_ATTRIBUTES)) ctx.add('warning', file, `Unknown special attribute "${name}"`, { ...at, attribute: name });
        continue;
      }
      const port = byName.get(name);
      if (!port) ctx.add('error', file, `"${node.id}" has no port "${name}"`, { ...at, attribute: name });
      else checkValue(ctx, file, node, port, value, at);
    }
    for (const p of model.ports) {
      if (p.name in node.attrs || p.direction === 'output' || p.default !== undefined) continue;
      ctx.add('warning', file, `The input port "${p.name}" of "${node.id}" is not set and has no default`, { ...at, attribute: p.name });
    }
  },
};

const subtrees: Rule = {
  node({ ws, add }, { file, node, at }) {
    if (node.id !== 'SubTree') return;
    const target = node.attrs.ID;
    if (!target) {
      add('error', file, 'A SubTree has no ID: it must name the tree to instantiate', { ...at, attribute: 'ID' });
      return;
    }
    if (!ws.trees.has(target)) add('error', file, `The SubTree refers to the unknown tree "${target}"`, { ...at, attribute: 'ID' });
    const autoremap = node.attrs._autoremap;
    if (autoremap !== undefined && !BOOLEANS.includes(autoremap.trim())) {
      add('error', file, `_autoremap must be true or false, not "${autoremap}"`, { ...at, attribute: '_autoremap' });
    }
    const model = ws.subtreeModels.get(target);
    if (!model) return;
    const declared = new Set(model.ports.map((p) => p.name));
    for (const name of Object.keys(node.attrs)) {
      if (name === 'ID' || name === 'name' || name.startsWith('_') || declared.has(name)) continue;
      add('warning', file, `The tree "${target}" does not declare the port "${name}" in its TreeNodesModel`, { ...at, attribute: name });
    }
  },
};

const emptyScripts: Rule = {
  node({ add }, { file, node, at }) {
    for (const [name, value] of Object.entries(node.attrs)) {
      if (!(name in COMMON_ATTRIBUTES) || !name.startsWith('_') || name === '_description' || name === '_uid') continue;
      if (!value.trim()) add('warning', file, `The script ${name} is empty`, { ...at, attribute: name });
    }
  },
};

/** Every check, in the order their issues are reported for the same element. */
export const RULES: Rule[] = [
  rootAttributes, modelDeclarations, treeRoots, nodeTypes, childCount, ports, subtrees, emptyScripts,
  payloadDeclared, unusedSubtrees, duplicateTrees, modelConflicts, recursion,
];

export function validateWorkspace(ws: Workspace, rules: Rule[] = RULES): Issue[] {
  const issues: Issue[] = [];
  const ctx: Context = {
    ws,
    add: (severity, file, message, extra = {}) => issues.push({ severity, file, message, source: 'editor', ...extra }),
  };
  const visitNode = (file: string, tree: BehaviorTreeDef, node: BTNode) => {
    const at: NodeAt = { file, tree, node, at: { tree: tree.id, nodeUid: node.uid, line: node.line } };
    for (const r of rules) r.node?.(ctx, at);
    for (const c of node.children) visitNode(file, tree, c);
  };
  for (const f of ws.files) {
    if (!f.doc) {
      ctx.add('error', f.path, f.error?.message ?? 'The file cannot be read', { line: f.error?.line });
      continue;
    }
    for (const r of rules) r.file?.(ctx, f.path, f.doc);
    for (const m of docModels(f.doc)) for (const r of rules) r.model?.(ctx, f.path, m);
    for (const t of docTrees(f.doc)) {
      for (const r of rules) r.tree?.(ctx, f.path, t);
      for (const n of t.children) visitNode(f.path, t, n);
    }
  }
  for (const r of rules) r.workspace?.(ctx);
  return issues;
}

export function validateFiles(files: ParsedFile[], builtins?: NodeModel[]): Issue[] {
  return validateWorkspace(buildWorkspace(files, builtins));
}
