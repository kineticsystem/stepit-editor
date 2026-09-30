// Parsing and writing BehaviorTree.CPP v4 XML files.
//
// The writer uses two-space indentation and one element per line. Comments
// are kept, attached to the element that follows them, and elements the editor
// does not understand (e.g. <include>) are kept verbatim.

import { DOMParser, XMLSerializer } from '@xmldom/xmldom';
import {
  type BehaviorTreeDef, type BTDocument, type BTNode, CATEGORIES, type DocItem, type NodeCategory, type NodeModel,
  NODE_TYPE_CATEGORIES, type ParseError, type PortDirection, type PortModel,
} from './types';

// xmldom exports its own DOM types, which are not quite the lib.dom ones.
type XNode = { nodeType: number; nodeName: string; nodeValue: string | null; childNodes: ArrayLike<XNode>; lineNumber?: number };
type XElement = XNode & {
  tagName: string;
  attributes: ArrayLike<{ name: string; value: string }>;
  getAttribute(name: string): string | null;
  textContent: string | null;
};

const ELEMENT_NODE = 1;
const COMMENT_NODE = 8;

/** The generic element names of the explicit form, <Action ID="..."/>. */
const EXPLICIT_TAGS = new Set<string>(NODE_TYPE_CATEGORIES);
const MODEL_TAGS = new Set<string>(CATEGORIES);

let nextUid = 1;
export function newUid(): string {
  return `n${nextUid++}`;
}

function attributes(el: XElement): Record<string, string> {
  const out: Record<string, string> = {};
  for (let i = 0; i < el.attributes.length; i++) {
    const a = el.attributes[i];
    out[a.name] = a.value;
  }
  return out;
}

function elements(el: XNode): XNode[] {
  return Array.from(el.childNodes);
}

/**
 * Whether a file is meant for BehaviorTree.CPP: its first element is <root>.
 * Other XML files in the folder, like a ROS package.xml, are ignored. A file
 * too broken to tell is kept, so that its errors are shown.
 */
export function isBehaviorFile(text: string): boolean {
  const body = text.replace(/<\?[\s\S]*?\?>|<!--[\s\S]*?-->|<!DOCTYPE[^>]*>/g, '');
  const first = /<([A-Za-z_][\w:.-]*)/.exec(body);
  return !first || first[1] === 'root';
}

export function parseDocument(text: string): { doc?: BTDocument; error?: ParseError } {
  let dom;
  try {
    dom = new DOMParser({ onError: () => {} }).parseFromString(text, 'text/xml');
  } catch (e) {
    const err = e as { message: string; locator?: { lineNumber?: number } };
    const line = err.locator?.lineNumber || undefined;
    return { error: { message: `XML syntax error: ${err.message.split('\n')[0]}`, line } };
  }
  const root = dom.documentElement as unknown as XElement | null;
  if (!root) return { error: { message: 'The file has no root element' } };
  if (root.tagName !== 'root') {
    return { error: { message: `The root element must be <root>, not <${root.tagName}>`, line: root.lineNumber } };
  }

  const items: DocItem[] = [];
  for (const child of elements(root)) {
    if (child.nodeType === COMMENT_NODE) {
      items.push({ kind: 'comment', text: child.nodeValue ?? '' });
    } else if (child.nodeType === ELEMENT_NODE) {
      const el = child as XElement;
      if (el.tagName === 'BehaviorTree') items.push({ kind: 'tree', tree: parseTree(el) });
      else if (el.tagName === 'TreeNodesModel') items.push({ kind: 'models', models: parseModels(el) });
      else items.push({ kind: 'raw', xml: new XMLSerializer().serializeToString(el as never) });
    }
  }
  // Comments outside <root>: before it, or after it.
  const prolog: string[] = [];
  const epilog: string[] = [];
  let seenRoot = false;
  for (const child of Array.from(dom.childNodes as unknown as ArrayLike<XNode>)) {
    if (child === (root as XNode)) seenRoot = true;
    else if (child.nodeType === COMMENT_NODE) (seenRoot ? epilog : prolog).push(child.nodeValue ?? '');
  }
  const doc: BTDocument = { rootAttrs: attributes(root), items };
  if (prolog.length) doc.prolog = prolog;
  if (epilog.length) doc.epilog = epilog;
  return { doc };
}

/** Parses the element children of `el`, attaching comments to the next one. */
function parseChildren(el: XNode): { children: BTNode[]; trailing: string[] } {
  const children: BTNode[] = [];
  let comments: string[] = [];
  for (const child of elements(el)) {
    if (child.nodeType === COMMENT_NODE) {
      comments.push(child.nodeValue ?? '');
    } else if (child.nodeType === ELEMENT_NODE) {
      const node = parseNode(child as XElement);
      if (comments.length) node.comments = comments;
      comments = [];
      children.push(node);
    }
  }
  return { children, trailing: comments };
}

function parseTree(el: XElement): BehaviorTreeDef {
  const attrs = attributes(el);
  const id = attrs.ID ?? '';
  delete attrs.ID;
  const { children, trailing } = parseChildren(el);
  const tree: BehaviorTreeDef = { uid: newUid(), id, attrs, children, line: el.lineNumber };
  if (trailing.length) tree.trailingComments = trailing;
  return tree;
}

function parseNode(el: XElement): BTNode {
  const attrs = attributes(el);
  let id = el.tagName;
  if (EXPLICIT_TAGS.has(el.tagName) && attrs.ID !== undefined) {
    id = attrs.ID;
    delete attrs.ID;
  }
  const { children, trailing } = parseChildren(el);
  const node: BTNode = { uid: newUid(), id, tag: el.tagName, attrs, children, line: el.lineNumber };
  if (trailing.length) node.trailingComments = trailing;
  return node;
}

function parseModels(el: XElement): NodeModel[] {
  const models: NodeModel[] = [];
  for (const child of elements(el)) {
    if (child.nodeType !== ELEMENT_NODE) continue;
    const m = child as XElement;
    if (!MODEL_TAGS.has(m.tagName)) continue;
    const extra = attributes(m);
    const id = extra.ID ?? '';
    delete extra.ID;
    const model: NodeModel = { id, category: m.tagName as NodeCategory, ports: [] };
    if (Object.keys(extra).length) model.extra = extra;
    for (const p of elements(m)) {
      if (p.nodeType !== ELEMENT_NODE) continue;
      const pe = p as XElement;
      const dir = /^(input|output|inout)_port$/.exec(pe.tagName);
      if (dir) {
        const pa = attributes(pe);
        const port: PortModel = { direction: dir[1] as PortDirection, name: pa.name ?? '' };
        if (pa.type !== undefined) port.type = pa.type;
        if (pa.default !== undefined) port.default = pa.default;
        const text = pe.textContent?.trim();
        if (text) port.description = text;
        delete pa.name; delete pa.type; delete pa.default;
        if (Object.keys(pa).length) port.extra = pa;
        model.ports.push(port);
      } else if (pe.tagName === 'description') {
        model.description = pe.textContent?.trim() ?? '';
      } else {
        (model.extraXml ??= []).push(new XMLSerializer().serializeToString(pe as never));
      }
    }
    models.push(model);
  }
  return models;
}

// ---------------------------------------------------------------------------
// Writing

export function escapeAttr(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/\n/g, '&#10;')
    .replace(/\t/g, '&#9;');
}

function escapeText(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function attrString(attrs: Record<string, string>): string {
  return Object.entries(attrs).map(([k, v]) => ` ${k}="${escapeAttr(v)}"`).join('');
}

const INDENT = '  ';

function writeComments(out: string[], comments: string[] | undefined, depth: number) {
  for (const c of comments ?? []) out.push(`${INDENT.repeat(depth)}<!--${c}-->`);
}

/** The attributes of a node as written, including ID for the explicit form. */
export function nodeXmlAttrs(node: BTNode): Record<string, string> {
  if (node.tag !== node.id && EXPLICIT_TAGS.has(node.tag)) return { ID: node.id, ...node.attrs };
  return node.attrs;
}

function writeNode(out: string[], node: BTNode, depth: number) {
  writeComments(out, node.comments, depth);
  const pad = INDENT.repeat(depth);
  const open = `${pad}<${node.tag}${attrString(nodeXmlAttrs(node))}`;
  if (node.children.length === 0 && !node.trailingComments?.length) {
    out.push(`${open}/>`);
  } else {
    out.push(`${open}>`);
    for (const c of node.children) writeNode(out, c, depth + 1);
    writeComments(out, node.trailingComments, depth + 1);
    out.push(`${pad}</${node.tag}>`);
  }
}

export function writeTree(out: string[], tree: BehaviorTreeDef, depth: number) {
  const pad = INDENT.repeat(depth);
  const open = `${pad}<BehaviorTree${attrString({ ID: tree.id, ...tree.attrs })}`;
  if (tree.children.length === 0 && !tree.trailingComments?.length) {
    out.push(`${open}/>`);
    return;
  }
  out.push(`${open}>`);
  for (const c of tree.children) writeNode(out, c, depth + 1);
  writeComments(out, tree.trailingComments, depth + 1);
  out.push(`${pad}</BehaviorTree>`);
}

export function writeModel(out: string[], model: NodeModel, depth: number) {
  const pad = INDENT.repeat(depth);
  const open = `${pad}<${model.category}${attrString({ ID: model.id, ...model.extra })}`;
  if (!model.ports.length && !model.description && !model.extraXml?.length) {
    out.push(`${open}/>`);
    return;
  }
  out.push(`${open}>`);
  for (const p of model.ports) {
    const attrs: Record<string, string> = { name: p.name };
    if (p.type !== undefined) attrs.type = p.type;
    if (p.default !== undefined) attrs.default = p.default;
    Object.assign(attrs, p.extra);
    const tag = `${p.direction}_port`;
    out.push(p.description
      ? `${pad}${INDENT}<${tag}${attrString(attrs)}>${escapeText(p.description)}</${tag}>`
      : `${pad}${INDENT}<${tag}${attrString(attrs)}/>`);
  }
  if (model.description) out.push(`${pad}${INDENT}<description>${escapeText(model.description)}</description>`);
  for (const x of model.extraXml ?? []) out.push(`${pad}${INDENT}${x}`);
  out.push(`${pad}</${model.category}>`);
}

export function serializeDocument(doc: BTDocument): string {
  const out: string[] = ['<?xml version="1.0" encoding="UTF-8"?>'];
  for (const c of doc.prolog ?? []) out.push(`<!--${c}-->`);
  out.push(`<root${attrString(doc.rootAttrs)}>`);
  let previous: DocItem['kind'] | undefined;
  for (const item of doc.items) {
    // A blank line between top-level elements, but keep a comment next to the
    // element it describes.
    if (previous && previous !== 'comment') out.push('');
    switch (item.kind) {
      case 'comment':
        out.push(`${INDENT}<!--${item.text}-->`);
        break;
      case 'tree':
        writeTree(out, item.tree, 1);
        break;
      case 'models':
        out.push(`${INDENT}<TreeNodesModel>`);
        for (const m of item.models) writeModel(out, m, 2);
        out.push(`${INDENT}</TreeNodesModel>`);
        break;
      case 'raw':
        out.push(`${INDENT}${item.xml}`);
        break;
    }
    previous = item.kind;
  }
  out.push('</root>');
  for (const c of doc.epilog ?? []) out.push(`<!--${c}-->`);
  out.push('');
  return out.join('\n');
}

/** A new tree, with a Sequence as its root, ready for nodes to be added to it. */
export function newTree(treeId: string): BehaviorTreeDef {
  const root: BTNode = { uid: newUid(), id: 'Sequence', tag: 'Sequence', attrs: {}, children: [] };
  return { uid: newUid(), id: treeId, attrs: {}, children: [root] };
}

/**
 * A new file with one tree: an objective, its main tree, or a subtree, which
 * only runs when another tree includes it.
 */
export function newDocument(treeId: string, objective = true): BTDocument {
  return {
    rootAttrs: objective ? { BTCPP_format: '4', main_tree_to_execute: treeId } : { BTCPP_format: '4' },
    items: [{ kind: 'tree', tree: newTree(treeId) }],
  };
}

export function trees(doc: BTDocument): BehaviorTreeDef[] {
  return doc.items.flatMap((i) => (i.kind === 'tree' ? [i.tree] : []));
}

export function models(doc: BTDocument): NodeModel[] {
  return doc.items.flatMap((i) => (i.kind === 'models' ? i.models : []));
}

/** Whether a header comment says the file is generated, e.g. from the C++ nodes, and not to be edited by hand. */
export function isGenerated(doc: BTDocument | undefined): boolean {
  return !!doc?.prolog?.some((c) => /\bgenerated\b/i.test(c));
}
