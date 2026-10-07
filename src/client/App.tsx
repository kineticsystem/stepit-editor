import { useEffect } from 'react';
import { redo, save, saveAll, undo } from './actions';
import { Browser } from './components/Browser';
import { CenterTabs } from './components/CenterTabs';
import { ExecutionPanel } from './components/ExecutionPanel';
import { Inspector } from './components/Inspector';
import { Splitter, useStoredSize } from './components/Splitter';
import { TreeEditor } from './components/TreeEditor';
import { DialogHost, useDialog } from './dialogs';
import { useAnalysis } from './hooks';
import { defaultRosbridgeUrl, followExecution } from './ros';
import { useSettings } from './settings';
import { hasDirtyFiles, useStore } from './store';

function Toasts() {
  const toasts = useStore((s) => s.toasts);
  return (
    <div className="toasts" role="status">
      {toasts.map((t) => <div key={t.id} className={`toast toast-${t.kind}`}>{t.message}</div>)}
    </div>
  );
}

/** The narrowest the side panels get, whether dragged or squeezed by a small window. */
const SIDE_MIN = 160;

export function App() {
  const loading = useStore((s) => s.loading);
  const loadError = useStore((s) => s.loadError);
  const executionShown = useStore((s) => s.executionShown);
  const analysis = useAnalysis();
  const [left, setLeft] = useStoredSize('be.left', 270);
  const [right, setRight] = useStoredSize('be.right', 360);

  useEffect(() => {
    void useStore.getState().load();
  }, []);

  // Every run of the server, whoever started it, for the Execution tab.
  const rosbridgeUrl = useSettings((s) => s.rosbridgeUrl.trim()) || defaultRosbridgeUrl();
  const executionTopic = useSettings((s) => s.executionTopic.trim());
  useEffect(() => {
    if (!executionTopic) return;
    const follow = followExecution({
      url: rosbridgeUrl, topic: executionTopic, onMessage: (message) => useStore.getState().applySnapshot(message),
    });
    return () => follow.close();
  }, [rosbridgeUrl, executionTopic]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (useDialog.getState().content) return;
      const mod = e.ctrlKey || e.metaKey;
      const inField = (e.target as HTMLElement).closest?.('input, textarea, select');
      // Like a browser, but between trees; it also keeps the browser from leaving the page.
      if (e.altKey && !mod && !e.shiftKey && !inField && (e.key === 'ArrowLeft' || e.key === 'ArrowRight')) {
        e.preventDefault();
        if (e.key === 'ArrowLeft') useStore.getState().goBack();
        else useStore.getState().goForward();
        return;
      }
      if (!mod) return;
      const key = e.key.toLowerCase();
      if (key === 's') {
        e.preventDefault();
        if (e.shiftKey) void saveAll();
        else save();
      } else if (!inField && key === 'z') {
        e.preventDefault();
        if (e.shiftKey) redo();
        else undo();
      } else if (!inField && key === 'y') {
        e.preventDefault();
        redo();
      }
    };
    const onUnload = (e: BeforeUnloadEvent) => {
      if (hasDirtyFiles(useStore.getState().files)) e.preventDefault();
    };
    window.addEventListener('keydown', onKey);
    window.addEventListener('beforeunload', onUnload);
    return () => {
      window.removeEventListener('keydown', onKey);
      window.removeEventListener('beforeunload', onUnload);
    };
  }, []);

  if (loadError) {
    return (
      <div className="fatal">
        <h1>Cannot load the behaviors</h1>
        <p>{loadError}</p>
        <button onClick={() => void useStore.getState().load()}>Retry</button>
      </div>
    );
  }

  return (
    // The dragged widths are what the side panels would like: in a small window
    // they give up room too, down to SIDE_MIN, rather than crushing the tree.
    <div className="app" style={{
      gridTemplateColumns: `minmax(${SIDE_MIN}px, ${left}px) 4px minmax(320px, 1fr) 4px minmax(${SIDE_MIN}px, ${right}px)`,
    }}>
      <Browser analysis={analysis} />
      <Splitter direction="columns" label="Resize the workspace panel" value={left} onChange={setLeft} grow={1} min={SIDE_MIN} max={640} />
      <div className="center">
        <CenterTabs />
        {loading && !Object.keys(useStore.getState().files).length
          ? <main className="panel placeholder">Loading…</main>
          : executionShown ? <ExecutionPanel analysis={analysis} /> : <TreeEditor analysis={analysis} />}
      </div>
      <Splitter direction="columns" label="Resize the details panel" value={right} onChange={setRight} grow={-1} min={SIDE_MIN} max={720} />
      <Inspector analysis={analysis} />
      <DialogHost />
      <Toasts />
    </div>
  );
}
