// Preferences of this browser, kept in localStorage. Add new settings to
// Settings and DEFAULTS, and a control to components/SettingsMenu.tsx.

import { create } from 'zustand';

export type Theme = 'auto' | 'light' | 'dark';

export interface Settings {
  theme: Theme;
  /** Where rosbridge runs, e.g. ws://robot:9090; empty for port 9090 of the editor's host. */
  rosbridgeUrl: string;
  /** The ExecuteTree action of the BehaviorTree.ROS2 server that runs the trees. */
  runAction: string;
  /** The payload last used to run each tree, by tree ID and blackboard key. */
  payloads: Record<string, Record<string, string>>;
  /** The tab of the workspace panel last shown: the trees, or the node types. */
  browserTab: 'trees' | 'nodes';
}

const DEFAULTS: Settings = {
  theme: 'auto', rosbridgeUrl: '', runAction: '/commander/execute_objective', payloads: {}, browserTab: 'trees',
};
const KEY = 'be.settings';

function load(): Settings {
  try {
    return { ...DEFAULTS, ...JSON.parse(localStorage.getItem(KEY) ?? '{}') };
  } catch {
    return DEFAULTS;
  }
}

interface SettingsState extends Settings {
  update(change: Partial<Settings>): void;
}

export const useSettings = create<SettingsState>((set, get) => ({
  ...load(),
  update(change) {
    set(change);
    const { update: _, ...settings } = { ...get() };
    try {
      localStorage.setItem(KEY, JSON.stringify(settings));
    } catch { /* The settings then last until the page is reloaded. */ }
  },
}));

const systemDark = window.matchMedia('(prefers-color-scheme: dark)');

/** Sets data-theme on <html>, which styles.css keys the dark palette on. */
function applyTheme() {
  const { theme } = useSettings.getState();
  const resolved = theme === 'auto' ? (systemDark.matches ? 'dark' : 'light') : theme;
  document.documentElement.dataset.theme = resolved;
}

applyTheme();
useSettings.subscribe(applyTheme);
// In Auto mode, follow the system when it switches, e.g. at sunset.
systemDark.addEventListener('change', applyTheme);
