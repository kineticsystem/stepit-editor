// The state of the editor, split in three slices that share one store:
//
//   documents   the files, their edits and undo history, loading and saving
//   navigation  what is selected, and the Back and Forward history
//   ui          view state that is not part of any file: collapsed rows,
//               the clipboard, toasts
//   execution   the tree running on the server, as it reports it
//
// A slice may call the actions of the others through get().

import type { StateCreator } from 'zustand';
import type { NativeResult } from '../../server/native';
import type { BTDocument, BTNode, NodeModel, ParseError } from '../../shared/types';
import type { ExecutedTree, ExecutionStatus, NodeProgress } from '../execution';
import type { RunResult } from '../ros';

export interface FileState {
  path: string;
  doc?: BTDocument;
  error?: ParseError;
  /** The content on disk. */
  raw: string;
  /** The document as the editor would write it when it was loaded or saved. */
  baseline: string;
  /**
   * The ETag of the version on disk that the edits are based on; undefined for
   * a file created in the editor. Saving sends it in If-Match, so that the
   * server refuses to overwrite a change made since, e.g. by hand.
   */
  etag?: string;
  past: BTDocument[];
  future: BTDocument[];
  /** Created in the editor and not saved yet. */
  isNew?: boolean;
  /** Consecutive edits with the same key, e.g. typing in a field, make one undo step. */
  lastEditKey?: string;
}

export interface Selection {
  file?: string;
  /** The uid of the tree shown in the editor. */
  tree?: string;
  /** The uid of the selected node; none selects the tree itself. */
  node?: string;
}

/**
 * A tree opened earlier, for Back and Forward. The tree ID is kept besides the
 * uid because reloading the folder parses the files again, with new uids.
 */
export interface HistoryEntry extends Selection {
  treeId?: string;
}

/** A node of an included tree, clicked inside an expanded SubTree: shown read-only. */
export interface Peek {
  file: string;
  tree: string;
  node: string;
  /** The key of the row that was clicked, to highlight it. */
  key: string;
}

export interface Toast {
  id: number;
  kind: 'info' | 'error';
  message: string;
}

export interface NativeState {
  running: boolean;
  result?: NativeResult;
  error?: string;
  /** The serialized files that were checked, to tell when the result is stale. */
  checked?: string;
}

/** How a save ended. A conflict leaves the file unsaved, for the user to decide. */
export type SaveResult =
  | { status: 'saved' }
  | { status: 'failed' }
  | {
    status: 'conflict';
    message: string;
    /** The ETag of the file now on disk; undefined if it was deleted. */
    etag?: string;
  };

export interface DocumentsSlice {
  root: string;
  loading: boolean;
  loadError?: string;
  files: Record<string, FileState>;
  builtins: NodeModel[];
  nativeAvailable: boolean;
  native: NativeState;

  load(): Promise<void>;
  /** Opens another folder, dropping everything of the current one, unsaved edits included. */
  openFolder(path: string): Promise<void>;
  /**
   * Applies `change` to a copy of the file's document, which becomes the new
   * document, with the old one on the undo stack. `change` returns false when
   * it finds nothing to do: then nothing changes.
   */
  edit(path: string, change: (doc: BTDocument) => boolean | void, coalesceKey?: string): void;
  undo(path: string): void;
  redo(path: string): void;
  /**
   * Saves a file over the version it was loaded from. `over` overrides that
   * version, to overwrite a conflicting change: the ETag now on disk, or null
   * when the file was deleted.
   */
  save(path: string, over?: string | null): Promise<SaveResult>;
  /** Replaces a file with its content on disk, dropping its edits. */
  revert(path: string): Promise<void>;
  /** Creates a file with one tree: an objective, its main tree, unless `objective` is false. */
  createFile(path: string, treeId: string, objective?: boolean): void;
  deleteFile(path: string): Promise<void>;
  runNative(): Promise<void>;
}

export interface NavigationSlice {
  selection: Selection;
  /** The trees opened before the current one, most recent last. */
  back: HistoryEntry[];
  /** The trees left with Back, most recent last. */
  forward: HistoryEntry[];
  peek?: Peek;
  /** A node type clicked in the Behaviors list, shown in the right panel. */
  focusModel?: string;

  select(selection: Selection): void;
  setPeek(peek: Peek): void;
  setFocusModel(id: string): void;
  selectFile(path: string): void;
  /** Opens the tree shown before the current one, or the one left with Back. */
  goBack(): void;
  goForward(): void;
  /** Forgets the selection and the history, e.g. when another folder is opened. */
  resetNavigation(): void;
}

export interface UiSlice {
  collapsed: Record<string, true>;
  /** SubTree rows whose referenced tree is shown inline, by row key. */
  openSubtrees: Record<string, true>;
  clipboard?: BTNode;
  toasts: Toast[];

  setCollapsed(uids: string[], collapsed: boolean): void;
  toggleSubtree(key: string): void;
  setClipboard(node?: BTNode): void;
  toast(message: string, kind?: Toast['kind']): void;
  resetUi(): void;
}

/** A tree run on the server, from the Run dialog. */
export interface Execution {
  /** The ID of the tree run. */
  treeId: string;
  /** Running, or how it ended. */
  result?: RunResult;
  /** The tree as the server executes it; undefined until it says, or if it never does. */
  tree?: ExecutedTree;
  /** The last status of each node, by _uid. */
  statuses: Record<string, ExecutionStatus>;
  /** The last progress of each node that reports one, by _uid: shown while it runs. */
  progress: Record<string, NodeProgress>;
  /** Feedback that is not a status, as plain text. */
  messages: string[];
  /** The _uid of a node that threw, from the error message of the server. */
  crashed?: string;
  startedAt: number;
  endedAt?: number;
}

export interface ExecutionSlice {
  execution?: Execution;
  /** Whether the execution is shown in place of the tree editor. */
  executionShown: boolean;

  startExecution(treeId: string): void;
  /** Apply a feedback message of the server: statuses, or plain text. */
  applyFeedback(message: string): void;
  endExecution(result: RunResult): void;
  showExecution(shown: boolean): void;
}

export type State = DocumentsSlice & NavigationSlice & UiSlice & ExecutionSlice;

export type Slice<T> = StateCreator<State, [], [], T>;
