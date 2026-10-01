// The tree running on the server, as it reports it: see ../execution.ts.

import { failedNodeUid, parseExecutedTree, parseFeedback } from '../execution';
import type { ExecutionSlice, Slice } from './types';

export const executionSlice: Slice<ExecutionSlice> = (set, get) => ({
  executionShown: false,

  startExecution(treeId) {
    set({ execution: { treeId, statuses: {}, progress: {}, messages: [], startedAt: Date.now() }, executionShown: true });
  },

  applyFeedback(message) {
    const execution = get().execution;
    if (!execution || execution.result) return;
    const feedback = parseFeedback(message);
    if (!feedback) {
      set({ execution: { ...execution, messages: [...execution.messages, message] } });
      return;
    }
    set({
      execution: {
        ...execution,
        tree: feedback.tree !== undefined ? parseExecutedTree(feedback.tree) ?? execution.tree : execution.tree,
        statuses: { ...execution.statuses, ...feedback.nodes },
        progress: { ...execution.progress, ...feedback.progress },
      },
    });
  },

  endExecution(result) {
    const execution = get().execution;
    if (!execution) return;
    const crashed = result.ok ? undefined : failedNodeUid(result.message);
    // Nothing runs once the run is over. A node still marked running was halted
    // with the tree, when it was stopped or a node threw: the server then sends
    // no last feedback.
    const statuses = Object.fromEntries(Object.entries(execution.statuses)
      .map(([uid, status]) => [uid, status === 'RUNNING' ? 'HALTED' : status] as const));
    set({ execution: { ...execution, statuses, progress: {}, result, crashed, endedAt: Date.now() } });
    if (!get().executionShown) {
      get().toast(`${execution.treeId}: ${result.ok ? 'succeeded' : result.outcome === 'canceled' ? 'stopped' : 'failed'}`,
        result.ok ? 'info' : 'error');
    }
  },

  showExecution(shown) {
    set({ executionShown: shown && !!get().execution });
  },
});
