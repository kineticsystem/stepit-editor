// The tree running on the server, as it reports it: see ../execution.ts. Two
// sources: the feedback of the goal this editor sent, and the snapshots that
// StepIt Commander publishes of every run, whoever sent it. The snapshots win
// where there are both, so that a run looks the same whoever started it; the
// feedback serves a server that publishes none.

import { type ExecutionSnapshot, type ExecutionStatus, failedNodeUid, parseExecutedTree, parseFeedback, parseSnapshot } from '../execution';
import type { Execution, ExecutionSlice, Slice } from './types';

/** Nothing runs once the run is over: a node still marked running was halted with the tree. */
function endedStatuses(statuses: Record<string, ExecutionStatus>): Record<string, ExecutionStatus> {
  return Object.fromEntries(Object.entries(statuses)
    .map(([uid, status]) => [uid, status === 'RUNNING' ? 'HALTED' : status] as const));
}

/** The run of a snapshot, as this editor shows it. */
function withSnapshot(execution: Execution, snapshot: ExecutionSnapshot): Execution {
  return {
    ...execution,
    run: snapshot.run,
    followed: true,
    tree: parseExecutedTree(snapshot.tree) ?? execution.tree,
    statuses: execution.result ? endedStatuses(snapshot.nodes) : snapshot.nodes,
    progress: execution.result ? {} : snapshot.progress,
  };
}

export const executionSlice: Slice<ExecutionSlice> = (set, get) => ({
  executionShown: false,

  startExecution(treeId) {
    set({
      execution: { treeId, own: true, statuses: {}, progress: {}, messages: [], startedAt: Date.now() },
      executionShown: true,
    });
  },

  applyFeedback(message) {
    const execution = get().execution;
    if (!execution || !execution.own || execution.result) return;
    const feedback = parseFeedback(message);
    if (!feedback) {
      set({ execution: { ...execution, messages: [...execution.messages, message] } });
      return;
    }
    // The number of the run tells its snapshots: one may have come already.
    const run = feedback.run ?? execution.run;
    const snapshot = get().lastSnapshot;
    if (run !== undefined && snapshot?.run === run) {
      set({ execution: withSnapshot({ ...execution, run }, snapshot) });
      return;
    }
    if (execution.followed) return;
    set({
      execution: {
        ...execution,
        run,
        tree: feedback.tree !== undefined ? parseExecutedTree(feedback.tree) ?? execution.tree : execution.tree,
        statuses: { ...execution.statuses, ...feedback.nodes },
        progress: { ...execution.progress, ...feedback.progress },
      },
    });
  },

  applySnapshot(message) {
    const snapshot = parseSnapshot(message);
    if (!snapshot) return;
    set({ lastSnapshot: snapshot });
    const execution = get().execution;
    if (execution?.own && !execution.result) {
      // Our run, once we know its number; another run waits for ours to end.
      if (execution.run === snapshot.run) set({ execution: withSnapshot(execution, snapshot) });
      return;
    }
    if (execution?.own && execution.run === snapshot.run) {
      // Our run ended, with its result from the goal: the snapshot may still bring its last statuses.
      set({ execution: withSnapshot(execution, snapshot) });
      return;
    }
    // A run started elsewhere, or the last one, when the page opens.
    const same = execution && !execution.own && execution.run === snapshot.run ? execution : undefined;
    const followed: Execution = {
      treeId: snapshot.objective,
      own: false,
      messages: [],
      statuses: {},
      progress: {},
      startedAt: same?.startedAt ?? Date.now(),
      result: snapshot.result,
      endedAt: snapshot.result ? same?.endedAt ?? Date.now() : undefined,
    };
    set({ execution: withSnapshot(followed, snapshot) });
  },

  endExecution(result) {
    const execution = get().execution;
    if (!execution || !execution.own) return;
    const crashed = result.ok ? undefined : failedNodeUid(result.message);
    // A node still marked running was halted with the tree, when it was stopped
    // or a node threw: the server then sends no last feedback.
    set({
      execution: { ...execution, statuses: endedStatuses(execution.statuses), progress: {}, result, crashed, endedAt: Date.now() },
    });
    if (!get().executionShown) {
      get().toast(`${execution.treeId}: ${result.ok ? 'succeeded' : result.outcome === 'canceled' ? 'stopped' : 'failed'}`,
        result.ok ? 'info' : 'error');
    }
  },

  showExecution(shown) {
    set({ executionShown: shown });
  },
});
