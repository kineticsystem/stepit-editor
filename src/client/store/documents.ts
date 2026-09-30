// The files of the folder: loading, editing with undo, saving and validating.

import { BUILTIN_MODELS } from '../../shared/builtins';
import type { BTDocument } from '../../shared/types';
import { newDocument, parseDocument, serializeDocument, trees } from '../../shared/xml';
import { api, errorMessage, isConflict, setLoadedRoot } from '../api';
import type { DocumentsSlice, FileState, Slice } from './types';

/** The number of undo steps kept per file. */
const UNDO_LIMIT = 200;

const serializedCache = new WeakMap<BTDocument, string>();

/** The document as it would be written; cached, since documents are never mutated once stored. */
export function serialized(doc: BTDocument): string {
  let text = serializedCache.get(doc);
  if (text === undefined) {
    text = serializeDocument(doc);
    serializedCache.set(doc, text);
  }
  return text;
}

export function isDirty(f: FileState): boolean {
  return !!f.isNew || (!!f.doc && serialized(f.doc) !== f.baseline);
}

export function hasDirtyFiles(files: Record<string, FileState>): boolean {
  return Object.values(files).some(isDirty);
}

/** The content to write or validate: the edited document, or the raw text of a broken file. */
export function contentOf(f: FileState): string {
  return f.doc ? serialized(f.doc) : f.raw;
}

function contents(files: Record<string, FileState>): { path: string; content: string }[] {
  return Object.values(files).map((f) => ({ path: f.path, content: contentOf(f) }));
}

/** The serialized state of all files, compared with NativeState.checked. */
export function workspaceFingerprint(files: Record<string, FileState>): string {
  return JSON.stringify(contents(files));
}

function fileState(path: string, raw: string, etag: string): FileState {
  const { doc, error } = parseDocument(raw);
  return { path, doc, error, raw, etag, baseline: doc ? serialized(doc) : raw, past: [], future: [] };
}

/** The tree to show when a file is opened: its main tree, or the first one. */
export function defaultTree(doc: BTDocument | undefined): string | undefined {
  if (!doc) return undefined;
  const all = trees(doc);
  return (all.find((t) => t.id === doc.rootAttrs.main_tree_to_execute) ?? all[0])?.uid;
}

export const documentsSlice: Slice<DocumentsSlice> = (set, get) => {
  const setFile = (f: FileState) => set({ files: { ...get().files, [f.path]: f } });

  /** Selects another file if `path`, just removed, was selected. */
  const leaveFile = (path: string) => {
    if (get().selection.file !== path) return;
    const first = Object.keys(get().files).sort()[0];
    if (first) get().selectFile(first);
    else get().select({});
  };

  return {
    root: '',
    loading: true,
    files: {},
    builtins: BUILTIN_MODELS,
    nativeAvailable: false,
    native: { running: false },

    async load() {
      set({ loading: true, loadError: undefined });
      try {
        const ws = await api.workspace();
        const { root, files: previous } = get();
        if (root && ws.root !== root) {
          // Another tab opened another folder: our files belong to the old one.
          if (hasDirtyFiles(previous)) {
            set({ loading: false });
            get().toast(`The server now serves ${ws.root}, opened in another tab. To save your edits, open ${root} again.`, 'error');
            return;
          }
          get().resetNavigation();
          get().resetUi();
          set({ files: {}, native: { running: false } });
        }
        const files: Record<string, FileState> = {};
        const changed: string[] = [];
        const base = root === ws.root ? previous : {};
        for (const f of ws.files) {
          const old = base[f.path];
          if (old && isDirty(old)) {
            // Keep the edits, and the version they are based on: if the file
            // changed on disk, saving will ask before overwriting it.
            files[f.path] = old;
            if (old.etag !== f.etag) changed.push(f.path);
          } else {
            files[f.path] = fileState(f.path, f.content, f.etag);
          }
        }
        // Files with edits that are not on disk: new ones, or deleted since.
        for (const [path, old] of Object.entries(base)) {
          if (files[path] || !isDirty(old)) continue;
          files[path] = old;
          if (!old.isNew) changed.push(path);
        }
        setLoadedRoot(ws.root);
        set({
          root: ws.root, files, loading: false,
          builtins: ws.builtins?.length ? ws.builtins : BUILTIN_MODELS,
          nativeAvailable: ws.nativeValidator,
        });
        if (changed.length) {
          get().toast(`Changed on disk: ${changed.join(', ')}. Your unsaved edits are kept; saving will ask before overwriting.`, 'error');
        }
        const { selection } = get();
        if (!selection.file || !files[selection.file]) {
          // Open the first file with a tree, not e.g. a file of node models.
          const paths = Object.keys(files).sort();
          const first = paths.find((p) => defaultTree(files[p].doc)) ?? paths[0];
          if (first) get().selectFile(first);
          else get().select({});
        } else if (selection.tree && !trees(files[selection.file].doc ?? { rootAttrs: {}, items: [] }).some((t) => t.uid === selection.tree)) {
          get().selectFile(selection.file);
        }
      } catch (e) {
        set({ loading: false, loadError: errorMessage(e) });
      }
    },

    async openFolder(path) {
      let opened: string;
      try {
        opened = (await api.openFolder(path)).root;
      } catch (e) {
        get().toast(`Cannot open ${path}: ${errorMessage(e)}`, 'error');
        return;
      }
      // Opening the folder we hold, e.g. to save edits after another tab
      // opened another one, keeps them. Any other folder starts afresh: our
      // unsaved edits would otherwise be applied to same-named files there.
      if (opened !== get().root) {
        get().resetNavigation();
        get().resetUi();
        set({ root: '', files: {}, native: { running: false } });
        setLoadedRoot(undefined);
      }
      await get().load();
    },

    edit(path, change, coalesceKey) {
      const f = get().files[path];
      if (!f?.doc) return;
      const next = structuredClone(f.doc);
      if (change(next) === false) return;
      const coalesce = coalesceKey !== undefined && coalesceKey === f.lastEditKey;
      const past = coalesce ? f.past : [...f.past.slice(-(UNDO_LIMIT - 1)), f.doc];
      setFile({ ...f, doc: next, past, future: [], lastEditKey: coalesceKey });
    },

    undo(path) {
      const f = get().files[path];
      if (!f?.doc || !f.past.length) return;
      const doc = f.past[f.past.length - 1];
      setFile({ ...f, doc, past: f.past.slice(0, -1), future: [f.doc, ...f.future], lastEditKey: undefined });
    },

    redo(path) {
      const f = get().files[path];
      if (!f?.doc || !f.future.length) return;
      const [doc, ...future] = f.future;
      setFile({ ...f, doc, past: [...f.past, f.doc], future, lastEditKey: undefined });
    },

    async save(path, over) {
      const f = get().files[path];
      if (!f?.doc) return { status: 'failed' };
      const content = serialized(f.doc);
      try {
        const { etag } = await api.save(path, content, over !== undefined ? over : f.etag ?? null);
        // Edits made while saving stay dirty: the baseline is what was written.
        setFile({ ...get().files[path], raw: content, baseline: content, etag, isNew: false });
        get().toast(`Saved ${path}`);
        return { status: 'saved' };
      } catch (e) {
        if (isConflict(e)) return { status: 'conflict', message: e.message, etag: e.data.etag };
        get().toast(`Cannot save ${path}: ${errorMessage(e)}`, 'error');
        return { status: 'failed' };
      }
    },

    async revert(path) {
      try {
        const ws = await api.workspace();
        const f = ws.files.find((x) => x.path === path);
        if (f) {
          setFile(fileState(f.path, f.content, f.etag));
        } else {
          const files = { ...get().files };
          delete files[path];
          set({ files });
          leaveFile(path);
        }
        const { selection } = get();
        if (selection.file === path) get().selectFile(path);
      } catch (e) {
        get().toast(`Cannot reload ${path}: ${errorMessage(e)}`, 'error');
      }
    },

    createFile(path, treeId, objective = true) {
      const doc = newDocument(treeId, objective);
      setFile({ path, doc, raw: '', baseline: '', past: [], future: [], isNew: true });
      get().select({ file: path, tree: defaultTree(doc) });
    },

    async deleteFile(path) {
      const f = get().files[path];
      if (!f) return;
      try {
        if (!f.isNew) await api.remove(path, f.etag ?? '*');
      } catch (e) {
        const reason = isConflict(e) ? `it was changed on disk since it was loaded. Reload the folder first` : errorMessage(e);
        get().toast(`Cannot delete ${path}: ${reason}`, 'error');
        return;
      }
      const files = { ...get().files };
      delete files[path];
      set({ files });
      leaveFile(path);
      get().toast(`Deleted ${path}`);
    },

    async runNative() {
      const files = contents(get().files);
      set({ native: { ...get().native, running: true, error: undefined } });
      try {
        const result = await api.validate(files);
        set({ native: { running: false, result, checked: JSON.stringify(files) } });
      } catch (e) {
        set({ native: { running: false, error: errorMessage(e) } });
      }
    },
  };
};
