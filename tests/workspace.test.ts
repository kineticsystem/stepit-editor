import { describe, expect, it } from 'vitest';
import { fileNameFor, filePathError, idError } from '../src/shared/ids';
import {
  buildWorkspace, categoryOf, defaultModelsFile, findTree, isObjective, referencesTo, subtreeCount, subtreeRefs, usageCount,
  usagesOf,
} from '../src/shared/workspace';
import { parseDocument } from '../src/shared/xml';

const files = (entries: Record<string, string>) =>
  Object.entries(entries).map(([path, xml]) => ({ path, ...parseDocument(`<root BTCPP_format="4">${xml}</root>`) }));

const WORKSPACE = files({
  'a.xml': `<BehaviorTree ID="A"><Sequence><MoveTo/><SubTree ID="B"/><MoveTo/></Sequence></BehaviorTree>`,
  'b.xml': `<BehaviorTree ID="B"><Sequence><Action ID="Grip"/><MoveTo/></Sequence></BehaviorTree>`,
  'models.xml': `<TreeNodesModel><Action ID="MoveTo"/><Action ID="Home"/></TreeNodesModel>`,
});

describe('the workspace', () => {
  const ws = buildWorkspace(WORKSPACE);

  it('indexes the trees and the models of every file', () => {
    expect(findTree(ws, 'B')?.file).toBe('b.xml');
    expect([...ws.models.keys()]).toEqual(['MoveTo', 'Home']);
    expect(ws.models.get('MoveTo')?.file).toBe('models.xml');
  });

  it('knows the category of declared nodes and of undeclared ones in the explicit form', () => {
    const [seq] = findTree(ws, 'B')!.tree.children;
    expect(seq.children.map((n) => categoryOf(ws, n))).toEqual(['Action', 'Action']);
    expect(categoryOf(ws, seq)).toBe('Control');
  });

  it('finds where trees and node types are used', () => {
    expect(referencesTo(ws, 'B').map((r) => r.tree.id)).toEqual(['A']);
    expect(subtreeRefs(findTree(ws, 'A')!.tree.children).map((n) => n.attrs.ID)).toEqual(['B']);
    expect(usagesOf(ws, 'MoveTo').map((u) => [u.ref.tree.id, u.nodes.length])).toEqual([['A', 2], ['B', 1]]);
    expect(usageCount(ws, 'MoveTo')).toBe(3);
    expect(usageCount(ws, 'Home')).toBe(0);
  });

  it('counts the SubTree nodes that include a tree', () => {
    expect(subtreeCount(ws, 'B')).toBe(1);
    expect(subtreeCount(ws, 'A')).toBe(0);
  });

  it('declares new node types in the file that declares the most', () => {
    expect(defaultModelsFile(WORKSPACE, 'a.xml')).toBe('models.xml');
    expect(defaultModelsFile(files({ 'a.xml': '', 'b.xml': '' }), 'b.xml')).toBe('b.xml');
  });
});

describe('objectives and subtrees', () => {
  const doc = (root: string) => parseDocument(`<root BTCPP_format="4"${root}><BehaviorTree ID="A"><AlwaysSuccess/></BehaviorTree></root>`).doc;

  it('makes the main tree of a file an objective, and any other tree a subtree', () => {
    expect(isObjective(doc(' main_tree_to_execute="A"'), 'A')).toBe(true);
    expect(isObjective(doc(' main_tree_to_execute="B"'), 'A')).toBe(false);
    // Even alone in its file: only main_tree_to_execute makes an objective.
    expect(isObjective(doc(''), 'A')).toBe(false);
  });
});

describe('IDs and file names', () => {
  it('checks new IDs', () => {
    expect(idError('Pick_1.a-b')).toBeUndefined();
    expect(idError('1Pick')).toMatch(/not starting with a digit/);
    expect(idError('Pick', ['Pick'])).toBe('A tree with this ID already exists');
  });

  it('derives a file name from a tree ID', () => {
    expect(fileNameFor('', 'PickObject')).toBe('pick_object.xml');
    expect(fileNameFor(' sub/my ', 'X')).toBe('sub/my.xml');
  });

  it('checks the path of a new file', () => {
    expect(filePathError('sub/a.xml')).toBeUndefined();
    expect(filePathError('../a.xml')).toBe('Use a relative .xml path');
    expect(filePathError('/a.xml')).toBe('Use a relative .xml path');
    expect(filePathError('a.xml', ['a.xml'])).toBe('This file already exists');
  });
});
