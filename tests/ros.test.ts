import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cancelAllGoals, EXECUTE_TREE, FOLLOW_RETRY_MS, followExecution, REQUEST_TIMEOUT_MS, runTree } from '../src/client/ros';

/** A WebSocket that records what is sent, and lets the test answer. */
class FakeSocket {
  static OPEN = 1;
  static last: FakeSocket;
  readyState = 0;
  sent: Record<string, unknown>[] = [];
  onopen?: () => void;
  onerror?: () => void;
  onclose?: () => void;
  onmessage?: (e: { data: string }) => void;
  constructor(public url: string) {
    FakeSocket.last = this;
  }
  send(data: string) {
    this.sent.push(JSON.parse(data));
  }
  close() {
    this.readyState = 3;
  }
  open() {
    this.readyState = FakeSocket.OPEN;
    this.onopen?.();
  }
  receive(msg: Record<string, unknown>) {
    this.onmessage?.({ data: JSON.stringify(msg) });
  }
}

describe('running a tree through rosbridge', () => {
  beforeEach(() => vi.stubGlobal('WebSocket', FakeSocket));
  afterEach(() => vi.unstubAllGlobals());

  const start = (onFeedback = vi.fn()) =>
    runTree({ url: 'ws://robot:9090', action: '/run', tree: 'Main', payload: 'speed: 1', onFeedback });

  it('sends the goal, reports the feedback, and ends with the result', async () => {
    const onFeedback = vi.fn();
    const run = start(onFeedback);
    const socket = FakeSocket.last;
    socket.open();
    const [goal] = socket.sent;
    expect(goal).toMatchObject({
      op: 'send_action_goal', action: '/run', action_type: EXECUTE_TREE, args: { target_tree: 'Main', payload: 'speed: 1' },
    });
    socket.receive({ op: 'action_feedback', id: 'someone else', values: { message: 'not ours' } });
    socket.receive({ op: 'action_feedback', id: goal.id, values: { message: 'moving' } });
    socket.receive({ op: 'action_result', id: goal.id, result: true, status: 4, values: { node_status: { status: 2 }, return_message: 'done' } });
    expect(await run.result).toEqual({ ok: true, outcome: 'succeeded', treeStatus: 'SUCCESS', message: 'done' });
    expect(onFeedback).toHaveBeenCalledExactlyOnceWith('moving');
    expect(socket.readyState).toBe(3);
  });

  it('tells a failed tree from a goal that never ran', async () => {
    const run = start();
    FakeSocket.last.open();
    const { id } = FakeSocket.last.sent[0];
    FakeSocket.last.receive({ op: 'action_result', id, result: true, status: 6, values: { node_status: { status: 3 } } });
    expect(await run.result).toMatchObject({ ok: false, outcome: 'aborted', treeStatus: 'FAILURE' });

    const refused = start();
    FakeSocket.last.open();
    FakeSocket.last.receive({ op: 'status', id: FakeSocket.last.sent[0].id, msg: 'unknown action type' });
    expect(await refused.result).toMatchObject({ ok: false, outcome: 'failed', message: 'unknown action type' });
  });

  it('fails when rosbridge cannot be reached', async () => {
    const run = start();
    FakeSocket.last.onerror?.();
    expect(await run.result).toMatchObject({ ok: false, outcome: 'failed', message: expect.stringContaining('Cannot connect') });
  });

  it('cancels the goal', () => {
    const run = start();
    FakeSocket.last.open();
    run.cancel();
    expect(FakeSocket.last.sent[1]).toMatchObject({ op: 'cancel_action_goal', action: '/run', id: FakeSocket.last.sent[0].id });
  });
});

describe('following the runs of the server', () => {
  beforeEach(() => {
    vi.stubGlobal('WebSocket', FakeSocket);
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  const follow = (onMessage = vi.fn()) =>
    followExecution({ url: 'ws://robot:9090', topic: '/stepit_server/execution', onMessage });

  it('subscribes to the topic and passes on its messages', () => {
    const onMessage = vi.fn();
    follow(onMessage);
    const socket = FakeSocket.last;
    socket.open();
    expect(socket.sent[0]).toMatchObject({ op: 'subscribe', topic: '/stepit_server/execution', type: 'std_msgs/msg/String' });
    socket.receive({ op: 'publish', topic: '/other', msg: { data: 'not ours' } });
    socket.receive({ op: 'publish', topic: '/stepit_server/execution', msg: { data: '{"run": 1}' } });
    expect(onMessage).toHaveBeenCalledExactlyOnceWith('{"run": 1}');
  });

  it('connects again when the connection closes, until closed', () => {
    const following = follow();
    const first = FakeSocket.last;
    first.onclose?.();
    vi.advanceTimersByTime(FOLLOW_RETRY_MS);
    const second = FakeSocket.last;
    expect(second).not.toBe(first);

    following.close();
    expect(second.readyState).toBe(3);
    second.onclose?.();
    vi.advanceTimersByTime(FOLLOW_RETRY_MS * 2);
    expect(FakeSocket.last).toBe(second);
  });
});

describe('stopping a run started elsewhere', () => {
  beforeEach(() => {
    vi.stubGlobal('WebSocket', FakeSocket);
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  const cancel = () => cancelAllGoals({ url: 'ws://robot:9090', action: '/commander/execute_objective' });

  it('cancels every goal of the server, and resolves when it answered', async () => {
    const done = cancel();
    const socket = FakeSocket.last;
    socket.open();
    const [request] = socket.sent;
    expect(request).toMatchObject({
      op: 'call_service', service: '/commander/execute_objective/_action/cancel_goal', type: 'action_msgs/srv/CancelGoal', args: {},
    });
    socket.receive({ op: 'service_response', id: 'someone else', result: false });
    socket.receive({ op: 'service_response', id: request.id, result: true, values: { return_code: 0 } });
    await expect(done).resolves.toBeUndefined();
    expect(socket.readyState).toBe(3);
  });

  it('says why it could not', async () => {
    const refused = cancel();
    FakeSocket.last.open();
    FakeSocket.last.receive({ op: 'service_response', id: FakeSocket.last.sent[0].id, result: false, values: 'no such service' });
    await expect(refused).rejects.toThrow('The server refused to stop: no such service');

    const unanswered = cancel();
    FakeSocket.last.open();
    vi.advanceTimersByTime(REQUEST_TIMEOUT_MS);
    await expect(unanswered).rejects.toThrow('did not answer');

    const unreachable = cancel();
    FakeSocket.last.onerror?.();
    await expect(unreachable).rejects.toThrow('Cannot connect to rosbridge');
  });
});

