// Editing commands, shared by the toolbar, the keyboard shortcuts, the row
// buttons and the panels. Most act on the current selection; the components
// call these rather than editing documents themselves.

import { canHaveChildren } from '../shared/builtins';
import {
  addTree, cloneNode, createNode, declareModel as declareModelIn, deleteTree as deleteTreeIn, findTreeByUid, insert,
  isDisabled, locate, modelsOf, move, type Placement, portsFromAttributes, remove, removeModel, renameTree as renameTreeIn,
  setAttr, setDisabled, shift, wrap,
} from '../shared/treeOps';
import type { BehaviorTreeDef, BTDocument, BTNode, NodeModel, NodeTypeCategory } from '../shared/types';
import { categoryOf, type Workspace } from '../shared/workspace';
import { newTree as createTree, trees } from '../shared/xml';
import { errorMessage } from './api';
import { choose } from './dialogs';
import { cancelAllGoals, type Run, runTree } from './ros';
import { hasDirtyFiles, isDirty, type SaveResult, useStore } from './store';

function current() {
  const s = useStore.getState();
  const { file, tree, node } = s.selection;
  return { s, file, tree, node };
}

/** Edits the tree `treeUid` of file `path`; `change` returns false when it finds nothing to do. */
export function editTree(path: string, treeUid: string,
  change: (tree: BehaviorTreeDef, doc: BTDocument) => boolean | void, coalesceKey?: string) {
  useStore.getState().edit(path, (doc) => {
    const t = findTreeByUid(doc, treeUid);
    if (!t) return false;
    return change(t, doc);
  }, coalesceKey);
}

/** Edits the node `uid` of tree `treeUid` in file `path`. */
export function editNode(path: string, treeUid: string, uid: string, change: (node: BTNode) => void, coalesceKey?: string) {
  editTree(path, treeUid, (t) => {
    const at = locate(t, uid);
    if (!at) return false;
    change(at.node);
  }, coalesceKey);
}

/** Edits the tree of the selection. */
function editSelectedTree(change: (tree: BehaviorTreeDef) => boolean | void) {
  const { file, tree } = current();
  if (file && tree) editTree(file, tree, change);
}

/** Edits the selected node. */
function editSelectedNode(change: (node: BTNode) => void) {
  const { file, tree, node } = current();
  if (file && tree && node) editNode(file, tree, node, change);
}

function selectedNode(): BTNode | undefined {
  const { s, file, tree, node } = current();
  const doc = file ? s.files[file]?.doc : undefined;
  const t = doc && tree ? findTreeByUid(doc, tree) : undefined;
  return t && node ? locate(t, node)?.node : undefined;
}

// ---------------------------------------------------------------------------
// Nodes

type Point = { target?: string; placement: Placement };

/** Where a new node goes: inside the selection if it can have children, else after it. */
export function insertionPoint(ws: Workspace, tree: BehaviorTreeDef, nodeUid?: string): Point {
  if (!nodeUid) {
    const root = tree.children[0];
    if (root && canHaveChildren(categoryOf(ws, root))) return { target: root.uid, placement: 'inside' };
    return { target: undefined, placement: 'inside' };
  }
  const at = locate(tree, nodeUid);
  if (at && canHaveChildren(categoryOf(ws, at.node))) return { target: nodeUid, placement: 'inside' };
  return { target: nodeUid, placement: 'after' };
}

/** Inserts at `point`, or by default at the insertion point of the selection. */
function insertNode(node: BTNode, point: Point | ((tree: BehaviorTreeDef, selected?: string) => Point)) {
  const { s, file, tree, node: selected } = current();
  if (!file || !tree) return;
  let at: Point | undefined;
  editSelectedTree((t) => {
    at = typeof point === 'function' ? point(t, selected) : point;
    return insert(t, node, at.target, at.placement);
  });
  if (at?.target && at.placement === 'inside') s.setCollapsed([at.target], false);
  s.select({ file, tree, node: node.uid });
}

export function addNode(ws: Workspace, model: Pick<NodeModel, 'id' | 'category'>, subtreeId?: string, point?: Point) {
  insertNode(createNode(model, subtreeId), point ?? ((t, selected) => insertionPoint(ws, t, selected)));
}

export function deleteSelected() {
  const { s, file, tree, node } = current();
  if (!file || !tree || !node) return;
  let nextSelection: string | undefined;
  editSelectedTree((t) => {
    const at = locate(t, node);
    if (!at) return false;
    const siblings = at.parent.children;
    nextSelection = (siblings[at.index + 1] ?? siblings[at.index - 1])?.uid
      ?? (at.parent !== t ? (at.parent as BTNode).uid : undefined);
    remove(t, node);
  });
  s.select({ file, tree, node: nextSelection });
}

export function shiftSelected(delta: -1 | 1) {
  const { node } = current();
  if (node) editSelectedTree((t) => shift(t, node, delta));
}

export function moveNode(uid: string, target: string, placement: Placement) {
  const { s, file, tree } = current();
  if (!file || !tree) return;
  editSelectedTree((t) => {
    // Dropping on the tree row makes the node the root.
    if (target === t.uid) {
      const moved = remove(t, uid);
      if (!moved) return false;
      t.children.unshift(moved);
      return;
    }
    return move(t, uid, target, placement);
  });
  if (placement === 'inside') s.setCollapsed([target], false);
  s.select({ file, tree, node: uid });
}

export function copySelected() {
  const node = selectedNode();
  if (!node) return;
  useStore.getState().setClipboard(node);
  useStore.getState().toast(`Copied ${node.id === 'SubTree' ? `SubTree ${node.attrs.ID}` : node.id}`);
}

export function cutSelected() {
  const node = selectedNode();
  if (!node) return;
  useStore.getState().setClipboard(node);
  deleteSelected();
}

export function paste(ws: Workspace) {
  const clip = useStore.getState().clipboard;
  if (clip) insertNode(cloneNode(clip), (t, selected) => insertionPoint(ws, t, selected));
}

export function duplicateSelected() {
  const node = selectedNode();
  if (node) insertNode(cloneNode(node), { target: node.uid, placement: 'after' });
}

/** Disables the selected node through _skipIf, or enables it again. */
export function toggleDisabledSelected() {
  editSelectedNode((n) => setDisabled(n, !isDisabled(n)));
}

/** Wraps the selected node in a new parent, e.g. an Inverter or a Sequence. */
export function wrapSelected(model: Pick<NodeModel, 'id' | 'category'>) {
  const { s, file, tree, node } = current();
  if (!file || !tree || !node) return;
  const parent = createNode(model);
  editSelectedTree((t) => wrap(t, node, parent));
  s.select({ file, tree, node: parent.uid });
}

// ---------------------------------------------------------------------------
// Node types

/** Declares a new custom node type in a file's TreeNodesModel. */
export function declareModel(path: string, id: string, category: NodeTypeCategory) {
  useStore.getState().edit(path, (doc) => declareModelIn(doc, id, category));
}

/** Declares the type of an undeclared node, with its attributes as input ports. */
export function declareFromNode(path: string, node: BTNode, category: NodeTypeCategory) {
  useStore.getState().edit(path, (doc) => declareModelIn(doc, node.id, category, portsFromAttributes(node)));
}

/** Declares a new node type and adds a node of it, wrapping the selection if asked and possible. */
export function addNewNodeType(ws: Workspace, modelsFile: string, id: string, category: NodeTypeCategory, wrapping: boolean) {
  declareModel(modelsFile, id, category);
  if (wrapping && canHaveChildren(category)) wrapSelected({ id, category });
  else addNode(ws, { id, category });
}

// ---------------------------------------------------------------------------
// Trees

/** Adds a new tree to a file and opens it. */
export function addNewTree(path: string, treeId: string) {
  const tree = createTree(treeId);
  const s = useStore.getState();
  s.edit(path, (doc) => addTree(doc, tree));
  s.select({ file: path, tree: tree.uid });
}

/** Deletes a tree from its file, and opens the file's default tree. */
export function deleteTree(path: string, treeUid: string) {
  const s = useStore.getState();
  s.edit(path, (doc) => deleteTreeIn(doc, treeUid));
  s.selectFile(path);
}

/**
 * Renames a tree, and updates everything that refers to it in every file: its
 * SubTree nodes, main_tree_to_execute and its SubTree model. Returns the
 * number of other files changed.
 */
export function renameTree(path: string, treeUid: string, from: string, to: string): number {
  const s = useStore.getState();
  let others = 0;
  for (const f of Object.values(s.files)) {
    if (!f.doc) continue;
    const before = s.files[f.path].doc;
    s.edit(f.path, (doc) => renameTreeIn(doc, from, to, f.path === path ? treeUid : undefined));
    if (f.path !== path && useStore.getState().files[f.path].doc !== before) others++;
  }
  return others;
}

/** Makes a tree the main tree of its file (main_tree_to_execute), or not. */
export function setMainTree(path: string, treeId: string, main: boolean) {
  useStore.getState().edit(path, (doc) => setAttr({ attrs: doc.rootAttrs }, 'main_tree_to_execute', main ? treeId : undefined));
}

/** Declares the ports of a tree, i.e. a SubTree model, empty at first. */
export function declareInterface(path: string, treeId: string) {
  useStore.getState().edit(path, (doc) => {
    modelsOf(doc).push({ id: treeId, category: 'SubTree', ports: [] });
  });
}

export function removeInterface(path: string, treeId: string) {
  useStore.getState().edit(path, (doc) => removeModel(doc, treeId, 'SubTree'));
}

/** The IDs of every tree of the loaded files. */
export function treeIds(): Set<string> {
  const { files } = useStore.getState();
  return new Set(Object.values(files).flatMap((f) => (f.doc ? trees(f.doc).map((t) => t.id) : [])));
}

// ---------------------------------------------------------------------------
// Files

/**
 * Saves a file. If it changed on disk since it was loaded, asks whether to
 * overwrite that change, take the version on disk, or keep editing.
 */
export async function saveFile(path: string): Promise<boolean> {
  const s = useStore.getState();
  let result: SaveResult = await s.save(path);
  while (result.status === 'conflict') {
    const conflict = result;
    const deleted = conflict.etag === undefined;
    const choice = await choose(`${path} changed on disk`,
      `${conflict.message} since the editor loaded it, e.g. by hand or from another tab. `
      + `Overwriting it loses that change; reloading it loses your unsaved edits.`,
      [
        { value: 'overwrite', label: deleted ? 'Save it again' : 'Overwrite', kind: 'danger' },
        { value: 'reload', label: deleted ? 'Drop my edits' : 'Reload from disk' },
      ]);
    if (choice === 'overwrite') {
      // Overwrite the version just seen, but not one written after it.
      result = await s.save(path, conflict.etag ?? null);
    } else {
      if (choice === 'reload') await s.revert(path);
      return false;
    }
  }
  return result.status === 'saved';
}

/** Saves every file with unsaved changes; true if all were saved. */
export async function saveAll(): Promise<boolean> {
  for (const f of Object.values(useStore.getState().files)) {
    if (isDirty(f)) await saveFile(f.path);
  }
  return !hasDirtyFiles(useStore.getState().files);
}

// ---------------------------------------------------------------------------
// Running

/** The run in progress, to stop it. */
let currentRun: Run | undefined;

/**
 * Runs a tree on the server, through rosbridge, and shows its execution in
 * the Execution tab. The files must be saved first: the server runs
 * them as they are on disk.
 */
export function startRun(options: { url: string; action: string; treeId: string; payload: string }) {
  useStore.getState().startExecution(options.treeId);
  const run = runTree({
    url: options.url, action: options.action, tree: options.treeId, payload: options.payload,
    onFeedback: (message) => useStore.getState().applyFeedback(message),
  });
  currentRun = run;
  void run.result.then((result) => {
    if (currentRun === run) currentRun = undefined;
    useStore.getState().endExecution(result);
  });
}

/**
 * Asks the server to stop the run in progress; it then ends as stopped. A run
 * of this editor is stopped by cancelling its goal; a run started elsewhere,
 * e.g. from StepIt UI, by cancelling every goal of the server, as StepIt UI's
 * Stop does.
 */
export function stopRun(connection: { url: string; action: string }) {
  if (currentRun) {
    currentRun.cancel();
    return;
  }
  cancelAllGoals(connection)
    .catch((e: unknown) => useStore.getState().toast(`Could not stop the run: ${errorMessage(e)}`, 'error'));
}

export function undo() {
  const { s, file } = current();
  if (file) s.undo(file);
}

export function redo() {
  const { s, file } = current();
  if (file) s.redo(file);
}

export function save() {
  const { file } = current();
  if (file) void saveFile(file);
}
