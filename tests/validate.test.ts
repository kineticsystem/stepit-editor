import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { Issue } from '../src/shared/types';
import { type Rule, validateFiles, validateWorkspace } from '../src/shared/validate';
import { buildWorkspace } from '../src/shared/workspace';
import { prettyType } from '../src/shared/builtins';
import { parseDocument } from '../src/shared/xml';

const EXAMPLES = join(__dirname, '../behaviors');

const MODELS = `<TreeNodesModel>
  <Action ID="MoveTo">
    <input_port name="goal"/>
    <input_port name="speed" type="double" default="0.5"/>
    <output_port name="reached" type="bool"/>
  </Action>
</TreeNodesModel>`;

function check(files: Record<string, string>): Issue[] {
  return validateFiles(Object.entries(files).map(([path, content]) => ({ path, ...parseDocument(content) })));
}

/** Validates a single tree, with the MoveTo model available. */
function checkTree(body: string, extra = ''): string[] {
  return check({
    'a.xml': `<root BTCPP_format="4" main_tree_to_execute="T"><BehaviorTree ID="T">${body}</BehaviorTree>${extra}${MODELS}</root>`,
  }).map((i) => `${i.severity}: ${i.message}`);
}

describe('validateFiles', () => {
  it('accepts the examples', () => {
    const files = readdirSync(EXAMPLES).filter((f) => f.endsWith('.xml'));
    const issues = check(Object.fromEntries(files.map((f) => [f, readFileSync(join(EXAMPLES, f), 'utf8')])));
    expect(issues).toEqual([]);
  });

  it('accepts a correct tree', () => {
    expect(checkTree('<Sequence><MoveTo goal="{g}" reached="{r}"/><AlwaysSuccess/></Sequence>')).toEqual([]);
  });

  it('reports syntax errors', () => {
    expect(check({ 'a.xml': '<root><BehaviorTree ID="T"></root>' })[0].message).toMatch(/syntax error/);
  });

  it('reports empty trees and several roots', () => {
    expect(checkTree('')).toContain('error: The tree "T" is empty: it needs exactly one root node');
    expect(checkTree('<AlwaysSuccess/><AlwaysFailure/>')).toContain(
      'error: The tree "T" has 2 root nodes: it needs exactly one');
  });

  it('reports unknown nodes', () => {
    expect(checkTree('<Fly/>')[0]).toMatch(/^error: Unknown node "Fly"/);
  });

  it('checks the number of children', () => {
    expect(checkTree('<Sequence/>')).toContain('error: Control "Sequence" must have at least 1 child, but has 0');
    expect(checkTree('<Inverter><AlwaysSuccess/><AlwaysSuccess/></Inverter>')).toContain(
      'error: Decorator "Inverter" must have exactly 1 child, but has 2');
    expect(checkTree('<AlwaysSuccess><AlwaysSuccess/></AlwaysSuccess>')).toContain(
      'error: Action "AlwaysSuccess" must have no children, but has 1');
    expect(checkTree('<IfThenElse><AlwaysSuccess/></IfThenElse>')).toContain(
      'error: Control "IfThenElse" must have 2 to 3 children, but has 1');
  });

  it('checks ports', () => {
    expect(checkTree('<MoveTo goal="{g}" height="3"/>')).toContain('error: "MoveTo" has no port "height"');
    expect(checkTree('<MoveTo/>')).toContain(
      'warning: The input port "goal" of "MoveTo" is not set and has no default');
    expect(checkTree('<MoveTo goal="{g}" speed="fast"/>')).toContain(
      'error: The port "speed" of "MoveTo" expects a number (double), not "fast"');
    expect(checkTree('<MoveTo goal="{g}" reached="yes"/>')).toContain(
      'error: The output port "reached" of "MoveTo" must be a blackboard reference such as {reached}');
    expect(checkTree('<MoveTo goal="{}"/>')).toContain(
      'error: The port "goal" of "MoveTo" refers to an empty blackboard key');
    expect(checkTree('<Repeat num_cycles="x"><AlwaysSuccess/></Repeat>')).toContain(
      'error: The port "num_cycles" of "Repeat" expects an integer (int), not "x"');
  });

  it('accepts the common attributes', () => {
    expect(checkTree('<AlwaysSuccess name="ok" _skipIf="a == 1" _onSuccess="b := 2"/>')).toEqual([]);
    expect(checkTree('<AlwaysSuccess _bogus="1"/>')).toContain('warning: Unknown special attribute "_bogus"');
  });

  it('checks subtrees', () => {
    expect(checkTree('<SubTree ID="Nope"/>')).toContain('error: The SubTree refers to the unknown tree "Nope"');
    expect(checkTree('<SubTree/>')).toContain('error: A SubTree has no ID: it must name the tree to instantiate');
    expect(checkTree('<SubTree ID="T"/>')).toContain('error: Recursive SubTree: T → T');
    expect(checkTree('<SubTree ID="U" a="{a}" b="{b}"/>',
      '<BehaviorTree ID="U"><AlwaysSuccess/></BehaviorTree><TreeNodesModel><SubTree ID="U"><input_port name="a"/></SubTree></TreeNodesModel>',
    )).toEqual(['warning: The tree "U" does not declare the port "b" in its TreeNodesModel']);
  });

  it('reports a payload entry that a tree with a model does not declare', () => {
    const declares = (ports: string) => `<TreeNodesModel><SubTree ID="T">${ports}</SubTree></TreeNodesModel>`;
    const body = '<MoveTo goal="{@goal}" speed="{@speed}"/>';
    expect(checkTree(body, declares('<input_port name="goal"/><input_port name="speed"/>'))).toEqual([]);
    expect(checkTree(body, declares('<input_port name="goal"/>')))
      .toEqual(['warning: The tree "T" reads @speed, which its TreeNodesModel does not declare']);
    expect(checkTree(body)).toEqual([
      'info: The tree "T" reads @goal, @speed but does not describe them: declare them as the ports of <SubTree ID="T"> in a TreeNodesModel',
    ]);
    expect(checkTree('<MoveTo goal="{goal}"/>')).toEqual([]);
  });

  it('finds indirect recursion across files', () => {
    const issues = check({
      'a.xml': '<root BTCPP_format="4"><BehaviorTree ID="A"><SubTree ID="B"/></BehaviorTree></root>',
      'b.xml': '<root BTCPP_format="4"><BehaviorTree ID="B"><SubTree ID="A"/></BehaviorTree></root>',
    });
    expect(issues.map((i) => i.message)).toEqual(['Recursive SubTree: A → B → A']);
  });

  it('reports duplicate tree IDs across files', () => {
    const tree = '<root BTCPP_format="4" main_tree_to_execute="A"><BehaviorTree ID="A"><AlwaysSuccess/></BehaviorTree></root>';
    const issues = check({ 'a.xml': tree, 'b.xml': tree });
    expect(issues.map((i) => `${i.file}: ${i.message}`)).toEqual([
      'a.xml: The tree ID "A" is defined 2 times (a.xml, b.xml)',
      'b.xml: The tree ID "A" is defined 2 times (a.xml, b.xml)',
    ]);
  });

  it('checks the root attributes', () => {
    expect(check({ 'a.xml': '<root BTCPP_format="3" main_tree_to_execute="A"><BehaviorTree ID="A"><AlwaysSuccess/></BehaviorTree></root>' })
      .map((i) => i.message)).toEqual(['BTCPP_format="3" is not supported: BehaviorTree.CPP 4 reads format 4 only']);
    // A is not the main tree, which names a tree that does not exist, so A is a subtree nothing includes.
    expect(check({ 'a.xml': '<root BTCPP_format="4" main_tree_to_execute="X"><BehaviorTree ID="A"><AlwaysSuccess/></BehaviorTree></root>' })
      .map((i) => i.message)).toEqual([
      'main_tree_to_execute refers to the unknown tree "X"',
      'The subtree "A" never runs: no tree includes it, and it is not the main tree of its file',
    ]);
  });

  it('reports a subtree that no tree includes, since it never runs', () => {
    const objective = '<root BTCPP_format="4" main_tree_to_execute="Main"><BehaviorTree ID="Main"><SubTree ID="Used"/></BehaviorTree></root>';
    const subtree = (id: string) => `<root BTCPP_format="4"><BehaviorTree ID="${id}"><AlwaysSuccess/></BehaviorTree></root>`;
    expect(check({ 'main.xml': objective, 'used.xml': subtree('Used'), 'unused.xml': subtree('Unused') })
      .map((i) => `${i.severity}: ${i.file}: ${i.message}`)).toEqual([
      'warning: unused.xml: The subtree "Unused" never runs: no tree includes it, and it is not the main tree of its file',
    ]);
  });

  it('reports models that redefine built-in nodes', () => {
    expect(check({ 'a.xml': '<root BTCPP_format="4"><TreeNodesModel><Action ID="Sequence"/></TreeNodesModel></root>' })
      .map((i) => i.message)).toEqual(['The model "Sequence" redefines a built-in node of BehaviorTree.CPP']);
  });
});

describe('issues', () => {
  const issuesOf = (body: string) => check({
    'a.xml': `<root BTCPP_format="4" main_tree_to_execute="T"><BehaviorTree ID="T">${body}</BehaviorTree>${MODELS}</root>`,
  });

  it('name the attribute at fault, to mark its field', () => {
    const byMessage = Object.fromEntries(issuesOf('<MoveTo height="3" speed="fast" _bogus="" _onSuccess=" "/>')
      .map((i) => [i.message, i.attribute]));
    expect(byMessage).toEqual({
      '"MoveTo" has no port "height"': 'height',
      'The port "speed" of "MoveTo" expects a number (double), not "fast"': 'speed',
      'Unknown special attribute "_bogus"': '_bogus',
      'The input port "goal" of "MoveTo" is not set and has no default': 'goal',
      'The script _onSuccess is empty': '_onSuccess',
    });
  });

  it('about the node itself name no attribute', () => {
    const [issue] = issuesOf('<Fly/>');
    expect(issue.attribute).toBeUndefined();
    expect(issue.nodeUid).toBeDefined();
  });
});

describe('rules', () => {
  it('can be replaced or extended', () => {
    const noSleep: Rule = {
      node: (ctx, { file, node, at }) => {
        if (node.id === 'Sleep') ctx.add('warning', file, 'Sleeping on the job', at);
      },
    };
    const ws = buildWorkspace([{ path: 'a.xml', ...parseDocument('<root><BehaviorTree ID="T"><Sleep/></BehaviorTree></root>') }]);
    expect(validateWorkspace(ws, [noSleep]).map((i) => i.message)).toEqual(['Sleeping on the job']);
  });
});

describe('the broken fixtures', () => {
  it('report every problem, not just the first', () => {
    const dir = join(__dirname, 'fixtures/broken');
    const files = readdirSync(dir).map((f) => ({ path: f, ...parseDocument(readFileSync(join(dir, f), 'utf8')) }));
    const messages = validateFiles(files).map((i) => `${i.file}: ${i.message}`);
    expect(messages).toHaveLength(7);
    expect(messages).toContain('syntax.xml: XML syntax error: Opening and ending tag mismatch: "Sequence" != "BehaviorTree"');
    expect(messages).toContain('bad.xml: Recursive SubTree: Bad → Loop → Bad');
  });
});

describe('prettyType', () => {
  it('shortens the demangled standard types', () => {
    expect(prettyType('std::vector<std::__cxx11::basic_string<char, std::char_traits<char>, std::allocator<char> >, '
      + 'std::allocator<std::__cxx11::basic_string<char, std::char_traits<char>, std::allocator<char> > > >'))
      .toBe('std::vector<std::string>');
    expect(prettyType('std::vector<double, std::allocator<double> >')).toBe('std::vector<double>');
    expect(prettyType('double')).toBe('double');
  });
});
