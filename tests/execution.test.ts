import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  executionKey, executionRows, failedNodeUid, failureCauses, outcomeLabel, parseExecutedTree, parseFeedback, progressLabel,
} from '../src/client/execution';

vi.mock('../src/client/api', async (original) => {
  const actual = await original<typeof import('../src/client/api')>();
  const { makeFakeApi } = await import('./fakeServer');
  return { ...actual, api: makeFakeApi(actual.ApiError) };
});

const { useStore } = await import('../src/client/store');

// As BT::WriteTreeToXML writes it, for a tree that calls the subtree Inner twice.
const EXECUTED = `<root BTCPP_format="4">
    <BehaviorTree ID="Main" _fullpath="">
        <Sequence name="top" _uid="1">
            <SubTree ID="Inner" _fullpath="Inner::2" _uid="2"/>
            <SubTree ID="Inner" _fullpath="Inner::6" _uid="6"/>
            <AlwaysSuccess name="AlwaysSuccess" _uid="10"/>
        </Sequence>
    </BehaviorTree>
    <BehaviorTree ID="Inner" _fullpath="Inner::2">
        <Fallback name="Fallback" _uid="3">
            <AlwaysFailure name="AlwaysFailure" _uid="4"/>
            <AlwaysSuccess name="AlwaysSuccess" _uid="5"/>
        </Fallback>
    </BehaviorTree>
    <BehaviorTree ID="Inner" _fullpath="Inner::6">
        <Fallback name="Fallback" _uid="7">
            <AlwaysFailure name="AlwaysFailure" _uid="8"/>
            <AlwaysSuccess name="AlwaysSuccess" _uid="9"/>
        </Fallback>
    </BehaviorTree>
    <TreeNodesModel/>
</root>`;

describe('parseFeedback', () => {
  it('reads the progress of the nodes that report one', () => {
    expect(parseFeedback('{"nodes": {}, "progress": {"3": {"done": 2, "total": 11}}}')?.progress)
      .toEqual({ 3: { done: 2, total: 11 } });
  });

  it('drops a progress that is not one', () => {
    expect(parseFeedback('{"nodes": {}, "progress": {"1": {"done": 1, "total": 0}, "2": {"done": "a", "total": 3}, "3": 5}}')?.progress)
      .toEqual({});
    expect(parseFeedback('{"nodes": {}}')?.progress).toBeUndefined();
  });

  it('reads the tree and the statuses', () => {
    expect(parseFeedback(JSON.stringify({ tree: '<root/>', nodes: { 1: 'RUNNING', 2: 'FAILURE' } })))
      .toEqual({ tree: '<root/>', nodes: { 1: 'RUNNING', 2: 'FAILURE' } });
  });

  it('reads a halted node', () => {
    expect(parseFeedback('{"nodes": {"7": "HALTED"}}')?.nodes).toEqual({ 7: 'HALTED' });
  });

  it('leaves out unknown statuses', () => {
    expect(parseFeedback('{"nodes": {"1": "IDLE", "2": "SUCCESS", "3": 4}}')).toEqual({ tree: undefined, nodes: { 2: 'SUCCESS' } });
  });

  it('refuses anything else, e.g. plain text', () => {
    expect(parseFeedback('moving joint1')).toBeUndefined();
    expect(parseFeedback('"a string"')).toBeUndefined();
    expect(parseFeedback('{"message": "hello"}')).toBeUndefined();
    expect(parseFeedback('{"nodes": {}, "tree": 3}')).toBeUndefined();
  });
});

describe('failedNodeUid', () => {
  it('finds the node that threw in the message of the server', () => {
    expect(failedNodeUid("Behavior Tree exception:Exception in node 'TrapezoidalTrajectory::20' [TrapezoidalTrajectory]: "
      + 'getInput() failed')).toBe('20');
    expect(failedNodeUid('Tree finished with status: FAILURE')).toBeUndefined();
  });
});

describe('the executed tree', () => {
  const tree = parseExecutedTree(EXECUTED)!;

  it('expands each instance of a subtree on its own', () => {
    const rows = executionRows(tree, new Set());
    expect(rows.map((r) => [r.key, r.node.id, r.depth])).toEqual([
      ['1', 'Sequence', 0],
      ['2', 'SubTree', 1], ['3', 'Fallback', 2], ['4', 'AlwaysFailure', 3], ['5', 'AlwaysSuccess', 3],
      ['6', 'SubTree', 1], ['7', 'Fallback', 2], ['8', 'AlwaysFailure', 3], ['9', 'AlwaysSuccess', 3],
      ['10', 'AlwaysSuccess', 1],
    ]);
    expect(rows.find((r) => r.key === '3')?.parentKey).toBe('2');
  });

  it('hides what is below a collapsed row', () => {
    const rows = executionRows(tree, new Set(['2']));
    expect(rows.map((r) => r.key)).toEqual(['1', '2', '6', '7', '8', '9', '10']);
    expect(rows[1]).toMatchObject({ expandable: true, open: false });
  });

  it('marks a disabled node and everything below it', () => {
    const disabled = parseExecutedTree(EXECUTED.replace('<SubTree ID="Inner" _fullpath="Inner::6" _uid="6"/>',
      '<SubTree ID="Inner" _fullpath="Inner::6" _uid="6" _skipIf="true"/>'))!;
    const rows = executionRows(disabled, new Set());
    expect(rows.filter((r) => r.disabled).map((r) => r.key)).toEqual(['6', '7', '8', '9']);
  });

  it('tells the failures that made the run fail from those recovered from', () => {
    // The first Fallback recovers from its AlwaysFailure; the second does not.
    const statuses: Record<string, string> = {
      1: 'FAILURE', 2: 'SUCCESS', 3: 'SUCCESS', 4: 'FAILURE', 5: 'SUCCESS', 6: 'FAILURE', 7: 'FAILURE', 8: 'FAILURE', 9: 'FAILURE',
    };
    const causes = failureCauses(tree, (node) => statuses[executionKey(node)] as never);
    expect(causes.map(executionKey)).toEqual(['8', '9']);
  });

  it('does not count a halted node as a failure', () => {
    const statuses: Record<string, string> = { 1: 'FAILURE', 2: 'HALTED', 3: 'HALTED', 6: 'FAILURE', 7: 'FAILURE', 8: 'FAILURE' };
    expect(failureCauses(tree, (node) => statuses[executionKey(node)] as never).map(executionKey)).toEqual(['8']);
  });

  it('refuses a document that is not XML', () => {
    expect(parseExecutedTree('not xml')).toBeUndefined();
  });
});

describe('progressLabel', () => {
  it('counts a whole number of steps, and gives a percentage otherwise', () => {
    expect(progressLabel({ done: 3, total: 11 })).toBe('3 / 11');
    expect(progressLabel({ done: 2.1, total: 5 })).toBe('42%');
  });
});

describe('the execution in the store', () => {
  const s = () => useStore.getState();
  beforeEach(() => useStore.setState({ execution: undefined, executionShown: false, toasts: [] }));

  it('shows the execution when a run starts, and gathers the statuses', () => {
    s().startExecution('Main');
    expect(s().executionShown).toBe(true);
    s().applyFeedback(JSON.stringify({ tree: EXECUTED, nodes: { 1: 'RUNNING', 2: 'RUNNING' } }));
    s().applyFeedback(JSON.stringify({ nodes: { 2: 'SUCCESS', 4: 'FAILURE' } }));
    s().applyFeedback('a plain message');
    expect(s().execution?.tree?.root.id).toBe('Main');
    expect(s().execution?.statuses).toEqual({ 1: 'RUNNING', 2: 'SUCCESS', 4: 'FAILURE' });
    expect(s().execution?.messages).toEqual(['a plain message']);
  });

  it('keeps the last progress of each node, and forgets it when the run ends', () => {
    s().startExecution('Main');
    s().applyFeedback(JSON.stringify({ tree: EXECUTED, nodes: { 1: 'RUNNING' }, progress: { 1: { done: 0, total: 3 } } }));
    s().applyFeedback(JSON.stringify({ nodes: {}, progress: { 1: { done: 1, total: 3 } } }));
    s().applyFeedback(JSON.stringify({ nodes: { 2: 'SUCCESS' } }));
    expect(s().execution?.progress).toEqual({ 1: { done: 1, total: 3 } });
    s().endExecution({ ok: true, outcome: 'succeeded', message: '' });
    expect(s().execution?.progress).toEqual({});
  });

  it('marks the nodes still running when the run ends as halted', () => {
    s().startExecution('Main');
    s().applyFeedback(JSON.stringify({ tree: EXECUTED, nodes: { 1: 'RUNNING', 2: 'SUCCESS', 3: 'RUNNING' } }));
    s().endExecution({ ok: false, outcome: 'canceled', message: '' });
    expect(s().execution?.statuses).toEqual({ 1: 'HALTED', 2: 'SUCCESS', 3: 'HALTED' });
  });

  it('marks the node that threw as failed', () => {
    s().startExecution('Main');
    s().endExecution({ ok: false, outcome: 'aborted', message: "Exception in node 'AlwaysSuccess::10' [AlwaysSuccess]: boom" });
    expect(s().execution?.crashed).toBe('10');
    expect(outcomeLabel(s().execution!.result!)).toBe('Aborted');
  });

  it('ignores feedback after the end, and says how it ended when not shown', () => {
    s().startExecution('Main');
    s().showExecution(false);
    s().endExecution({ ok: false, outcome: 'canceled', message: '' });
    s().applyFeedback(JSON.stringify({ nodes: { 1: 'SUCCESS' } }));
    expect(s().execution?.statuses).toEqual({});
    expect(s().toasts.at(-1)?.message).toBe('Main: stopped');
  });
});
