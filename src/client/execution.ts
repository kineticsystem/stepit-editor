// The execution of a tree on the server, as StepIt Commander reports it in the
// feedback of its ExecuteTree action: a JSON object per message,
//
//   {"tree": "<root>...</root>", "nodes": {"3": "RUNNING", "4": "FAILURE"},
//    "progress": {"3": {"done": 2, "total": 11}}}
//
// `tree`, in the first message only, is the tree being executed as written by
// BT::WriteTreeToXML: every subtree expanded into a <BehaviorTree> of its own,
// told apart by its _fullpath, and every node carrying its _uid. `nodes` are the
// nodes whose status changed since, by _uid, each with its last status, or
// HALTED for a node stopped while running, e.g. by a reactive parent.
// `progress`, only when one changed, is how far some running nodes are, by
// _uid: those whose behavior reports it, done out of total in a unit of its own.
// `run`, in the first message, is the number the server gives the run.
//
// StepIt Commander also publishes the whole run on a latched topic, for every
// client, whoever sent the goal: see parseSnapshot().

import { isDisabled } from '../shared/treeOps';
import type { BehaviorTreeDef, BTNode } from '../shared/types';
import { parseDocument, trees } from '../shared/xml';
import type { RunResult } from './ros';

export type ExecutionStatus = 'RUNNING' | 'SUCCESS' | 'FAILURE' | 'SKIPPED' | 'HALTED';

const STATUSES = new Set<string>(['RUNNING', 'SUCCESS', 'FAILURE', 'SKIPPED', 'HALTED']);

/** How far a running node is: done out of total, e.g. 3 of 11 iterations. */
export interface NodeProgress {
  done: number;
  total: number;
}

export interface ExecutionFeedback {
  /** The number of the run, in the first message. */
  run?: number;
  tree?: string;
  nodes: Record<string, ExecutionStatus>;
  progress?: Record<string, NodeProgress>;
}

function parseProgress(data: unknown): Record<string, NodeProgress> | undefined {
  if (typeof data !== 'object' || data === null) return undefined;
  const out: Record<string, NodeProgress> = {};
  for (const [uid, value] of Object.entries(data)) {
    const { done, total } = (value ?? {}) as { done?: unknown; total?: unknown };
    if (typeof done === 'number' && typeof total === 'number' && Number.isFinite(done) && total > 0) {
      out[uid] = { done, total };
    }
  }
  return out;
}

/** The feedback of a message, or undefined for any other message, e.g. plain text. */
export function parseFeedback(message: string): ExecutionFeedback | undefined {
  let data: unknown;
  try {
    data = JSON.parse(message);
  } catch {
    return undefined;
  }
  if (typeof data !== 'object' || data === null) return undefined;
  const { run, tree, nodes, progress } = data as { run?: unknown; tree?: unknown; nodes?: unknown; progress?: unknown };
  if (typeof nodes !== 'object' || nodes === null || (tree !== undefined && typeof tree !== 'string')) return undefined;
  return {
    run: typeof run === 'number' ? run : undefined,
    tree: tree as string | undefined,
    nodes: parseStatuses(nodes),
    progress: parseProgress(progress),
  };
}

function parseStatuses(nodes: object): Record<string, ExecutionStatus> {
  const out: Record<string, ExecutionStatus> = {};
  for (const [uid, status] of Object.entries(nodes)) {
    if (typeof status === 'string' && STATUSES.has(status)) out[uid] = status as ExecutionStatus;
  }
  return out;
}

/**
 * The whole run, as StepIt Commander publishes it on its latched topic
 * ~/execution, whenever it changes and once more when it ends:
 *
 *   {"run": 7, "objective": "Main", "tree": "<root>...</root>",
 *    "nodes": {"1": "RUNNING"}, "progress": {...}, "running": true}
 *
 * `nodes` holds every node that has run. A run that ended has `running` false,
 * `status`, how the tree ended, `cancelled` and `message`.
 */
export interface ExecutionSnapshot {
  run: number;
  objective: string;
  tree: string;
  nodes: Record<string, ExecutionStatus>;
  progress: Record<string, NodeProgress>;
  /** How it ended, once it did. */
  result?: RunResult;
}

/** The snapshot of a message of the topic, or undefined for anything else. */
export function parseSnapshot(message: string): ExecutionSnapshot | undefined {
  let data: unknown;
  try {
    data = JSON.parse(message);
  } catch {
    return undefined;
  }
  if (typeof data !== 'object' || data === null) return undefined;
  const { run, objective, tree, nodes, progress, running, status, cancelled, message: text } = data as Record<string, unknown>;
  if (typeof run !== 'number' || typeof objective !== 'string' || typeof tree !== 'string'
    || typeof nodes !== 'object' || nodes === null || typeof running !== 'boolean') return undefined;
  let result: RunResult | undefined;
  if (!running) {
    // As the goal ends: canceled, or succeeded when the tree did, or aborted.
    const treeStatus = typeof status === 'string' ? status : undefined;
    const outcome = cancelled === true ? 'canceled' : treeStatus === 'SUCCESS' ? 'succeeded' : 'aborted';
    result = { ok: outcome === 'succeeded', outcome, treeStatus, message: typeof text === 'string' ? text : '' };
  }
  return { run, objective, tree, nodes: parseStatuses(nodes), progress: parseProgress(progress) ?? {}, result };
}

/** The fraction done, from 0 to 1. */
export function progressFraction(progress: NodeProgress): number {
  return Math.min(1, Math.max(0, progress.done / progress.total));
}

/** A progress in a few characters: "3 / 11" for a count, a percentage otherwise. */
export function progressLabel(progress: NodeProgress): string {
  const { done, total } = progress;
  if (Number.isInteger(done) && Number.isInteger(total)) return `${done} / ${total}`;
  return `${Math.round(progressFraction(progress) * 100)}%`;
}

/**
 * The _uid of the node named in an error message of the server, e.g.
 * "Exception in node 'TrapezoidalTrajectory::20' [...]": a node that throws
 * ends the run without a last feedback, so this is how to tell which one.
 */
export function failedNodeUid(message: string): string | undefined {
  return /Exception in node '[^']*::(\d+)'/.exec(message)?.[1];
}

/** The tree being executed: its main tree, and each subtree instance by _fullpath. */
export interface ExecutedTree {
  root: BehaviorTreeDef;
  instances: Map<string, BehaviorTreeDef>;
}

export function parseExecutedTree(xml: string): ExecutedTree | undefined {
  const { doc } = parseDocument(xml);
  if (!doc) return undefined;
  const all = trees(doc);
  const instances = new Map(all.map((t) => [t.attrs._fullpath ?? '', t]));
  const root = instances.get('') ?? all[0];
  return root ? { root, instances } : undefined;
}

/** The key of a node of the executed tree: its _uid, or the parser's uid without one. */
export function executionKey(node: BTNode): string {
  return node.attrs._uid ?? node.uid;
}

/** The nodes below a node: the tree a SubTree instantiates, or its own children. */
export function childrenOf(tree: ExecutedTree, node: BTNode): BTNode[] {
  if (node.id === 'SubTree') return tree.instances.get(node.attrs._fullpath ?? '')?.children ?? [];
  return node.children;
}

export interface ExecutionRow {
  key: string;
  node: BTNode;
  depth: number;
  expandable: boolean;
  open: boolean;
  parentKey?: string;
  /**
   * The node, or one of its ancestors, is disabled (_skipIf="true"): it is
   * skipped. BehaviorTree.CPP tells only the parent, so the server cannot report it.
   */
  disabled: boolean;
}

/** The rows of the executed tree, in display order, subtrees included. */
export function executionRows(tree: ExecutedTree, collapsed: ReadonlySet<string>): ExecutionRow[] {
  const rows: ExecutionRow[] = [];
  const walk = (nodes: BTNode[], depth: number, parentKey: string | undefined, parentDisabled: boolean) => {
    for (const node of nodes) {
      const key = executionKey(node);
      const children = childrenOf(tree, node);
      const open = children.length > 0 && !collapsed.has(key);
      const disabled = parentDisabled || isDisabled(node);
      rows.push({ key, node, depth, expandable: children.length > 0, open, parentKey, disabled });
      if (open) walk(children, depth + 1, key, disabled);
    }
  };
  walk(tree.root.children, 0, undefined, false);
  return rows;
}

/**
 * The nodes that made the run fail: from the top, each failed node whose
 * children did not fail. A failure that its parent recovered from, e.g. the
 * first child of a Fallback that then succeeded, is not one of them.
 */
export function failureCauses(tree: ExecutedTree, statusOf: (node: BTNode) => ExecutionStatus | undefined): BTNode[] {
  const causes: BTNode[] = [];
  const visit = (nodes: BTNode[]) => {
    for (const node of nodes) {
      if (statusOf(node) !== 'FAILURE') continue;
      const failed = childrenOf(tree, node).filter((child) => statusOf(child) === 'FAILURE');
      if (failed.length) visit(failed);
      else causes.push(node);
    }
  };
  visit(tree.root.children);
  return causes;
}

/** How a run ended, in a few words. */
export function outcomeLabel(result: RunResult): string {
  if (result.outcome === 'failed') return 'Could not run the tree';
  if (result.outcome === 'canceled') return 'Stopped';
  if (result.ok) return 'Succeeded';
  if (result.outcome === 'aborted') return result.treeStatus === 'FAILURE' ? 'Failed' : 'Aborted';
  return `Ended with ${result.treeStatus ?? 'no status'}`;
}
