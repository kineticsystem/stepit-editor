// The left panel: the behavior files of the folder and the trees in each.

import { useEffect, useRef, useState } from 'react';
import { fileNameFor, filePathError, idError } from '../../shared/ids';
import { CATEGORIES, isNodeTypeCategory, type NodeModel } from '../../shared/types';
import type { BehaviorTreeDef } from '../../shared/types';
import { customModels, isObjective, subtreeCount, usageCount } from '../../shared/workspace';
import { models, trees } from '../../shared/xml';
import { treeIds } from '../actions';
import { confirm, prompt } from '../dialogs';
import { MODEL_MIME, setDraggedModel } from '../dnd';
import { type Analysis, countBySeverity } from '../hooks';
import { type FileState, isDirty, useStore } from '../store';
import { openFolderDialog } from './FolderDialog';
import { CategoryBadge, Counts, Icon } from './icons';
import { useSettings } from '../settings';
import { SettingsMenu } from './SettingsMenu';

/** Creates a file with one tree: an objective, or a subtree, which only runs inside another tree. */
export async function newBehaviorFile(objective = true) {
  const { files, createFile } = useStore.getState();
  const existing = treeIds();
  const values = await prompt(objective ? 'New objective' : 'New subtree', [
    {
      name: 'tree', label: 'Tree ID', placeholder: 'PickObject',
      hint: 'The ID other behaviors use to include it as a SubTree',
      validate: (v) => idError(v, existing),
    },
    {
      name: 'file', label: 'File', placeholder: 'defaults to the tree ID, e.g. pick_object.xml',
      hint: 'Relative to the behaviors folder; may include sub-folders',
      validate: (v, all) => filePathError(fileNameFor(v, all.tree), Object.keys(files)),
    },
  ], 'Create');
  if (values) createFile(fileNameFor(values.file, values.tree), values.tree, objective);
}

/** A group of a tab's list, which can be collapsed. */
type GroupId = 'objectives' | 'subtrees' | 'behaviors' | 'builtins';
type TreeSectionId = 'objectives' | 'subtrees';

/**
 * What a list of trees shows: a tree alone when its file holds only that tree,
 * so that the list is not cluttered with a file name per tree, and the file
 * otherwise, with the trees it holds of that list. A file with several trees
 * may so appear in both lists, and one with no tree, e.g. unreadable, only
 * among the objectives.
 */
type Entry =
  | { kind: 'tree'; path: string; tree: BehaviorTreeDef }
  | { kind: 'file'; path: string; trees: BehaviorTreeDef[] };

function entriesOf(files: Record<string, FileState>, section: TreeSectionId): Entry[] {
  const entries: Entry[] = [];
  for (const [path, f] of Object.entries(files)) {
    if (!isObjectiveFile(f)) continue;
    const all = f.doc ? trees(f.doc) : [];
    const mine = all.filter((t) => isObjective(f.doc, t.id) === (section === 'objectives'));
    if (all.length === 1 && mine.length === 1) entries.push({ kind: 'tree', path, tree: mine[0] });
    else if (mine.length || (!all.length && section === 'objectives')) entries.push({ kind: 'file', path, trees: mine });
  }
  const label = (e: Entry) => (e.kind === 'tree' ? e.tree.id : e.path);
  return entries.sort((a, b) => label(a).localeCompare(label(b)));
}

/** Files shown under Objectives: all but those that only declare node types. */
function isObjectiveFile(f: FileState): boolean {
  return !f.doc || trees(f.doc).length > 0 || models(f.doc).length === 0;
}

function SearchBox({ placeholder, value, onChange }: { placeholder: string; value: string; onChange: (value: string) => void }) {
  return (
    <div className="search">
      <Icon name="search" size={14} />
      <input placeholder={placeholder} aria-label={placeholder} value={value} onChange={(e) => onChange(e.target.value)}
        onKeyDown={(e) => e.key === 'Escape' && onChange('')} />
      {value && (
        <button className="icon-button" title="Clear the filter" onClick={() => onChange('')}><Icon name="close" size={12} /></button>
      )}
    </div>
  );
}

/** A node type that can be clicked to see it, or dragged onto the tree to add it. */
function NodeTypeRow({ model, uses, active }: { model: NodeModel; uses: number; active: boolean }) {
  return (
    <li className={`behavior-row ${active ? 'active' : ''}`}
      title={`${model.description ? `${model.description}\n` : ''}Drag it onto the tree to add it`}
      onClick={() => useStore.getState().setFocusModel(model.id)}
      draggable
      onDragStart={(e) => {
        e.dataTransfer.effectAllowed = 'copy';
        e.dataTransfer.setData(MODEL_MIME, model.id);
        e.dataTransfer.setData('text/plain', model.id);
        setDraggedModel(model.id);
      }}
      onDragEnd={() => setDraggedModel(undefined)}>
      <CategoryBadge category={model.category} />
      <span className="file-name">{model.id}</span>
      {uses > 0 && <span className="uses">{uses}×</span>}
      {uses === 0 && !model.builtin && <span className="uses unused">unused</span>}
    </li>
  );
}

/** The header of a group of a list: its name and size, and a button to collapse it. */
function GroupHeader({ title, count, open, onToggle, children }: {
  title: string;
  count: number;
  open: boolean;
  onToggle: () => void;
  children?: React.ReactNode;
}) {
  return (
    <div className="section-header">
      <button className="section-toggle" onClick={onToggle} aria-expanded={open}>
        <Icon name="chevron" size={12} className={open ? 'rotate' : ''} />
        <span>{title}</span>
        <span className="section-count">{count}</span>
      </button>
      {children}
    </div>
  );
}

export function Browser({ analysis }: { analysis: Analysis }) {
  const files = useStore((s) => s.files);
  const root = useStore((s) => s.root);
  const selection = useStore((s) => s.selection);
  const focusModel = useStore((s) => s.focusModel);
  const { ws, byFile } = analysis;
  const tab = useSettings((s) => s.browserTab);
  const setTab = (browserTab: 'trees' | 'nodes') => useSettings.getState().update({ browserTab });
  const [treesFilter, setTreesFilter] = useState('');
  const [nodesFilter, setNodesFilter] = useState('');
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({});
  const [groups, setGroups] = useState<Record<GroupId, boolean>>({ objectives: true, subtrees: true, behaviors: true, builtins: true });
  const toggle = (id: GroupId) => setGroups({ ...groups, [id]: !groups[id] });

  // Opening another tree, e.g. from a link or a SubTree, shows the trees. Not
  // the first tree selected when the folder loads: the tab last used stays.
  const shownTree = useRef(selection.tree);
  useEffect(() => {
    if (shownTree.current && selection.tree && selection.tree !== shownTree.current && !focusModel) setTab('trees');
    shownTree.current = selection.tree;
  }, [selection.tree, focusModel]);

  const nodesQuery = nodesFilter.trim().toLowerCase();
  const objectives = entriesOf(files, 'objectives');
  const subtrees = entriesOf(files, 'subtrees');
  const count = (entries: Entry[]) => entries.reduce((n, e) => n + (e.kind === 'tree' ? 1 : e.trees.length), 0);

  /** The delete button of a file, and the markers of its state: unsaved, unreadable, problems. */
  const fileState = (path: string) => {
    const f = files[path];
    return (
      <>
        {isDirty(f) && <span className="dirty" title="Unsaved changes">●</span>}
        {f.error && <span className="count count-error" title={f.error.message}>XML</span>}
        <Counts {...countBySeverity(byFile.get(path))} />
        <button className="icon-button row-action" title={`Delete ${path}`}
          onClick={async (e) => {
            e.stopPropagation();
            if (await confirm('Delete file', <>Delete <b>{path}</b> from disk? This cannot be undone.</>)) {
              await useStore.getState().deleteFile(path);
            }
          }}>
          <Icon name="trash" size={14} />
        </button>
      </>
    );
  };

  /** How often a subtree is included, or that nothing includes it, so it never runs. */
  const subtreeUses = (tree: BehaviorTreeDef) => {
    const uses = subtreeCount(ws, tree.id);
    return uses > 0
      ? <span className="uses" title={`Included by ${uses} SubTree node${uses > 1 ? 's' : ''}`}>{uses}×</span>
      : <span className="uses unused" title="No tree includes it, so it never runs">unused</span>;
  };

  const treeList = (section: TreeSectionId, entries: Entry[], filter: string) => {
    const query = filter.trim().toLowerCase();
    const matches = (path: string, tree: BehaviorTreeDef) => tree.id.toLowerCase().includes(query) || path.toLowerCase().includes(query);
    const treeRow = (path: string, tree: BehaviorTreeDef, flat: boolean) => (
      <li key={tree.uid} role="treeitem"
        className={`tree-row ${flat ? 'flat' : ''} ${selection.tree === tree.uid && !focusModel ? 'active' : ''}`}
        title={flat ? path : undefined}
        onClick={() => useStore.getState().select({ file: path, tree: tree.uid })}>
        <Icon name={section === 'objectives' ? 'tree' : 'subtree'} size={14} className="muted" />
        <span className="file-name">{tree.id || <i className="muted">no ID</i>}</span>
        {section === 'subtrees' && subtreeUses(tree)}
        {flat && fileState(path)}
      </li>
    );
    return (
      <ul role="tree" aria-label={section === 'objectives' ? 'Objectives' : 'Subtrees'}>
        {entries.map((entry) => {
          const { path } = entry;
          if (entry.kind === 'tree') return query && !matches(path, entry.tree) ? null : treeRow(path, entry.tree, true);
          const shown = query ? entry.trees.filter((t) => matches(path, t)) : entry.trees;
          if (query && !path.toLowerCase().includes(query) && !shown.length) return null;
          const key = `${section}:${path}`;
          const open = query ? true : !collapsed[key];
          const slash = path.lastIndexOf('/');
          return (
            <li key={key} role="treeitem" aria-expanded={open}>
              <div className={`file-row ${selection.file === path && !selection.tree && !focusModel ? 'active' : ''}`}
                onClick={() => useStore.getState().selectFile(path)}>
                <button className={`chevron ${open ? 'open' : ''} ${entry.trees.length ? '' : 'hidden'}`}
                  onClick={(e) => { e.stopPropagation(); setCollapsed({ ...collapsed, [key]: open }); }}
                  aria-label={open ? 'Collapse' : 'Expand'}>
                  <Icon name="chevron" size={12} />
                </button>
                <Icon name="file" size={14} className="muted" />
                <span className="file-name" title={path}>
                  {slash >= 0 && <span className="muted">{path.slice(0, slash + 1)}</span>}
                  {path.slice(slash + 1)}
                </span>
                {fileState(path)}
              </div>
              {open && <ul role="group">{shown.map((t) => treeRow(path, t, false))}</ul>}
            </li>
          );
        })}
        {query && entries.length > 0 && !entries.some((e) => (e.kind === 'tree' ? matches(e.path, e.tree) : e.path.toLowerCase().includes(query) || e.trees.some((t) => matches(e.path, t)))) && (
          <li className="empty">No {section === 'objectives' ? 'objective' : 'subtree'} matches “{filter}”.</li>
        )}
        {!entries.length && section === 'objectives' && (
          <li className="empty">
            No objectives in this folder.
            <button className="link" onClick={() => void newBehaviorFile()}>Create an objective</button>
          </li>
        )}
        {!entries.length && section === 'subtrees' && (
          <li className="empty">
            No subtrees. A tree that is not the main tree of its file is a subtree: it runs only inside another tree.
          </li>
        )}
      </ul>
    );
  };
  const behaviors = customModels(ws);
  const shownBehaviors = nodesQuery ? behaviors.filter((m) => m.id.toLowerCase().includes(nodesQuery)) : behaviors;
  const builtins = [...ws.builtins.values()].filter((m) => m.category !== 'SubTree');
  const shownBuiltins = nodesQuery ? builtins.filter((m) => m.id.toLowerCase().includes(nodesQuery)) : builtins;
  const usage = new Map([...behaviors, ...builtins].map((m) => [m.id, usageCount(ws, m.id)]));

  return (
    <aside className="panel browser">
      <header className="panel-header">
        <h1 title={root}>Workspace</h1>
        <div className="panel-actions">
          <button className="icon-button" title="Reload the folder (keeps unsaved edits)"
            onClick={() => void useStore.getState().load()}>
            <Icon name="refresh" />
          </button>
          <SettingsMenu />
        </div>
      </header>
      <button className="root-path" title={`${root}\nClick to open another folder`} onClick={openFolderDialog}>
        <Icon name="folder" size={14} /> <span>{root}</span> <Icon name="open" size={12} />
      </button>

      <div className="segmented browser-tabs" role="tablist" aria-label="Workspace">
        <button role="tab" aria-selected={tab === 'trees'} className={tab === 'trees' ? 'active' : ''} onClick={() => setTab('trees')}>
          <Icon name="tree" size={14} /> Trees
        </button>
        <button role="tab" aria-selected={tab === 'nodes'} className={tab === 'nodes' ? 'active' : ''} onClick={() => setTab('nodes')}>
          <Icon name="nodes" size={14} /> Nodes
        </button>
      </div>

      {tab === 'trees' ? (
        <section className="browser-section open fill" role="tabpanel" aria-label="Trees">
          <SearchBox placeholder="Filter trees" value={treesFilter} onChange={setTreesFilter} />
          <div className="file-list">
            <GroupHeader title="Objectives" count={count(objectives)} open={groups.objectives} onToggle={() => toggle('objectives')}>
              <button className="icon-button" title="New objective" onClick={() => void newBehaviorFile()}>
                <Icon name="newFile" size={14} />
              </button>
            </GroupHeader>
            {groups.objectives && treeList('objectives', objectives, treesFilter)}
            <GroupHeader title="Subtrees" count={count(subtrees)} open={groups.subtrees} onToggle={() => toggle('subtrees')}>
              <button className="icon-button" title="New subtree" onClick={() => void newBehaviorFile(false)}>
                <Icon name="newFile" size={14} />
              </button>
            </GroupHeader>
            {groups.subtrees && treeList('subtrees', subtrees, treesFilter)}
          </div>
        </section>
      ) : (
        <section className="browser-section open fill" role="tabpanel" aria-label="Nodes">
          <SearchBox placeholder="Filter nodes" value={nodesFilter} onChange={setNodesFilter} />
          <div className="file-list">
            <GroupHeader title="Behaviors" count={behaviors.length} open={groups.behaviors} onToggle={() => toggle('behaviors')} />
            {groups.behaviors && (
              <ul aria-label="Behaviors">
                {shownBehaviors.map((m) => (
                  <NodeTypeRow key={m.id} model={m} uses={usage.get(m.id) ?? 0} active={focusModel === m.id} />
                ))}
                {behaviors.length > 0 && !shownBehaviors.length && <li className="empty">No behavior matches “{nodesFilter}”.</li>}
                {!behaviors.length && (
                  <li className="empty">
                    No behaviors declared. Declare your C++ nodes in a TreeNodesModel, e.g. generated with
                    BT::writeTreeNodesModelXML.
                  </li>
                )}
              </ul>
            )}
            <GroupHeader title="Built-in nodes" count={builtins.length} open={groups.builtins} onToggle={() => toggle('builtins')} />
            {groups.builtins && (
              <ul aria-label="Built-in nodes">
                {CATEGORIES.filter(isNodeTypeCategory).map((category) => {
                  const group = shownBuiltins.filter((m) => m.category === category).sort((a, b) => a.id.localeCompare(b.id));
                  if (!group.length) return null;
                  return (
                    <li key={category}>
                      <div className="group-label">{category}</div>
                      <ul>
                        {group.map((m) => (
                          <NodeTypeRow key={m.id} model={m} uses={usage.get(m.id) ?? 0} active={focusModel === m.id} />
                        ))}
                      </ul>
                    </li>
                  );
                })}
                {!shownBuiltins.length && <li className="empty">No built-in node matches “{nodesFilter}”.</li>}
              </ul>
            )}
          </div>
        </section>
      )}
    </aside>
  );
}
