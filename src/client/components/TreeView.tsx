// The tree of the selected behavior, as an indented, collapsible list.
//
// SubTree nodes can be expanded to show the tree they include, read-only and
// dimmed; double-click one to open that tree. Behaviors can be dragged in from
// the Behaviors list to add a node. Rows can be dragged to move a
// node: to the top or bottom edge of a row to place it before or after, to the
// middle to make it the last child. A disabled node (_skipIf="true") never
// runs, so it is greyed out together with everything below it.

import { type DragEvent, type KeyboardEvent, useEffect, useMemo, useRef, useState } from 'react';
import { canHaveChildren } from '../../shared/builtins';
import { isDisabled, locate, type Placement } from '../../shared/treeOps';
import type { BehaviorTreeDef, BTNode, Issue } from '../../shared/types';
import { categoryOf, findTree, isObjective, modelOf, type TreeRef, type Workspace } from '../../shared/workspace';
import {
  addNode, copySelected, cutSelected, deleteSelected, duplicateSelected, moveNode, paste, shiftSelected,
  toggleDisabledSelected,
} from '../actions';
import { type Analysis, countBySeverity } from '../hooks';
import { getDraggedModel, setDraggedModel } from '../dnd';
import { useStore } from '../store';
import { openAddDialog } from './AddNodeDialog';
import { Counts, Icon } from './icons';
import { attrsTooltip, NodeLabel } from './NodeLabel';

interface Row {
  key: string;
  kind: 'tree' | 'node';
  node?: BTNode;
  tree: BehaviorTreeDef;
  file: string;
  depth: number;
  readonly: boolean;
  /** The node, or one of its ancestors, is disabled. */
  skipped: boolean;
  expandable: boolean;
  open: boolean;
  parentKey?: string;
  /** For SubTree nodes: the tree they include, when it exists. */
  target?: TreeRef;
}

function buildRows(ws: Workspace, file: string, tree: BehaviorTreeDef,
  collapsed: Record<string, true>, openSubtrees: Record<string, true>): Row[] {
  const rows: Row[] = [];
  const treeOpen = !collapsed[tree.uid];
  rows.push({
    key: tree.uid, kind: 'tree', tree, file, depth: 0, readonly: false, skipped: false,
    expandable: tree.children.length > 0, open: treeOpen,
  });
  const walk = (nodes: BTNode[], depth: number, owner: TreeRef, readonly: boolean, prefix: string,
    parentKey: string, ancestry: string[], parentSkipped: boolean) => {
    for (const n of nodes) {
      const key = readonly ? `${prefix}/${n.uid}` : n.uid;
      const skipped = parentSkipped || isDisabled(n);
      if (n.id === 'SubTree') {
        const target = findTree(ws, n.attrs.ID ?? '');
        const expandable = !!target && !ancestry.includes(target.tree.id) && target.tree.children.length > 0;
        const open = expandable && !!openSubtrees[key];
        rows.push({ key, kind: 'node', node: n, tree: owner.tree, file: owner.file, depth, readonly, skipped, expandable, open, parentKey, target });
        if (open && target) walk(target.tree.children, depth + 1, target, true, key, key, [...ancestry, target.tree.id], skipped);
      } else {
        const expandable = n.children.length > 0;
        const open = expandable && !collapsed[key];
        rows.push({ key, kind: 'node', node: n, tree: owner.tree, file: owner.file, depth, readonly, skipped, expandable, open, parentKey });
        if (open) walk(n.children, depth + 1, owner, readonly, prefix, key, ancestry, skipped);
      }
    }
  };
  if (treeOpen) walk(tree.children, 1, { file, tree }, false, '', tree.uid, [tree.id], false);
  return rows;
}

function IssueMarker({ issues }: { issues?: Issue[] }) {
  if (!issues?.length) return null;
  const { errors, warnings } = countBySeverity(issues);
  return (
    <span className="issue-marker" title={issues.map((i) => `${i.severity}: ${i.message}`).join('\n')}>
      <Counts errors={errors} warnings={warnings} />
    </span>
  );
}

interface DropTarget {
  key: string;
  placement: Placement;
}

export function TreeView({ analysis, path, tree }: { analysis: Analysis; path: string; tree: BehaviorTreeDef }) {
  const { ws, byNode } = analysis;
  const collapsed = useStore((s) => s.collapsed);
  const openSubtrees = useStore((s) => s.openSubtrees);
  const objective = useStore((s) => isObjective(s.files[path]?.doc, tree.id));
  const selection = useStore((s) => s.selection);
  const peek = useStore((s) => s.peek);
  const focusModel = useStore((s) => s.focusModel);
  const rows = useMemo(() => buildRows(ws, path, tree, collapsed, openSubtrees), [ws, path, tree, collapsed, openSubtrees]);
  const [drop, setDrop] = useState<DropTarget>();
  const dragged = useRef<string>(undefined);
  const container = useRef<HTMLDivElement>(null);

  // A read-only row clicked in an expanded SubTree takes the highlight.
  const selectedKey = peek?.key ?? selection.node ?? tree.uid;

  useEffect(() => {
    container.current?.querySelector('.row.selected')?.scrollIntoView({ block: 'nearest' });
  }, [selectedKey]);

  const treeIssues = analysis.issues.filter((i) => i.file === path && i.tree === tree.id && !i.nodeUid);

  const select = (row: Row) => {
    if (row.readonly) {
      useStore.getState().setPeek({ file: row.file, tree: row.tree.uid, node: row.node!.uid, key: row.key });
      return;
    }
    useStore.getState().select({ file: path, tree: tree.uid, node: row.kind === 'tree' ? undefined : row.node!.uid });
  };

  const toggle = (row: Row) => {
    const s = useStore.getState();
    if (row.node?.id === 'SubTree') s.toggleSubtree(row.key);
    else s.setCollapsed([row.key], row.open);
  };

  /** Opens the tree a row belongs to, or the tree a SubTree row includes. */
  const navigate = (row: Row) => {
    const s = useStore.getState();
    if (row.readonly) {
      s.select({ file: row.file, tree: row.tree.uid, node: row.node?.uid });
    } else if (row.target) {
      s.select({ file: row.target.file, tree: row.target.tree.uid });
    }
  };

  const onKeyDown = (e: KeyboardEvent) => {
    if ((e.target as HTMLElement).closest('input, textarea, select')) return;
    // Alt+← and Alt+→ are Back and Forward, handled by the app.
    if (e.altKey && (e.key === 'ArrowLeft' || e.key === 'ArrowRight')) return;
    const editable = rows.filter((r) => !r.readonly);
    const index = editable.findIndex((r) => r.key === selectedKey);
    const row = editable[index];
    const mod = e.ctrlKey || e.metaKey;
    let handled = true;
    if (e.key === 'ArrowDown' && e.altKey) shiftSelected(1);
    else if (e.key === 'ArrowUp' && e.altKey) shiftSelected(-1);
    else if (e.key === 'ArrowDown') { if (editable[index + 1]) select(editable[index + 1]); }
    else if (e.key === 'ArrowUp') { if (index > 0) select(editable[index - 1]); }
    else if (e.key === 'ArrowRight' && row) {
      if (row.expandable && !row.open) toggle(row);
      else if (row.open && editable[index + 1]?.parentKey === row.key) select(editable[index + 1]);
    } else if (e.key === 'ArrowLeft' && row) {
      if (row.expandable && row.open) toggle(row);
      else {
        const parent = editable.find((r) => r.key === row.parentKey);
        if (parent) select(parent);
      }
    } else if (e.key === 'Delete' || e.key === 'Backspace') deleteSelected();
    else if (e.key === 'Enter' && row?.target) navigate(row);
    else if (e.key === 'Enter' || e.key === 'Insert' || (e.key === 'a' && !mod)) openAddDialog(ws, 'node');
    else if (e.key === 's' && !mod) openAddDialog(ws, 'subtree');
    else if (e.key === 'd' && !mod && row?.kind === 'node') toggleDisabledSelected();
    else if (mod && e.key === 'c') copySelected();
    else if (mod && e.key === 'x') cutSelected();
    else if (mod && e.key === 'v') paste(ws);
    else if (mod && e.key === 'd') duplicateSelected();
    else handled = false;
    if (handled) e.preventDefault();
  };

  /** Where a drop on `row` would go: a moved node, or a new one from the Behaviors list. */
  const placementFor = (e: DragEvent, row: Row): Placement | undefined => {
    const uid = dragged.current;
    const model = getDraggedModel();
    if ((!uid && !model) || row.readonly) return undefined;
    // On the tree row: a moved node becomes the root; a new one only if the tree is empty.
    if (row.kind === 'tree') return uid || tree.children.length === 0 ? 'inside' : undefined;
    const node = row.node!;
    if (uid) {
      const moving = locate(tree, uid)?.node;
      if (!moving || moving.uid === node.uid || locate(moving, node.uid)) return undefined;
    }
    const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
    const y = (e.clientY - rect.top) / rect.height;
    const container = canHaveChildren(categoryOf(ws, node));
    if (container) return y < 0.3 ? 'before' : y > 0.7 && !row.open ? 'after' : 'inside';
    return y < 0.5 ? 'before' : 'after';
  };

  return (
    <div className="tree-view" ref={container} tabIndex={0} onKeyDown={onKeyDown} role="tree"
      aria-label={`Behavior tree ${tree.id}`}>
      {rows.map((row) => {
        const node = row.node;
        const category = node ? categoryOf(ws, node) : undefined;
        const issues = row.kind === 'tree' ? treeIssues : byNode.get(node!.uid);
        const isDrop = drop?.key === row.key;
        const className = [
          'row',
          row.kind === 'tree' ? 'row-tree' : '',
          row.readonly ? 'readonly' : '',
          row.skipped ? 'skipped' : '',
          row.key === selectedKey && !focusModel ? 'selected' : '',
          focusModel && node?.id === focusModel ? 'uses-model' : '',
          isDrop ? `drop-${drop.placement}` : '',
          issues?.some((i) => i.severity === 'error') ? 'has-error' : '',
        ].join(' ');
        return (
          <div
            key={row.key}
            className={className}
            style={{ '--depth': row.depth } as React.CSSProperties}
            role="treeitem"
            aria-level={row.depth + 1}
            aria-expanded={row.expandable ? row.open : undefined}
            aria-selected={row.key === selectedKey}
            draggable={!row.readonly && row.kind === 'node'}
            title={node ? attrsTooltip(node) : undefined}
            onClick={() => select(row)}
            onDoubleClick={() => navigate(row)}
            onDragStart={(e) => {
              dragged.current = node!.uid;
              e.dataTransfer.effectAllowed = 'move';
              e.dataTransfer.setData('text/plain', node!.id);
            }}
            onDragEnd={() => { dragged.current = undefined; setDrop(undefined); }}
            onDragOver={(e) => {
              const placement = placementFor(e, row);
              if (!placement) return;
              e.preventDefault();
              e.dataTransfer.dropEffect = dragged.current ? 'move' : 'copy';
              if (drop?.key !== row.key || drop.placement !== placement) setDrop({ key: row.key, placement });
            }}
            onDragLeave={(e) => {
              if (!e.currentTarget.contains(e.relatedTarget as Node)) setDrop(undefined);
            }}
            onDrop={(e) => {
              e.preventDefault();
              const placement = placementFor(e, row);
              const model = modelOf(ws, getDraggedModel() ?? '');
              if (placement && dragged.current) moveNode(dragged.current, row.key, placement);
              else if (placement && model) {
                addNode(ws, model, undefined, { target: row.kind === 'tree' ? undefined : row.key, placement });
                setDraggedModel(undefined);
              }
              setDrop(undefined);
            }}
          >
            <button
              className={`chevron ${row.open ? 'open' : ''} ${row.expandable ? '' : 'hidden'}`}
              tabIndex={-1}
              aria-label={row.open ? 'Collapse' : 'Expand'}
              onClick={(e) => { e.stopPropagation(); toggle(row); }}
            >
              <Icon name="chevron" size={12} />
            </button>
            {row.kind === 'tree' ? (
              <>
                <Icon name={objective ? 'tree' : 'subtree'} size={14} className="muted" />
                <span className="node-id">{tree.id || 'BehaviorTree'}</span>
                <span className="muted small">{objective ? 'Objective' : 'Subtree'}</span>
              </>
            ) : node!.id === 'SubTree' ? (
              <>
                <NodeLabel node={node!} />
                {row.target && !row.readonly && (
                  <button className="icon-button row-action" title="Open this tree (double-click)" tabIndex={-1}
                    onClick={(e) => { e.stopPropagation(); navigate(row); }}>
                    <Icon name="open" size={14} />
                  </button>
                )}
              </>
            ) : (
              <NodeLabel node={node!} category={category} />
            )}
            <span className="row-spacer" />
            <IssueMarker issues={issues} />
            {!row.readonly && (
              <span className="row-actions">
                <button className="icon-button" title="Add a node here (A)" tabIndex={-1}
                  onClick={(e) => { e.stopPropagation(); select(row); openAddDialog(ws, 'node'); }}>
                  <Icon name="plus" size={14} />
                </button>
                {row.kind === 'node' && (
                  <button className="icon-button" title={isDisabled(node!) ? 'Enable (D)' : 'Disable (D)'} tabIndex={-1}
                    onClick={(e) => { e.stopPropagation(); select(row); toggleDisabledSelected(); }}>
                    <Icon name="disable" size={14} />
                  </button>
                )}
                {row.kind === 'node' && (
                  <button className="icon-button" title="Delete (Del)" tabIndex={-1}
                    onClick={(e) => { e.stopPropagation(); select(row); deleteSelected(); }}>
                    <Icon name="trash" size={14} />
                  </button>
                )}
              </span>
            )}
          </div>
        );
      })}
      {tree.children.length === 0 && (
        <div className="empty-tree">
          <p>This tree is empty.</p>
          <p>
            <button className="primary" onClick={() => openAddDialog(ws, 'node')}>Add a root node</button>
            {' '}usually a <b>Sequence</b> or a <b>Fallback</b>.
          </p>
        </div>
      )}
    </div>
  );
}
