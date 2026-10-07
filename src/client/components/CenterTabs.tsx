// The tabs of the center panel: the Editor, the tree being edited, and the
// Execution, the run of the server, whoever started it. A run started
// elsewhere marks the Execution tab, with its name, but never takes the
// editor away; a run of the Run dialog opens it.

import { useStore } from '../store';
import { Icon } from './icons';

export function CenterTabs() {
  const shown = useStore((s) => s.executionShown);
  const execution = useStore((s) => s.execution);
  const running = !!execution && !execution.result;
  const show = (execution: boolean) => useStore.getState().showExecution(execution);
  return (
    <div className="center-tabs" role="tablist" aria-label="Center panel">
      <button role="tab" aria-selected={!shown} className={shown ? '' : 'active'} onClick={() => show(false)}>
        <Icon name="tree" size={14} /> Editor
      </button>
      <button role="tab" aria-selected={shown} className={shown ? 'active' : ''} onClick={() => show(true)}
        title={execution ? `${execution.treeId}: ${running ? 'running' : 'the last run'}` : 'Nothing has run yet'}>
        <Icon name="play" size={14} /> Execution
        {execution && (
          <span className={`center-tab-run ${running ? 'running' : ''}`}>
            {running && <span className="exec-dot" aria-label="running" />}
            {execution.treeId}
          </span>
        )}
      </button>
    </div>
  );
}
