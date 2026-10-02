// The center panel while a tree runs on the server, in place of the tree
// editor: the tree as the server executes it, subtrees included, with the last
// status of each node, and the progress of a running node that reports one. It
// looks like the tree editor, read-only.

import { useEffect, useMemo, useRef, useState } from 'react';
import type { BTNode } from '../../shared/types';
import { categoryOf, findTree, type Workspace } from '../../shared/workspace';
import { stopRun } from '../actions';
import {
  type ExecutedTree, executionKey, type ExecutionRow, executionRows, type ExecutionStatus, failureCauses, type NodeProgress,
  outcomeLabel, progressFraction, progressLabel,
} from '../execution';
import type { Analysis } from '../hooks';
import { type Execution, useStore } from '../store';
import { Icon } from './icons';
import { attrsTooltip, NodeLabel } from './NodeLabel';

const STATUS_LABELS: Record<ExecutionStatus, string> = {
  RUNNING: 'Running', SUCCESS: 'Success', FAILURE: 'Failure', SKIPPED: 'Skipped', HALTED: 'Halted',
};

const STATUS_ICONS: Record<ExecutionStatus, string> = {
  RUNNING: '●', SUCCESS: '✓', FAILURE: '✕', SKIPPED: '–', HALTED: '■',
};

/**
 * The tree as the editor knows it, for a server that does not report the
 * executed tree: no status then, and its SubTrees are not expanded.
 */
function editorTree(ws: Workspace, treeId: string): ExecutedTree | undefined {
  const ref = findTree(ws, treeId);
  return ref ? { root: ref.tree, instances: new Map() } : undefined;
}

/** The state of the run, in the header. */
function RunState({ execution }: { execution: Execution }) {
  const { result } = execution;
  if (!result) return <span className="exec-state exec-running"><span className="exec-dot" /> Running</span>;
  return <span className={`exec-state ${result.ok ? 'exec-success' : 'exec-failure'}`}>{outcomeLabel(result)}</span>;
}

/** How far a running node is, for a node that reports it. */
function ProgressCell({ progress }: { progress: NodeProgress }) {
  const percent = Math.round(progressFraction(progress) * 100);
  return (
    <span className="exec-progress">
      <span className="exec-progress-bar" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={percent}>
        <span style={{ width: `${percent}%` }} />
      </span>
      <span className="exec-progress-label">{progressLabel(progress)}</span>
    </span>
  );
}

function StatusCell({ status }: { status?: ExecutionStatus }) {
  if (!status) return null;
  return (
    <span className={`exec-status exec-${status.toLowerCase()}`}>
      <span aria-hidden="true">{STATUS_ICONS[status]}</span> {STATUS_LABELS[status]}
    </span>
  );
}

export function ExecutionPanel({ analysis }: { analysis: Analysis }) {
  const execution = useStore((s) => s.execution);
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const container = useRef<HTMLDivElement>(null);
  const { ws } = analysis;

  const tree = useMemo(
    () => execution?.tree ?? (execution ? editorTree(ws, execution.treeId) : undefined),
    [execution?.tree, execution?.treeId, ws],
  );
  const rows = useMemo(() => (tree ? executionRows(tree, collapsed) : []), [tree, collapsed]);

  const statusOf = (row: ExecutionRow): ExecutionStatus | undefined =>
    execution?.crashed === row.key ? 'FAILURE' : execution?.statuses[row.key] ?? (row.disabled ? 'SKIPPED' : undefined);

  // Follow the run: keep the last running node in view.
  const running = [...rows].reverse().find((r) => statusOf(r) === 'RUNNING')?.key;
  useEffect(() => {
    if (!running) return;
    container.current?.querySelector(`[data-key="${CSS.escape(running)}"]`)?.scrollIntoView({ block: 'nearest' });
  }, [running]);

  if (!execution) return null;

  const toggle = (row: ExecutionRow) => {
    const next = new Set(collapsed);
    if (row.open) next.add(row.key);
    else next.delete(row.key);
    setCollapsed(next);
  };

  // Why the run failed: the deepest failures, and a node that threw, which ends the
  // run before its ancestors can fail.
  const nodeStatus = (node: BTNode) => {
    const key = executionKey(node);
    return execution.crashed === key ? 'FAILURE' : execution.statuses[key];
  };
  const causes = tree ? failureCauses(tree, nodeStatus) : [];
  const crashedRow = rows.find((r) => r.key === execution.crashed);
  if (crashedRow && !causes.includes(crashedRow.node)) causes.push(crashedRow.node);
  const reveal = (node: BTNode) => container.current
    ?.querySelector(`[data-key="${CSS.escape(executionKey(node))}"]`)?.scrollIntoView({ block: 'center' });
  const statusesReported = !!execution.tree;

  return (
    <main className="panel editor execution">
      <header className="panel-header editor-header">
        <button className="icon-button" title="Back to the editor" aria-label="Back to the editor"
          onClick={() => useStore.getState().showExecution(false)}>
          <Icon name="back" size={15} />
        </button>
        <div className="breadcrumb">
          <span className="muted">Execution</span>
          <span className="muted">›</span>
          <b>{execution.treeId}</b>
        </div>
        <RunState execution={execution} />
        <span className="row-spacer" />
        {!execution.result ? (
          <button className="danger" onClick={stopRun} title="Ask the server to stop the tree">
            <Icon name="close" size={14} /> Stop
          </button>
        ) : (
          <button onClick={() => useStore.getState().showExecution(false)}>
            <Icon name="tree" size={14} /> Back to the editor
          </button>
        )}
      </header>

      <div className="editor-body">
        {!statusesReported && (
          <div className="banner">
            {execution.result ? 'The server reported no status for this run.' : 'Waiting for the server to report the tree…'}
            {' '}StepIt Commander reports the status of every node; other BehaviorTree.ROS2 servers only report how the run ends.
          </div>
        )}
        <div className="tree-view" ref={container} role="tree" aria-label={`Execution of ${execution.treeId}`}>
          <div className="row row-tree" style={{ '--depth': 0 } as React.CSSProperties}>
            <span className="chevron hidden" />
            <Icon name="tree" size={14} className="muted" />
            <span className="node-id">{execution.treeId}</span>
            <span className="muted small">BehaviorTree</span>
          </div>
          {rows.map((row) => {
            const status = statusOf(row);
            const progress = status === 'RUNNING' ? execution.progress[row.key] : undefined;
            const className = [
              'row',
              status ? `exec-row-${status.toLowerCase()}` : 'exec-row-idle',
              status === 'SKIPPED' || status === 'HALTED' ? 'skipped' : '',
            ].join(' ');
            return (
              <div key={row.key} data-key={row.key} className={className} role="treeitem"
                style={{ '--depth': row.depth + 1 } as React.CSSProperties}
                aria-level={row.depth + 2} aria-expanded={row.expandable ? row.open : undefined}
                title={attrsTooltip(row.node)}>
                <button className={`chevron ${row.open ? 'open' : ''} ${row.expandable ? '' : 'hidden'}`} tabIndex={-1}
                  aria-label={row.open ? 'Collapse' : 'Expand'} onClick={() => toggle(row)}>
                  <Icon name="chevron" size={12} />
                </button>
                <NodeLabel node={row.node} category={categoryOf(ws, row.node)} />
                <span className="row-spacer" />
                {progress && <ProgressCell progress={progress} />}
                <StatusCell status={status} />
              </div>
            );
          })}
        </div>
      </div>

      <section className="problems open execution-log">
        <header className="problems-header">
          <b>Run</b>
          <span className="muted">
            {!execution.result ? 'running' : causes.length ? `failed at ${causes.length === 1 ? 'one node' : `${causes.length} nodes`}` : ''}
          </span>
        </header>
        <div className="problems-body">
          <ul className="issue-table">
            {causes.map((node) => (
              <li key={executionKey(node)} className="issue issue-error" onClick={() => reveal(node)}>
                <span className="sev sev-error">✕</span>
                <span className="issue-message">{describe(node)} failed</span>
              </li>
            ))}
            {execution.messages.map((m, i) => <li key={`m${i}`} className="issue"><span className="issue-message mono">{m}</span></li>)}
          </ul>
          {execution.result?.message && <pre className="run-message">{execution.result.message}</pre>}
        </div>
      </section>
    </main>
  );
}

function describe(node: BTNode): string {
  const id = node.id === 'SubTree' ? `SubTree ${node.attrs.ID ?? ''}` : node.id;
  return node.attrs.name && node.attrs.name !== node.id ? `${id} “${node.attrs.name}”` : id;
}
