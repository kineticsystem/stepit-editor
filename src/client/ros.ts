// Runs a tree on a BehaviorTree.ROS2 server (a TreeExecutionServer), through
// rosbridge: a WebSocket that speaks JSON, so the browser needs no ROS. Also
// follows every run of the server, see followExecution().
//
//   → send_action_goal    the tree ID and the payload
//   ← action_feedback     the messages of the server while the tree runs
//   ← action_result       how it ended; result: false when rosbridge failed
//   → cancel_action_goal  stops it
//
// A run started elsewhere, by another client, is stopped with cancelAllGoals().

import { errorMessage } from './api';

export const EXECUTE_TREE = 'btcpp_ros2_interfaces/action/ExecuteTree';

/** GoalStatus of action_msgs. */
const GOAL_STATUS: Record<number, string> = { 4: 'succeeded', 5: 'canceled', 6: 'aborted' };
/** NodeStatus of btcpp_ros2_interfaces: how the tree itself ended. */
const NODE_STATUS: Record<number, string> = { 0: 'IDLE', 1: 'RUNNING', 2: 'SUCCESS', 3: 'FAILURE', 4: 'SKIPPED' };

export interface RunResult {
  /** The goal succeeded and the tree returned SUCCESS. */
  ok: boolean;
  /** The goal's end: succeeded, canceled or aborted; or failed when it never ran. */
  outcome: string;
  /** The status the tree returned, e.g. SUCCESS or FAILURE. */
  treeStatus?: string;
  message: string;
}

export interface Run {
  result: Promise<RunResult>;
  cancel(): void;
}

let nextId = 0;

/** The rosbridge URL to use when none is set: port 9090 of the host that serves the editor. */
export function defaultRosbridgeUrl(): string {
  return `ws://${location.hostname || 'localhost'}:9090`;
}

export function runTree(options: {
  url: string;
  action: string;
  tree: string;
  payload: string;
  onFeedback(message: string): void;
}): Run {
  const id = `behavior-editor-${Date.now()}-${nextId++}`;
  let socket: WebSocket | undefined;
  let settle: (r: RunResult) => void = () => {};
  const result = new Promise<RunResult>((resolve) => {
    let done = false;
    settle = (r) => {
      if (done) return;
      done = true;
      resolve(r);
      socket?.close();
    };
    try {
      socket = new WebSocket(options.url);
    } catch (e) {
      settle({ ok: false, outcome: 'failed', message: `Invalid rosbridge URL ${options.url}: ${errorMessage(e)}` });
      return;
    }
    socket.onopen = () => socket!.send(JSON.stringify({
      op: 'send_action_goal', id, action: options.action, action_type: EXECUTE_TREE,
      args: { target_tree: options.tree, payload: options.payload }, feedback: true,
    }));
    socket.onerror = () => settle({
      ok: false, outcome: 'failed',
      message: `Cannot connect to rosbridge at ${options.url}. Is it running? Start the server with rosbridge:=true.`,
    });
    socket.onclose = () => settle({ ok: false, outcome: 'failed', message: 'The connection to rosbridge closed before the tree finished.' });
    socket.onmessage = (event) => {
      let msg: { op?: string; id?: string; values?: unknown; status?: number; result?: boolean };
      try {
        msg = JSON.parse(String(event.data));
      } catch {
        return;
      }
      if (msg.op === 'status' && msg.id === id) {
        // rosbridge reports a malformed request this way, e.g. an unknown action type.
        settle({ ok: false, outcome: 'failed', message: String((msg as { msg?: string }).msg ?? 'rosbridge refused the goal') });
      }
      if (msg.id !== id) return;
      if (msg.op === 'action_feedback') {
        const message = (msg.values as { message?: string } | undefined)?.message;
        if (message) options.onFeedback(message);
      } else if (msg.op === 'action_result') {
        if (!msg.result) {
          settle({ ok: false, outcome: 'failed', message: String(msg.values) });
          return;
        }
        const values = msg.values as { node_status?: { status?: number }; return_message?: string } | undefined;
        const outcome = GOAL_STATUS[msg.status ?? -1] ?? `status ${msg.status}`;
        const treeStatus = NODE_STATUS[values?.node_status?.status ?? -1];
        settle({ ok: outcome === 'succeeded' && treeStatus === 'SUCCESS', outcome, treeStatus, message: values?.return_message ?? '' });
      }
    };
  });
  return {
    result,
    cancel() {
      if (socket?.readyState === WebSocket.OPEN) {
        socket.send(JSON.stringify({ op: 'cancel_action_goal', id, action: options.action }));
      }
    },
  };
}

/** How long to wait for the server to answer a request, in milliseconds. */
export const REQUEST_TIMEOUT_MS = 5000;

/**
 * Stops whatever the server runs, whoever started it: calls the cancel_goal
 * service of the action with an empty request, which cancels every goal. Every
 * BehaviorTree.ROS2 server has it, as every ROS 2 action server does.
 * Resolves once the server answered; rejects with why it could not.
 *
 *   → call_service      <action>/_action/cancel_goal, action_msgs/srv/CancelGoal
 *   ← service_response
 */
export function cancelAllGoals(options: { url: string; action: string }): Promise<void> {
  const id = `behavior-editor-cancel-${Date.now()}-${nextId++}`;
  return new Promise<void>((resolve, reject) => {
    let socket: WebSocket;
    try {
      socket = new WebSocket(options.url);
    } catch (e) {
      reject(new Error(`Invalid rosbridge URL ${options.url}: ${errorMessage(e)}`));
      return;
    }
    let done = false;
    const finish = (error?: string) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      socket.close();
      if (error) reject(new Error(error));
      else resolve();
    };
    const timer = setTimeout(() => finish('The server did not answer the request to stop.'), REQUEST_TIMEOUT_MS);
    socket.onopen = () => socket.send(JSON.stringify({
      op: 'call_service', id, service: `${options.action}/_action/cancel_goal`, type: 'action_msgs/srv/CancelGoal', args: {},
    }));
    socket.onerror = () => finish(`Cannot connect to rosbridge at ${options.url}.`);
    socket.onclose = () => finish('The connection to rosbridge closed before the server answered.');
    socket.onmessage = (event) => {
      let msg: { op?: string; id?: string; result?: boolean; values?: unknown };
      try {
        msg = JSON.parse(String(event.data));
      } catch {
        return;
      }
      if (msg.op === 'service_response' && msg.id === id) {
        finish(msg.result === false ? `The server refused to stop: ${String(msg.values)}` : undefined);
      }
    };
  });
}

/** How long to wait before connecting again, after the connection closed or failed. */
export const FOLLOW_RETRY_MS = 3000;

/**
 * Follows the runs of the server, whoever starts them: subscribes to the
 * latched topic on which StepIt Commander publishes the whole run, and calls
 * onMessage with each message. rosbridge subscribes with the durability of the
 * publisher, so the last run comes at once. A connection that fails or closes
 * is opened again, every FOLLOW_RETRY_MS, until close().
 *
 *   → subscribe   the topic, std_msgs/String
 *   ← publish     the run, as JSON
 */
export function followExecution(options: { url: string; topic: string; onMessage(message: string): void }): { close(): void } {
  let socket: WebSocket | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let closed = false;

  const connect = () => {
    timer = undefined;
    try {
      socket = new WebSocket(options.url);
    } catch {
      return; // An invalid URL: nothing to follow until it changes.
    }
    const current = socket;
    current.onopen = () => current.send(JSON.stringify({
      op: 'subscribe', id: `behavior-editor-follow-${nextId++}`, topic: options.topic, type: 'std_msgs/msg/String',
    }));
    current.onmessage = (event) => {
      let msg: { op?: string; topic?: string; msg?: { data?: unknown } };
      try {
        msg = JSON.parse(String(event.data));
      } catch {
        return;
      }
      if (msg.op === 'publish' && msg.topic === options.topic && typeof msg.msg?.data === 'string') {
        options.onMessage(msg.msg.data);
      }
    };
    current.onclose = () => {
      if (!closed && socket === current && !timer) timer = setTimeout(connect, FOLLOW_RETRY_MS);
    };
  };

  connect();
  return {
    close() {
      closed = true;
      if (timer) clearTimeout(timer);
      socket?.close();
    },
  };
}
