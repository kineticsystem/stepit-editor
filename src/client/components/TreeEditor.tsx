// The center panel: the selected behavior, as a tree or as XML, with the
// editing toolbar and the problems list.

import { useState } from 'react';
import { idError } from '../../shared/ids';
import { findTreeByUid, flatten, isDisabled, locate } from '../../shared/treeOps';
import type { NodeModel } from '../../shared/types';
import { isObjective } from '../../shared/workspace';
import { models as docModels, trees } from '../../shared/xml';
import {
  addNewTree, copySelected, cutSelected, deleteSelected, duplicateSelected, paste, redo, save, shiftSelected,
  toggleDisabledSelected, treeIds, undo,
} from '../actions';
import { prompt } from '../dialogs';
import type { Analysis } from '../hooks';
import { type HistoryEntry, isDirty, useStore } from '../store';
import { openAddDialog } from './AddNodeDialog';
import { CategoryBadge, Icon } from './icons';
import { PortList } from './Ports';
import { Problems } from './Problems';
import { openRunDialog } from './RunDialog';
import { Splitter, useStoredSize } from './Splitter';
import { TreeView } from './TreeView';
import { XmlView } from './XmlView';

function ToolButton(props: { icon: string; label: string; tooltip?: string; shortcut?: string; onClick: () => void; disabled?: boolean; text?: boolean }) {
  const title = props.tooltip ?? props.label;
  return (
    <button className={props.text ? 'tool tool-text' : 'tool'} title={props.shortcut ? `${title} (${props.shortcut})` : title}
      aria-label={props.label} onClick={props.onClick} disabled={props.disabled}>
      <Icon name={props.icon} size={15} />
      {props.text && <span>{props.label}</span>}
    </button>
  );
}

/** Back and Forward between the trees opened, e.g. from a SubTree to the tree that includes it. */
function HistoryButtons() {
  const back = useStore((s) => s.back);
  const forward = useStore((s) => s.forward);
  const label = (verb: string, h: HistoryEntry | undefined, shortcut: string) =>
    h ? `${verb} to ${h.treeId || 'the previous tree'}${h.file ? ` (${h.file})` : ''} (${shortcut})` : verb;
  return (
    <div className="history-buttons">
      <button className="icon-button" title={label('Back', back.at(-1), 'Alt+←')} aria-label="Back"
        disabled={!back.length} onClick={() => useStore.getState().goBack()}>
        <Icon name="back" size={15} />
      </button>
      <button className="icon-button" title={label('Forward', forward.at(-1), 'Alt+→')} aria-label="Forward"
        disabled={!forward.length} onClick={() => useStore.getState().goForward()}>
        <Icon name="forward" size={15} />
      </button>
    </div>
  );
}

/** A file of node models only, e.g. generated from the C++ nodes: what it declares. */
function ModelList({ models, onAddTree }: { models: NodeModel[]; onAddTree: () => void }) {
  return (
    <div className="model-list">
      <p className="muted">
        This file declares node types and has no tree. Open it as XML to edit it, or{' '}
        <button className="link" onClick={onAddTree}>add a tree</button>.
      </p>
      {models.map((m) => (
        <section key={`${m.category}:${m.id}`}>
          <h3><CategoryBadge category={m.category} /> {m.id} <span className="muted small">{m.category}</span></h3>
          {m.description && <p className="muted">{m.description}</p>}
          <PortList ports={m.ports} />
        </section>
      ))}
    </div>
  );
}

async function newTree(path: string) {
  const existing = treeIds();
  const values = await prompt(`New tree in ${path}`, [{
    name: 'id', label: 'Tree ID', placeholder: 'MyBehavior', validate: (v) => idError(v, existing),
  }], 'Create');
  if (values) addNewTree(path, values.id);
}

export function TreeEditor({ analysis }: { analysis: Analysis }) {
  const selection = useStore((s) => s.selection);
  const file = useStore((s) => (selection.file ? s.files[selection.file] : undefined));
  const clipboard = useStore((s) => s.clipboard);
  const execution = useStore((s) => s.execution);
  const running = !!execution && !execution.result;
  const [view, setView] = useState<'tree' | 'xml'>('tree');
  const [problemsOpen, setProblemsOpen] = useState(true);
  const [problemsHeight, setProblemsHeight] = useStoredSize('be.problems', 220);
  const { ws } = analysis;

  const tree = file?.doc && selection.tree ? findTreeByUid(file.doc, selection.tree) : undefined;
  const fileTrees = file?.doc ? trees(file.doc) : [];
  const hasNode = !!selection.node;
  const selectedNode = tree && selection.node ? locate(tree, selection.node)?.node : undefined;
  const showXml = view === 'xml' || !!file?.error;

  const setAllCollapsed = (collapsed: boolean) => {
    if (!tree) return;
    const uids = flatten(tree.children).filter((n) => n.children.length).map((n) => n.uid);
    useStore.getState().setCollapsed(uids, collapsed);
  };

  return (
    <main className="panel editor">
      <header className="panel-header editor-header">
        <HistoryButtons />
        {file ? (
          <div className="breadcrumb">
            <span className="muted">{file.path}</span>
            <span className="muted">›</span>
            {fileTrees.length > 1 ? (
              <select value={selection.tree} onChange={(e) => useStore.getState().select({ file: file.path, tree: e.target.value })}>
                {fileTrees.map((t) => <option key={t.uid} value={t.uid}>{t.id || '(no ID)'}</option>)}
              </select>
            ) : (
              <b>{tree?.id ?? (file.error ? 'unreadable' : 'no tree')}</b>
            )}
            {file.doc && (
              <button className="icon-button" title="New tree in this file"
                onClick={() => void newTree(file.path)}>
                <Icon name="plus" size={14} />
              </button>
            )}
          </div>
        ) : <h1>No behavior selected</h1>}
        <span className="row-spacer" />
        {file && (
          <>
            <div className="segmented" role="tablist">
              <button role="tab" aria-selected={!showXml} className={!showXml ? 'active' : ''} disabled={!!file.error}
                onClick={() => setView('tree')}><Icon name="tree" size={14} /> Tree</button>
              <button role="tab" aria-selected={showXml} className={showXml ? 'active' : ''}
                onClick={() => setView('xml')}><Icon name="code" size={14} /> XML</button>
            </div>
            {execution && (
              <button className={`run-button ${execution.result ? '' : 'running'}`}
                title={`${execution.treeId}: ${execution.result ? 'show how the last run went' : 'running, show its execution'}`}
                onClick={() => useStore.getState().showExecution(true)}>
                <Icon name="tree" size={14} /> {execution.result ? 'Last run' : `Running ${execution.treeId}`}
              </button>
            )}
            {tree?.id && (
              <button className="run-button"
                title={!isObjective(file.doc, tree.id)
                  ? `${tree.id} is a subtree: it runs only inside another tree. Make it an objective to run it on its own`
                  : running ? 'A tree is already running' : `Run ${tree.id} on the robot, through rosbridge`}
                onClick={() => openRunDialog(ws, tree.id)} disabled={running || !isObjective(file.doc, tree.id)}>
                <Icon name="play" size={14} /> Run
              </button>
            )}
            <button className={`save-button ${isDirty(file) ? 'primary' : ''}`} disabled={!isDirty(file) || !file.doc}
              onClick={save} title="Save (Ctrl+S)">
              <Icon name="save" size={14} /> {isDirty(file) ? 'Save' : 'Saved'}
            </button>
          </>
        )}
      </header>

      {file?.doc && tree && !showXml && (
        <div className="toolbar" role="toolbar">
          <ToolButton icon="undo" label="Undo" shortcut="Ctrl+Z" onClick={undo} disabled={!file.past.length} />
          <ToolButton icon="redo" label="Redo" shortcut="Ctrl+Shift+Z" onClick={redo} disabled={!file.future.length} />
          <span className="sep" />
          <ToolButton icon="plus" label="Node" shortcut="A" text onClick={() => openAddDialog(ws, 'node')}
            tooltip="Add a node: a built-in one (Sequence, Fallback…), one of your node types, or a new node type. It goes inside the selected node, or after it if that node cannot have children" />
          <ToolButton icon="subtree" label="SubTree" shortcut="S" text onClick={() => openAddDialog(ws, 'subtree')}
            tooltip="Add a SubTree: include another tree of the workspace, which runs here as a single node. It goes where a new node would" />
          <span className="sep" />
          <ToolButton icon="up" label="Move up" shortcut="Alt+↑" onClick={() => shiftSelected(-1)} disabled={!hasNode} />
          <ToolButton icon="down" label="Move down" shortcut="Alt+↓" onClick={() => shiftSelected(1)} disabled={!hasNode} />
          <ToolButton icon="duplicate" label="Duplicate" shortcut="Ctrl+D" onClick={duplicateSelected} disabled={!hasNode} />
          <ToolButton icon="cut" label="Cut" shortcut="Ctrl+X" onClick={cutSelected} disabled={!hasNode} />
          <ToolButton icon="copy" label="Copy" shortcut="Ctrl+C" onClick={copySelected} disabled={!hasNode} />
          <ToolButton icon="paste" label="Paste" shortcut="Ctrl+V" onClick={() => paste(ws)} disabled={!clipboard} />
          <ToolButton icon="disable" label={selectedNode && isDisabled(selectedNode) ? 'Enable' : 'Disable'} shortcut="D"
            onClick={toggleDisabledSelected} disabled={!selectedNode}
            tooltip={selectedNode && isDisabled(selectedNode) ? 'Enable: run the node again'
              : 'Disable: skip the node and everything below it, through _skipIf'} />
          <ToolButton icon="trash" label="Delete" shortcut="Del" onClick={deleteSelected} disabled={!hasNode} />
          <span className="sep" />
          <ToolButton icon="expand" label="Expand all" onClick={() => setAllCollapsed(false)} />
          <ToolButton icon="collapse" label="Collapse all" onClick={() => setAllCollapsed(true)} />
        </div>
      )}

      <div className="editor-body">
        {!file ? (
          <div className="placeholder">Select a behavior on the left, or create one.</div>
        ) : showXml ? (
          <XmlView file={file} />
        ) : tree ? (
          <TreeView analysis={analysis} path={file.path} tree={tree} />
        ) : file.doc && docModels(file.doc).length ? (
          <ModelList models={docModels(file.doc)} onAddTree={() => void newTree(file.path)} />
        ) : (
          <div className="placeholder">
            This file has no behavior tree.{' '}
            <button className="link" onClick={() => void newTree(file.path)}>Add one</button>
          </div>
        )}
      </div>

      {problemsOpen && (
        <Splitter direction="rows" label="Resize the problems list" value={problemsHeight} onChange={setProblemsHeight}
          grow={-1} min={90} reserve={200} />
      )}
      <Problems analysis={analysis} open={problemsOpen} height={problemsHeight} onToggle={() => setProblemsOpen(!problemsOpen)} />
    </main>
  );
}
