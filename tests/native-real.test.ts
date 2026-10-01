// The native validator itself, built against the real BehaviorTree.CPP. CI
// builds it and sets BTCPP_VALIDATOR_REAL to its path; without it, e.g. on a
// laptop where it is not built, these tests are skipped, and native.test.ts
// covers the editor's side with a fake validator.

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { nativeBuiltins, validateNative } from '../src/server/native';

const REAL = process.env.BTCPP_VALIDATOR_REAL;

const tree = (body: string, extra = '') =>
  `<root BTCPP_format="4" main_tree_to_execute="Main"><BehaviorTree ID="Main">${body}</BehaviorTree>${extra}</root>`;

describe.runIf(REAL)('the native validator, built against BehaviorTree.CPP', () => {
  beforeEach(() => {
    process.env.BTCPP_VALIDATOR = REAL;
  });
  afterEach(() => {
    delete process.env.BTCPP_VALIDATOR;
  });

  it('accepts a valid tree', async () => {
    const result = await validateNative([{ path: 'ok.xml', content: tree('<Sequence><AlwaysSuccess/></Sequence>') }]);
    expect(result).toMatchObject({ available: true, issues: [] });
    expect(result.output).toBeUndefined();
  });

  it('accepts a node declared in a TreeNodesModel', async () => {
    const content = tree('<MoveTo goal="1"/>', '<TreeNodesModel><Action ID="MoveTo"><input_port name="goal"/></Action></TreeNodesModel>');
    expect((await validateNative([{ path: 'model.xml', content }])).issues).toEqual([]);
  });

  it('rejects a node that no model declares', async () => {
    const { issues } = await validateNative([{ path: 'unknown.xml', content: tree('<MoveTo/>') }]);
    expect(issues).toEqual([{
      severity: 'error', file: 'unknown.xml', message: expect.stringContaining('Node not recognized: MoveTo'), source: 'btcpp',
    }]);
  });

  it('rejects a SubTree of a tree that does not exist', async () => {
    const { issues } = await validateNative([{ path: 'missing.xml', content: tree('<SubTree ID="Missing"/>') }]);
    expect(issues).toEqual([{
      severity: 'error', file: 'missing.xml', tree: 'Main', message: "Can't find a tree with name: Missing", source: 'btcpp',
    }]);
  });

  it('rejects a file that is not well-formed XML', async () => {
    const { issues } = await validateNative([{ path: 'syntax.xml', content: tree('<Sequence>') }]);
    expect(issues).toEqual([{
      severity: 'error', file: 'syntax.xml', message: expect.stringMatching(/^Error parsing the XML/), source: 'btcpp',
    }]);
  });

  it('reports the built-in nodes of the library', async () => {
    const builtins = await nativeBuiltins();
    const ids = builtins?.map((m) => m.id) ?? [];
    expect(ids).toEqual(expect.arrayContaining(['Sequence', 'Fallback', 'Repeat', 'SubTree', 'AlwaysSuccess']));
    // The ports come from the library, the descriptions from the editor's list.
    expect(builtins?.find((m) => m.id === 'Repeat')).toMatchObject({
      category: 'Decorator',
      builtin: true,
      ports: [{ name: 'num_cycles', direction: 'input', type: 'int', description: expect.stringContaining('Repeat') }],
    });
  });
});
