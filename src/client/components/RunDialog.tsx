// Runs the open tree on a BehaviorTree.ROS2 server, through rosbridge: a form
// for the payload the tree reads and the connection. Running saves the files,
// closes the dialog and shows the execution in place of the tree editor.

import { useState } from 'react';
import { payloadHints, payloadKeys, payloadText, type PayloadHint } from '../../shared/payload';
import type { Workspace } from '../../shared/workspace';
import { saveAll, startRun } from '../actions';
import { openDialog } from '../dialogs';
import { defaultRosbridgeUrl } from '../ros';
import { useSettings } from '../settings';
import { Icon } from './icons';

function RunForm({ treeId, keys, hints, close }: {
  treeId: string; keys: string[]; hints: Map<string, PayloadHint>; close: () => void;
}) {
  const settings = useSettings();
  const [values, setValues] = useState<Record<string, string>>(() =>
    Object.fromEntries(keys.map((k) => [k, settings.payloads[treeId]?.[k] ?? ''])));
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string>();
  const url = settings.rosbridgeUrl.trim() || defaultRosbridgeUrl();

  const start = async () => {
    settings.update({ payloads: { ...settings.payloads, [treeId]: values } });
    setSaving(true);
    // The server runs the files on disk.
    const saved = await saveAll();
    setSaving(false);
    if (!saved) {
      setError('Some files could not be saved, so the tree was not run.');
      return;
    }
    close();
    startRun({ url, action: settings.runAction.trim(), treeId, payload: payloadText(values) });
  };

  return (
    <form className="run-dialog" onSubmit={(e) => { e.preventDefault(); if (!saving) void start(); }}
      onKeyDown={(e) => e.key === 'Escape' && close()}>
      <h2><Icon name="play" size={15} /> Run {treeId}</h2>

      <fieldset className="bare run-payload" disabled={saving}>
        {keys.length ? keys.map((key, i) => {
          const hint = hints.get(key);
          return (
            <label key={key} className="field">
              <span className="field-label"><span className="port-name">@{key}</span></span>
              <input className="mono" autoFocus={i === 0} value={values[key]} spellCheck={false}
                placeholder={hint?.example ? `YAML, e.g. ${hint.example}` : 'YAML'}
                onChange={(e) => setValues({ ...values, [key]: e.target.value })} />
              {hint?.description && <small>{hint.description}</small>}
            </label>
          );
        }) : <p className="muted">This tree reads no payload.</p>}
      </fieldset>

      <details className="run-connection">
        <summary>Connection: {url} · {settings.runAction}</summary>
        <fieldset className="bare" disabled={saving}>
          <label className="field">
            <span>rosbridge URL</span>
            <input className="mono" value={settings.rosbridgeUrl} placeholder={defaultRosbridgeUrl()} spellCheck={false}
              onChange={(e) => settings.update({ rosbridgeUrl: e.target.value })} />
          </label>
          <label className="field">
            <span>Action</span>
            <input className="mono" value={settings.runAction} spellCheck={false}
              onChange={(e) => settings.update({ runAction: e.target.value })} />
            <small>The ExecuteTree action of the server; BehaviorTree.ROS2's default is bt_execution.</small>
          </label>
        </fieldset>
      </details>

      {error && <div className="run-output run-state failed" role="alert">{error}</div>}

      <div className="modal-actions">
        <button type="button" onClick={close}>Cancel</button>
        <button type="submit" className="primary" disabled={saving}>
          <Icon name="play" size={14} /> {saving ? 'Saving…' : 'Run'}
        </button>
      </div>
    </form>
  );
}

export function openRunDialog(ws: Workspace, treeId: string) {
  const keys = payloadKeys(ws, treeId);
  const hints = payloadHints(ws, treeId);
  openDialog((close) => <RunForm treeId={treeId} keys={keys} hints={hints} close={close} />);
}
