// The payload of an objective: the entries of the global blackboard that a tree
// reads, which a BehaviorTree.ROS2 server fills from the payload of the goal.

import type { BTNode } from './types';
import { findTree, type Workspace } from './workspace';

/** Attributes that are text, not ports or scripts. */
const TEXT_ATTRIBUTES = new Set(['ID', 'name', '_description']);

/** `{@key}` in a port, e.g. joint_names="{@joints}". */
const PORT_REFERENCE = /\{@([A-Za-z_]\w*)\}/g;
/** `@key` in a script, e.g. _skipIf="@speed > 1". */
const SCRIPT_REFERENCE = /@([A-Za-z_]\w*)/g;

function isScript(node: BTNode, attribute: string): boolean {
  return attribute.startsWith('_') || ((node.id === 'Script' || node.id === 'ScriptCondition') && attribute === 'code');
}

/**
 * The global blackboard entries that a tree reads, in the order they first
 * appear, including those of the trees its SubTrees include.
 */
export function payloadKeys(ws: Workspace, treeId: string): string[] {
  const keys = new Set<string>();
  const visited = new Set<string>();
  const visitTree = (id: string) => {
    if (visited.has(id)) return;
    visited.add(id);
    const ref = findTree(ws, id);
    if (ref) ref.tree.children.forEach(visitNode);
  };
  const visitNode = (node: BTNode) => {
    for (const [attribute, value] of Object.entries(node.attrs)) {
      if (TEXT_ATTRIBUTES.has(attribute)) continue;
      const pattern = isScript(node, attribute) ? SCRIPT_REFERENCE : PORT_REFERENCE;
      for (const match of value.matchAll(pattern)) keys.add(match[1]);
    }
    if (node.id === 'SubTree' && node.attrs.ID) visitTree(node.attrs.ID);
    node.children.forEach(visitNode);
  };
  visitTree(treeId);
  return [...keys];
}

/**
 * The payload text for the given values: a YAML map, one `key: value` line per
 * entry that has a value. Values are YAML too, e.g. `[joint1, joint2]` or `3.0`.
 */
export function payloadText(values: Record<string, string>): string {
  return Object.entries(values)
    .filter(([, value]) => value.trim() !== '')
    .map(([key, value]) => `${key}: ${value.trim()}`)
    .join('\n');
}

/**
 * What a tree says about an entry of its payload: its description, and an
 * example of its value.
 */
export interface PayloadHint {
  description?: string;
  example?: string;
}

/** `e.g. <example>` at the end of a description. */
const EXAMPLE = /^(.*?)[,;:]?\s*\be\.g\.\s+(.+)$/s;

/**
 * The hint of each payload entry of a tree, from the tree's own declaration:
 * the ports of its <SubTree> model in a TreeNodesModel, one per entry, named
 * after it. A port's description ends with an example of its value, after
 * "e.g.", e.g. "the joints to move, e.g. joint1 or [joint1, joint2]". The
 * behaviors the tree uses have no say: the tree describes its own payload.
 */
export function payloadHints(ws: Workspace, treeId: string): Map<string, PayloadHint> {
  const hints = new Map<string, PayloadHint>();
  for (const port of ws.subtreeModels.get(treeId)?.ports ?? []) {
    const text = port.description?.trim();
    if (!text) continue;
    const match = EXAMPLE.exec(text);
    hints.set(port.name, match ? { description: match[1].trim() || undefined, example: match[2].trim() } : { description: text });
  }
  return hints;
}
