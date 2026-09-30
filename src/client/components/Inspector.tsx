// The right panel: the properties of the selected node, or of the behavior
// itself when no node is selected.

import { useEffect, useState } from 'react';
import { COMMON_ATTRIBUTES, SCRIPT_ATTRIBUTES } from '../../shared/builtins';
import { ID_PATTERN, idError } from '../../shared/ids';
import { findTreeByUid, flatten, locate, setAttr } from '../../shared/treeOps';
import {
  type BehaviorTreeDef, type BTDocument, type BTNode, type Issue, type NodeModel, NODE_TYPE_CATEGORIES,
  type NodeTypeCategory, type PortDirection, type PortModel,
} from '../../shared/types';
import { categoryOf, isObjective, modelOf, referencesTo, subtreeRefs, usagesOf } from '../../shared/workspace';
import { models as docModels, trees as docTrees, isGenerated } from '../../shared/xml';
import {
  declareFromNode, declareInterface, deleteTree, editNode, editTree, removeInterface, renameTree, setMainTree,
} from '../actions';
import { confirm } from '../dialogs';
import { type Analysis } from '../hooks';
import { useStore } from '../store';
import { CategoryBadge, Icon, SeverityIcon } from './icons';
import { DirectionArrow, PortList, PortType } from './Ports';

function IssueList({ issues }: { issues: Issue[] }) {
  if (!issues.length) return null;
  return (
    <ul className="issue-list">
      {issues.map((i, n) => (
        <li key={n} className={`issue issue-${i.severity}`}>
          <SeverityIcon severity={i.severity} /> <span>{i.message}</span>
        </li>
      ))}
    </ul>
  );
}

/** Whether the file `path` says it is generated, and must not be edited by hand. */
function useIsGenerated(path: string | undefined): boolean {
  return useStore((s) => (path ? isGenerated(s.files[path]?.doc) : false));
}

function TextField(props: {
  label: React.ReactNode;
  value: string | undefined;
  placeholder?: string;
  hint?: React.ReactNode;
  multiline?: boolean;
  mono?: boolean;
  onChange: (value: string | undefined) => void;
  actions?: React.ReactNode;
  issues?: Issue[];
}) {
  const common = {
    value: props.value ?? '',
    placeholder: props.placeholder,
    spellCheck: false,
    className: props.mono ? 'mono' : undefined,
    onChange: (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) =>
      props.onChange(e.target.value === '' ? undefined : e.target.value),
  };
  const invalid = props.issues?.some((i) => i.severity === 'error');
  return (
    <div className={`field ${invalid ? 'invalid' : ''}`}>
      <div className="field-label">{props.label}</div>
      <div className="field-input">
        {props.multiline ? <textarea rows={2} {...common} /> : <input {...common} />}
        {props.actions}
      </div>
      {props.hint && <small>{props.hint}</small>}
      {props.issues?.map((i, n) => <small key={n} className={`field-${i.severity}`}>{i.message}</small>)}
    </div>
  );
}

function PortField({ port, value, onChange, issues }: {
  port: PortModel;
  value: string | undefined;
  onChange: (value: string | undefined) => void;
  issues: Issue[];
}) {
  return (
    <TextField
      label={<>
        <DirectionArrow direction={port.direction} />
        <span className="port-name">{port.name}</span>
        <PortType type={port.type} />
      </>}
      value={value}
      mono
      placeholder={port.default !== undefined ? `default: ${port.default}` : port.direction === 'input' ? 'required' : `{${port.name}}`}
      hint={port.description}
      onChange={onChange}
      issues={issues}
    />
  );
}

/** The issues of a node about a given attribute. */
function issuesFor(issues: Issue[], name: string) {
  return issues.filter((i) => i.attribute === name);
}

function OtherAttributes({ node, known, onChange, issues }: {
  node: BTNode;
  known: Set<string>;
  onChange: (name: string, value: string | undefined) => void;
  issues: Issue[];
}) {
  const [adding, setAdding] = useState('');
  const others = Object.entries(node.attrs).filter(([k]) => !known.has(k));
  const valid = ID_PATTERN.test(adding) && !(adding in node.attrs);
  return (
    <>
      {others.map(([k, v]) => (
        <TextField key={k} mono label={<span className="port-name">{k}</span>} value={v}
          onChange={(value) => onChange(k, value ?? '')} issues={issuesFor(issues, k)}
          actions={<button className="icon-button" title="Remove" onClick={() => onChange(k, undefined)}><Icon name="trash" size={14} /></button>} />
      ))}
      <form className="add-attr" onSubmit={(e) => {
        e.preventDefault();
        if (valid) {
          onChange(adding, '');
          setAdding('');
        }
      }}>
        <input placeholder="attribute name" value={adding} onChange={(e) => setAdding(e.target.value)} spellCheck={false} />
        <button type="submit" disabled={!valid}>Add</button>
      </form>
    </>
  );
}

function Section({ title, children, open = true, extra }: { title: string; children: React.ReactNode; open?: boolean; extra?: React.ReactNode }) {
  return (
    <details className="section" open={open}>
      <summary><span>{title}</span>{extra}</summary>
      <div className="section-body">{children}</div>
    </details>
  );
}

/** Edits a model in the file that declares it. */
function ModelEditor({ file, model }: { file: string; model: NodeModel }) {
  const change = (fn: (m: NodeModel) => void, key?: string) => {
    useStore.getState().edit(file, (doc) => {
      const m = docModels(doc).find((x) => x.id === model.id && x.category === model.category);
      if (!m) return false;
      fn(m);
    }, key && `model:${file}:${model.id}:${key}`);
  };
  return (
    <div className="model-editor">
      {model.category !== 'SubTree' && (
        <TextField label="Description" value={model.description} multiline
          onChange={(v) => change((m) => { m.description = v; }, 'description')} />
      )}
      <div className="model-ports">
        {model.ports.map((p, i) => (
          <div key={i} className="model-port">
            <select value={p.direction} title="Direction"
              onChange={(e) => change((m) => { m.ports[i].direction = e.target.value as PortDirection; })}>
              <option value="input">in</option>
              <option value="output">out</option>
              <option value="inout">in/out</option>
            </select>
            <input className="mono" placeholder="name" value={p.name} spellCheck={false}
              onChange={(e) => change((m) => { m.ports[i].name = e.target.value; }, `port${i}name`)} />
            <input className="mono" placeholder="type" value={p.type ?? ''} spellCheck={false}
              onChange={(e) => change((m) => { m.ports[i].type = e.target.value || undefined; }, `port${i}type`)} />
            <input className="mono" placeholder="default" value={p.default ?? ''} spellCheck={false}
              onChange={(e) => change((m) => { m.ports[i].default = e.target.value || undefined; }, `port${i}default`)} />
            <button className="icon-button" title="Remove the port"
              onClick={() => change((m) => { m.ports.splice(i, 1); })}><Icon name="trash" size={14} /></button>
            <input className="port-description" placeholder="description" value={p.description ?? ''}
              onChange={(e) => change((m) => { m.ports[i].description = e.target.value || undefined; }, `port${i}description`)} />
          </div>
        ))}
      </div>
      <button onClick={() => change((m) => {
        let n = m.ports.length + 1;
        while (m.ports.some((p) => p.name === `port${n}`)) n++;
        m.ports.push({ direction: 'input', name: `port${n}` });
      })}><Icon name="plus" size={14} /> Add port</button>
    </div>
  );
}

function NodeInspector({ analysis, path, tree, node, readOnly = false }: {
  analysis: Analysis;
  path: string;
  tree: BehaviorTreeDef;
  node: BTNode;
  /** For a node of an included tree: shown, but edited only by opening its tree. */
  readOnly?: boolean;
}) {
  const { ws } = analysis;
  const issues = analysis.byNode.get(node.uid) ?? [];
  const model = modelOf(ws, node.id);
  const category = categoryOf(ws, node);
  const set = (name: string, value: string | undefined) =>
    editNode(path, tree.uid, node.uid, (n) => setAttr(n, name, value), `attr:${node.uid}:${name}`);

  const isSubTree = node.id === 'SubTree';
  const target = isSubTree ? ws.trees.get(node.attrs.ID ?? '')?.[0] : undefined;
  const subtreeModel = isSubTree ? ws.subtreeModels.get(node.attrs.ID ?? '') : undefined;
  const ports = isSubTree ? subtreeModel?.ports ?? [] : model?.ports ?? [];
  const known = new Set(['name', 'ID', ...ports.map((p) => p.name), ...Object.keys(COMMON_ATTRIBUTES), '_autoremap']);
  const scriptsSet = SCRIPT_ATTRIBUTES.some((k) => k in node.attrs);
  const treeIds = [...ws.trees.keys()].filter(Boolean).sort();
  const [declareAs, setDeclareAs] = useState<NodeTypeCategory>('Action');
  const generated = useIsGenerated(model?.file);
  // The attributes shown as fields, with their issues next to them; the other issues are listed at the top.
  const fields = new Set([
    'name', '_description', ...ports.map((p) => p.name), ...SCRIPT_ATTRIBUTES,
    ...Object.keys(node.attrs).filter((k) => !known.has(k)),
  ]);

  return (
    <div className="inspector-body">
      {readOnly && (
        <div className="read-only-banner">
          <span>Part of <b>{tree.id}</b> ({path}), shown inside a SubTree. It is read-only here.</span>
          <button onClick={() => useStore.getState().select({ file: path, tree: tree.uid, node: node.uid })}>
            <Icon name="open" size={14} /> Open to edit
          </button>
        </div>
      )}
      <fieldset className="bare" disabled={readOnly}>
      <div className="inspector-title">
        <CategoryBadge category={category} />
        <div>
          <h2>{isSubTree ? node.attrs.ID || 'SubTree' : node.id}</h2>
          <div className="muted small">
            {isSubTree ? 'SubTree' : category ?? 'Unknown type'}
            {model?.builtin && !isSubTree && ' · built into BehaviorTree.CPP'}
            {model?.file && ` · declared in ${model.file}`}
            {node.line !== undefined && ` · line ${node.line}`}
          </div>
        </div>
      </div>
      {!isSubTree && model?.description && <p className="description">{model.description}</p>}
      {isSubTree && target?.tree.attrs._description && <p className="description">{target.tree.attrs._description}</p>}
      <IssueList issues={issues.filter((i) => !i.attribute || !fields.has(i.attribute))} />

      <Section title="Node">
        <TextField label="Instance name" value={node.attrs.name} placeholder={isSubTree ? node.attrs.ID : node.id}
          onChange={(v) => set('name', v)} hint="Optional; shown in logs" />
        {isSubTree && (
          <>
            <div className="field">
              <div className="field-label">Tree</div>
              <div className="field-input">
                <select value={node.attrs.ID ?? ''} onChange={(e) => set('ID', e.target.value)}>
                  {!treeIds.includes(node.attrs.ID ?? '') && <option value={node.attrs.ID ?? ''}>{node.attrs.ID || '(none)'} — not found</option>}
                  {treeIds.filter((id) => id !== tree.id).map((id) => <option key={id} value={id}>{id}</option>)}
                </select>
                {target && (
                  <button className="icon-button" title="Open this tree"
                    onClick={() => useStore.getState().select({ file: target.file, tree: target.tree.uid })}>
                    <Icon name="open" size={14} />
                  </button>
                )}
              </div>
              {target && <small>Defined in {target.file}</small>}
            </div>
            <label className="checkbox">
              <input type="checkbox" checked={node.attrs._autoremap === 'true'}
                onChange={(e) => set('_autoremap', e.target.checked ? 'true' : undefined)} />
              <span><b>_autoremap</b>: share the blackboard entries with the same names as the ports</span>
            </label>
          </>
        )}
      </Section>

      <Section title={isSubTree ? 'Port remapping' : 'Ports'}>
        {ports.map((p) => (
          <PortField key={p.name} port={p} value={node.attrs[p.name]} onChange={(v) => set(p.name, v)}
            issues={issuesFor(issues, p.name)} />
        ))}
        {!ports.length && !isSubTree && model && <p className="muted small">This node has no ports.</p>}
        {isSubTree && !subtreeModel && (
          <p className="muted small">
            The ports of {node.attrs.ID || 'the tree'} are not declared. Declare them in its TreeNodesModel (select the
            tree to do so) to list them here, or add remappings below.
          </p>
        )}
        <OtherAttributes node={node} known={known} onChange={set} issues={issues} />
      </Section>

      <Section title="Scripts (pre and post conditions)" open={scriptsSet}>
        {SCRIPT_ATTRIBUTES.map((k) => (
          <TextField key={k} mono label={<span className="port-name">{k}</span>} value={node.attrs[k]}
            placeholder={COMMON_ATTRIBUTES[k]} onChange={(v) => set(k, v)} issues={issuesFor(issues, k)} />
        ))}
      </Section>

      <Section title="Notes" open={!!node.attrs._description}>
        <TextField label="_description" value={node.attrs._description} multiline onChange={(v) => set('_description', v)} />
      </Section>

      {!isSubTree && !model?.builtin && (
        <Section title="Node type">
          {model?.file && generated ? (
            <p className="muted small">
              Declared in {model.file}, which is generated from the C++ nodes: change the C++ code and regenerate the
              file rather than editing it here.
            </p>
          ) : model?.file ? (
            <>
              <p className="muted small">
                The declaration of <b>{node.id}</b> in {model.file}, shared by every {node.id} node. It must match the
                ports that the C++ class provides.
              </p>
              <ModelEditor file={model.file} model={model} />
            </>
          ) : (
            <>
              <p className="muted small">
                <b>{node.id}</b> is not declared: BehaviorTree.CPP will refuse the tree unless the application registers it.
                Declare it so the editor knows its ports.
              </p>
              <div className="field-input">
                <select value={declareAs} onChange={(e) => setDeclareAs(e.target.value as NodeTypeCategory)}>
                  {NODE_TYPE_CATEGORIES.map((c) => <option key={c}>{c}</option>)}
                </select>
                {/* Its attributes become the input ports of the new model. */}
                <button className="primary" onClick={() => declareFromNode(path, node, declareAs)}>Declare in {path}</button>
              </div>
            </>
          )}
        </Section>
      )}
      </fieldset>
    </div>
  );
}

/** A node type from the Behaviors list: its declaration, and where it is used. */
function BehaviorInspector({ analysis, id }: { analysis: Analysis; id: string }) {
  const { ws } = analysis;
  const model = modelOf(ws, id);
  const generated = useIsGenerated(model?.file);
  if (!model) return <div className="placeholder">The behavior {id} is no longer declared.</div>;
  const usages = usagesOf(ws, id);
  const total = usages.reduce((n, u) => n + u.nodes.length, 0);
  // Built-in nodes and generated models are shown, not edited.
  const readOnly = model.builtin || generated;

  return (
    <div className="inspector-body">
      <div className="inspector-title">
        <CategoryBadge category={model.category} />
        <div>
          <h2>{model.id}</h2>
          <div className="muted small">
            {model.category} ·{' '}
            {model.builtin ? 'built into BehaviorTree.CPP' : (
              <>declared in <button className="link" onClick={() => useStore.getState().selectFile(model.file!)}>{model.file}</button></>
            )}
          </div>
        </div>
      </div>
      {model.description && <p className="description">{model.description}</p>}

      <Section title={`Ports (${model.ports.length})`}>
        {readOnly ? (
          <>
            <PortList ports={model.ports} />
            {generated && (
              <p className="muted small">
                Generated from the C++ nodes: change the C++ code and regenerate {model.file} rather than editing it here.
              </p>
            )}
          </>
        ) : (
          <ModelEditor file={model.file!} model={model} />
        )}
      </Section>

      <Section title={`Used in ${usages.length} ${usages.length === 1 ? 'tree' : 'trees'}${total ? ` (${total}×)` : ''}`}>
        {usages.length ? (
          <ul className="usage-list">
            {usages.map(({ ref, nodes }) => (
              <li key={ref.tree.uid}>
                <button className="link" onClick={() => useStore.getState().select({ file: ref.file, tree: ref.tree.uid, node: nodes[0].uid })}>
                  {ref.tree.id}
                </button>
                <span className="muted small"> {ref.file}{nodes.length > 1 ? ` · ${nodes.length}×` : ''}</span>
              </li>
            ))}
          </ul>
        ) : <p className="muted small">No tree uses this behavior yet.</p>}
      </Section>
    </div>
  );
}

function TreeInspector({ analysis, path, tree, doc }: { analysis: Analysis; path: string; tree: BehaviorTreeDef; doc: BTDocument }) {
  const { ws } = analysis;
  const [id, setId] = useState(tree.id);
  useEffect(() => setId(tree.id), [tree.id, tree.uid]);
  const isMain = isObjective(doc, tree.id);
  /** The objective of the file, which becomes a subtree when this tree becomes the objective. */
  const otherMain = !isMain ? doc.rootAttrs.main_tree_to_execute : undefined;
  const issues = analysis.issues.filter((i) => i.file === path && i.tree === tree.id);
  const nodes = flatten(tree.children);
  const uses = [...new Set(subtreeRefs(tree.children).map((n) => n.attrs.ID).filter(Boolean))];
  const usedBy = referencesTo(ws, tree.id);
  const subtreeModel = ws.subtreeModels.get(tree.id);
  const error = id === tree.id ? undefined : idError(id, ws.trees.keys());

  const rename = () => {
    if (id === tree.id || error) return;
    const others = renameTree(path, tree.uid, tree.id, id);
    if (others) useStore.getState().toast(`Renamed ${tree.id} to ${id}, and updated ${others} other ${others === 1 ? 'file' : 'files'}`);
  };

  const goTo = (treeId: string) => {
    const ref = ws.trees.get(treeId)?.[0];
    if (ref) useStore.getState().select({ file: ref.file, tree: ref.tree.uid });
  };

  return (
    <div className="inspector-body">
      <div className="inspector-title">
        {isMain
          ? <span className="badge cat-Tree"><Icon name="tree" size={12} /></span>
          : <span className="badge cat-SubTree"><Icon name="subtree" size={12} /></span>}
        <div>
          <h2>{tree.id || 'BehaviorTree'}</h2>
          <div className="muted small">
            {isMain ? 'Objective' : 'Subtree'} · {path}{tree.line !== undefined && ` · line ${tree.line}`}
          </div>
        </div>
      </div>
      <IssueList issues={issues} />

      <Section title="Behavior">
        <form className="field" onSubmit={(e) => { e.preventDefault(); rename(); }}>
          <div className="field-label">Tree ID</div>
          <div className="field-input">
            <input className="mono" value={id} onChange={(e) => setId(e.target.value)} onBlur={rename} spellCheck={false} />
          </div>
          {error ? <small className="field-error">{error}</small>
            : id !== tree.id ? <small>Press Enter to rename; SubTree references are updated too</small> : null}
        </form>
        <div className="field" role="radiogroup" aria-label="Kind">
          <div className="field-label">Kind</div>
          <label className="checkbox">
            <input type="radio" name={`kind-${tree.uid}`} checked={isMain} onChange={() => setMainTree(path, tree.id, true)} />
            <span>
              <b>Objective</b>: runs on its own, as the main tree of {path} (<code>main_tree_to_execute</code>)
              {otherMain && <>, instead of {otherMain}, which becomes a subtree</>}
            </span>
          </label>
          <label className="checkbox">
            <input type="radio" name={`kind-${tree.uid}`} checked={!isMain} onChange={() => setMainTree(path, tree.id, false)} />
            <span><b>Subtree</b>: runs only inside another tree, which includes it with a SubTree node</span>
          </label>
        </div>
        <TextField label="Description" value={tree.attrs._description} multiline
          onChange={(v) => editTree(path, tree.uid, (t) => setAttr(t, '_description', v), `tree:${tree.uid}:description`)} />
      </Section>

      <Section title="Interface (ports)">
        {subtreeModel?.file ? (
          <>
            <p className="muted small">The ports that SubTree nodes can remap, declared in {subtreeModel.file}.</p>
            <ModelEditor file={subtreeModel.file} model={subtreeModel} />
            <button className="link danger" onClick={async () => {
              if (await confirm('Remove the interface', `Remove the port declarations of ${tree.id}?`, 'Remove')) {
                removeInterface(subtreeModel.file!, tree.id);
              }
            }}>Remove the declaration</button>
          </>
        ) : (
          <>
            <p className="muted small">
              Declaring the ports lets the editor list them on SubTree nodes, and check their remappings.
            </p>
            <button onClick={() => declareInterface(path, tree.id)}><Icon name="plus" size={14} /> Declare ports</button>
          </>
        )}
      </Section>

      <Section title="Structure">
        <dl className="stats">
          <dt>Nodes</dt><dd>{nodes.length}</dd>
          <dt>Includes</dt>
          <dd>{uses.length ? uses.map((u) => (
            <button key={u} className="link" onClick={() => goTo(u!)}>{u}</button>
          )) : <span className="muted">no SubTree</span>}</dd>
          <dt>Used by</dt>
          <dd>{usedBy.length ? usedBy.map((r) => (
            <button key={r.tree.uid} className="link" onClick={() => goTo(r.tree.id)}>{r.tree.id}</button>
          )) : <span className="muted">{isMain ? 'main tree' : 'not used by any tree'}</span>}</dd>
        </dl>
      </Section>

      <Section title="File" open={false}>
        <p className="muted small">{path} has {docTrees(doc).length} {docTrees(doc).length === 1 ? 'tree' : 'trees'}.</p>
        <button className="danger" onClick={async () => {
          if (await confirm('Delete tree', <>Delete the tree <b>{tree.id}</b> from {path}?</>)) deleteTree(path, tree.uid);
        }}><Icon name="trash" size={14} /> Delete this tree</button>
      </Section>
    </div>
  );
}

export function Inspector({ analysis }: { analysis: Analysis }) {
  const selection = useStore((s) => s.selection);
  const peek = useStore((s) => s.peek);
  const focusModel = useStore((s) => s.focusModel);
  const peekFile = useStore((s) => (peek ? s.files[peek.file] : undefined));
  const peekTree = peekFile?.doc && peek ? findTreeByUid(peekFile.doc, peek.tree) : undefined;
  const peekNode = peekTree && peek ? locate(peekTree, peek.node)?.node : undefined;
  const file = useStore((s) => (selection.file ? s.files[selection.file] : undefined));
  const tree = file?.doc && selection.tree ? findTreeByUid(file.doc, selection.tree) : undefined;
  const node = tree && selection.node ? locate(tree, selection.node)?.node : undefined;

  return (
    <aside className="panel inspector">
      <header className="panel-header">
        <h1>{focusModel ? 'Behavior' : node || peekNode ? 'Node' : tree && !isObjective(file?.doc, tree.id) ? 'Subtree' : 'Objective'}</h1>
      </header>
      {focusModel ? (
        <BehaviorInspector key={focusModel} analysis={analysis} id={focusModel} />
      ) : peekNode && peekTree ? (
        <NodeInspector key={peek!.key} analysis={analysis} path={peek!.file} tree={peekTree} node={peekNode} readOnly />
      ) : !file || !tree || !file.doc ? (
        <div className="placeholder">Select a behavior to see its details.</div>
      ) : node ? (
        <NodeInspector key={node.uid} analysis={analysis} path={file.path} tree={tree} node={node} />
      ) : (
        <TreeInspector key={tree.uid} analysis={analysis} path={file.path} tree={tree} doc={file.doc} />
      )}
    </aside>
  );
}
