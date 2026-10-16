# StepIt Editor Review

## Table of Contents <!-- omit in toc -->

- [Scope and Method](#scope-and-method)
- [Verdict](#verdict)
- [Structure and Boundaries](#structure-and-boundaries)
- [Interfaces and Services](#interfaces-and-services)
- [Separation of Concerns](#separation-of-concerns)
- [SOLID](#solid)
- [The React Patterns](#the-react-patterns)
- [Coupling and Duplication](#coupling-and-duplication)
- [Testability and Tests](#testability-and-tests)
- [Implementation Issues](#implementation-issues)
- [Recommendations](#recommendations)

Reviewed on 2026-10-16, at commit `fac3127`. It judges the design that [docs/ARCHITECTURE.md](ARCHITECTURE.md) describes.

## Scope and Method

This review covers the user interface only: the React client in [`src/client`](../src/client), 32 TypeScript files and about 4,370 lines, plus its stylesheet, and how it uses [`src/shared`](../src/shared) and the types of the server. The server, the command line validator and the native validator are left out, except where the client depends on them: the listing of behavior files ([`readBehaviorFiles`](../src/server/files.ts)) and the 412 answers of the API.

We read every file of the client and its four test files, and judged them against SOLID, separation of concerns, the boundaries of [The Layers](ARCHITECTURE.md#the-layers), testability, and the 14 patterns of our React skill. Where this document or `CLAUDE.md` decides otherwise, e.g. commands as plain functions in `actions.ts` rather than hooks, the project wins and the review says so instead of calling it a defect.

Each suspected bug was reproduced with a throwaway Vitest probe in `tests/`, against the in-memory server of [`fakeServer.ts`](../tests/fakeServer.ts), then deleted. A finding marked **verified** failed its probe; the others are **from reading**. No probe passed, so no suspicion was dropped.

The whole suite, at the end: `pnpm run typecheck` passes in 1.3 s, and `vitest run` passes 148 tests and skips 6 (`native-real.test.ts`, which needs the built validator), in 13 files, in 2.4 s. `pnpm exec` refuses to run outside a terminal while `node_modules` does not match the lock file (`ERR_PNPM_ABORTED_REMOVE_MODULES_DIR_NO_TTY`); `pnpm --config.verify-deps-before-run=false exec vitest run` runs the same suite without touching `node_modules`.

## Verdict

The client is small, readable and consistent: one zustand store for the documents, the selection, the view state and the run; documents that are never mutated, so undo, dirtiness and memoized analysis come for free; nothing derived stored; and the client imports only types from the server. Its weakness is **asynchronous work**: no load, save, revert, validation or folder listing is cancelled or checked for staleness, and the conflict dialog cannot tell a real change on disk from one the editor caused. Two verified paths end with a user's file overwritten after one click on a dialog that blames someone else: a new file named like an XML file the editor does not list (finding 1), and a save that a reload in flight hides (finding 2).

Measured against the React skill, the client is a well-kept store with module-level services around it: there is no composition root, the HTTP client, the folder header, the run and the dialogs are module singletons, 9 of the 16 components read the store themselves, and the tests replace the API with `vi.mock()`.

## Structure and Boundaries

| Rule | Verdict | Evidence |
|---|---|---|
| `src/shared` imports nothing else, no `node:`, no React | Kept | No import of `client`, `server`, `cli`, `node:` or `react` under `src/shared`. |
| The client imports only types from the server | Kept | 4 imports, all `import type`: [`api.ts`](../src/client/api.ts) lines 3 and 4, [`store/types.ts`](../src/client/store/types.ts) line 12, [`FolderDialog.tsx`](../src/client/components/FolderDialog.tsx) line 5. |
| No `node:` module in the client | Kept | None. |
| No cycle between the modules of the client | Kept | A script over the value imports of the 32 files finds none. |
| Components render and call commands; they do not edit documents | Mostly kept | [`Inspector.tsx`](../src/client/components/Inspector.tsx) `ModelEditor` calls `useStore.getState().edit()` with its own mutation of the model (lines 143 to 149), the only component that edits a document without a command of `actions.ts`. |

The store is the right shape for the project: four slices in one store ([`store/index.ts`](../src/client/store/index.ts)), the settings in a second store, as [The Store](ARCHITECTURE.md#the-store) says; that section and the comment of [`store/types.ts`](../src/client/store/types.ts) still speak of three slices, without `execution`. The slices reach each other only through `get()`.

## Interfaces and Services

| Service | Where | Judgement |
|---|---|---|
| HTTP API, `api` | [`api.ts`](../src/client/api.ts) line 57 | A module object, imported by [`store/documents.ts`](../src/client/store/documents.ts) and [`FolderDialog.tsx`](../src/client/components/FolderDialog.tsx). No interface; the tests replace the module with `vi.mock()`. |
| The folder the edits belong to, `loadedRoot` | [`api.ts`](../src/client/api.ts) line 22 | Mutable module state, set by the store through `setLoadedRoot()`: a copy of the store's `root`, kept in step by hand at 2 places in `documents.ts`. |
| rosbridge, `runTree`, `cancelAllGoals`, `followExecution` | [`ros.ts`](../src/client/ros.ts) | Plain functions over `WebSocket`, imported by `App.tsx` and `actions.ts`. Testable with a fake `WebSocket` global, as [`ros.test.ts`](../tests/ros.test.ts) does. |
| The run in progress, `currentRun` | [`actions.ts`](../src/client/actions.ts) line 292 | Module state outside the store; the store has `execution.own` for the same run. |
| Dialogs, `useDialog`, `prompt`, `confirm`, `choose` | [`dialogs.tsx`](../src/client/dialogs.tsx) | A global zustand store that holds JSX, opened from commands. A sound idea for this project, see [Commands](ARCHITECTURE.md#commands); the flaw is how a dialog closes, finding 4. |
| Settings, `useSettings` | [`settings.ts`](../src/client/settings.ts) | A second store over `localStorage`, which also reads `window.matchMedia` and sets the theme when the module is imported (lines 51 to 63): the module cannot be imported by a test without a browser. |
| The model dragged, `draggedModel` | [`dnd.ts`](../src/client/dnd.ts) | Module state, justified in its comment: the browser hides drag data until the drop. |

There is no composition root: [`main.tsx`](../src/client/main.tsx) imports `./settings` for its side effects and renders `App`, and every service is chosen by the module that imports it.

## Separation of Concerns

- **Rules in components.** [`Browser.tsx`](../src/client/components/Browser.tsx) holds `newBehaviorFile()` (lines 20 to 36), the command that creates a file; [`TreeEditor.tsx`](../src/client/components/TreeEditor.tsx) holds `newTree()` (lines 76 to 82); [`RunDialog.tsx`](../src/client/components/RunDialog.tsx) `start()` holds the rule "save every file, then run" (lines 24 to 36); [`FolderDialog.tsx`](../src/client/components/FolderDialog.tsx) `open()` holds the rule "warn before dropping unsaved edits, except for the folder already open" (lines 29 to 38). Each is a rule a test of `actions.ts` cannot reach.
- **Policy in an effect of a component.** [`Browser.tsx`](../src/client/components/Browser.tsx) lines 142 to 146 switch the saved setting `browserTab` when the selected tree changes: a rule about navigation, kept in a component and written to `localStorage` on every navigation.
- **The analysis** is computed once in `App` and passed down as a prop to the 4 panels and on to `TreeView`, `Problems` and the dialogs: a documented choice ([From a Click to the Screen](ARCHITECTURE.md#from-a-click-to-the-screen)), cheap to follow, and kept.

## SOLID

| Principle | Verdict | Where |
|---|---|---|
| Single responsibility | Partly violated | [`Inspector.tsx`](../src/client/components/Inspector.tsx), 538 lines, holds 7 components, among them the editor of a node model and the rename of a tree. [`store/documents.ts`](../src/client/store/documents.ts) mixes the state of the files with the calls to the server and the toasts. |
| Open/closed | No violation found | A command is added to `actions.ts` and a check to `RULES` without changing the others. |
| Liskov substitution | Not applicable | No class hierarchy besides `ApiError`. |
| Interface segregation | No violation found | The slices expose small sets of actions; `Analysis` is a plain record. |
| Dependency inversion | Violated | The store depends on the concrete `api` module ([`documents.ts`](../src/client/store/documents.ts) line 6), commands on the concrete `ros.ts` and `dialogs.tsx` ([`actions.ts`](../src/client/actions.ts) lines 15 and 16). |

## The React Patterns

| Pattern | Verdict | Evidence |
|---|---|---|
| 1. One store | Kept | One store for the editor; `useSettings` is a second, documented one. Two copies outside it: `loadedRoot` in `api.ts`, and `currentRun` in `actions.ts`. |
| 2. Derive, never copy | Mostly kept | Dirtiness, the analysis and the staleness of the native check are derived. [`Inspector.tsx`](../src/client/components/Inspector.tsx) line 400 copies the prop `tree.id` into state with an effect, though the component is already keyed by `tree.uid`. |
| 3. Injection and a composition root | Not followed | No provider and no composition root; services are imported modules (see [Interfaces and Services](#interfaces-and-services)). |
| 4. A component knows only its props | Followed by the small ones | `NodeLabel`, `Ports`, `icons`, `XmlView`, `Splitter` and the inner `SearchBox`, `GroupHeader`, `ToolButton` know only their props. 9 of 16 component files read the store, and the code calls `getState()` 69 times. |
| 5. Props down, callbacks up | Kept | Inputs are controlled; `Splitter`, `Problems` and `SearchBox` report through `onChange` and `onToggle`. |
| 6. Hooks as view models | Replaced by the project | Commands are plain functions in `actions.ts` over `useStore.getState()`, a documented choice ([Commands](ARCHITECTURE.md#commands)) that tests well without React. The only hook is `useAnalysis`. |
| 7. Thin components | Partly | See [Separation of Concerns](#separation-of-concerns). |
| 8. Effects at the edges | Mostly kept | 16 effects. The subscriptions in `App` and `SettingsMenu` have cleanups. Two set state from state: `Browser` lines 143 to 146 and `AddNodeDialog` line 70; `FolderDialog` line 26 starts a request without a cleanup. |
| 9. Async never blocks | Kept | Every request is awaited; parsing runs on the main thread, fast enough for tens of files. |
| 10. Progress and cancellation | Not followed | No `AbortController` in the client. A run can be stopped through rosbridge, but no request can. |
| 11. Stale work dropped | Not followed | No load, save, revert, validation or folder listing checks that its result is still wanted: findings 2, 3, 5 and 6. |
| 12. Errors as values | Partly | `save()` returns a `SaveResult`, and every failure ends as a toast or a message. `api.ts` throws, and there is no Error Boundary: a bug thrown while rendering blanks the whole page. |
| 13. Pure utility modules | Kept | [`execution.ts`](../src/client/execution.ts) is pure and has 28 tests; `src/shared` holds the rest. |
| 14. Storage keys in one file | Not followed | 4 keys in 3 files: `be.settings` in [`settings.ts`](../src/client/settings.ts) line 26, `be.left` and `be.right` in [`App.tsx`](../src/client/App.tsx) lines 32 and 33, `be.problems` in [`TreeEditor.tsx`](../src/client/components/TreeEditor.tsx) line 93. |

## Coupling and Duplication

- **The folder of the edits is kept twice**, as `root` in the store and as `loadedRoot` in `api.ts`, set by hand at lines 113 and 152 of [`documents.ts`](../src/client/store/documents.ts). Weight: low today, high if a third place opens a folder.
- **The run in progress is kept twice**, as `currentRun` in [`actions.ts`](../src/client/actions.ts) and as `execution.own` without `result` in the store. Weight: low.
- **The way a folder is reset** (`resetNavigation`, `resetUi`, empty `files` and `native`) is written twice, in `load()` and `openFolder()` of [`documents.ts`](../src/client/store/documents.ts). Weight: low.
- **Problems recomputes the fingerprint of every file** (`workspaceFingerprint`, a `JSON.stringify` of all contents) on each render, [`Problems.tsx`](../src/client/components/Problems.tsx) line 24, to tell a stale native check. Weight: low for tens of files.

## Testability and Tests

| What | Tested | How |
|---|---|---|
| The documents slice: load, undo, save, conflicts, revert, delete | Yes, 15 tests | [`store.test.ts`](../tests/store.test.ts), with the API replaced by `vi.mock()` and [`fakeServer.ts`](../tests/fakeServer.ts). |
| The commands | Yes, 11 tests | [`actions.test.ts`](../tests/actions.test.ts), with `choose` mocked. |
| rosbridge | Yes, 8 tests | [`ros.test.ts`](../tests/ros.test.ts), with a fake `WebSocket`. |
| The execution model and its slice | Yes, 28 tests | [`execution.test.ts`](../tests/execution.test.ts), missing from the table of [Tests](ARCHITECTURE.md#tests). |
| Navigation, Back and Forward | 1 test | `store.test.ts`. |
| Dialogs, settings, `useAnalysis`, the 16 components | No | No DOM environment (jsdom) and no React Testing Library in [`package.json`](../package.json). |
| Concurrency: two operations in flight | No | Findings 2, 3, 5 and 6 each fail a probe of a few lines. |

The missing seams: the API is a module, not an injected interface, so every test of the store mocks the module; `settings.ts` reads `window` when imported; and the rules held in `RunDialog`, `FolderDialog` and `Browser` can only be reached by rendering them.

## Implementation Issues

Ordered by severity. **File** says whether the issue can lose a user's file.

1. **A new file overwrites an XML file the editor does not list.** Verified. The server lists only behavior files ([`readBehaviorFiles`](../src/server/files.ts)), so a launch or configuration XML file in the folder is invisible, and `filePathError` checks a new path only against the files loaded ([`ids.ts`](../src/shared/ids.ts) line 21, called from [`Browser.tsx`](../src/client/components/Browser.tsx) line 32). Saving the new file gets a 412 with the file's ETag, and `saveFile` ([`actions.ts`](../src/client/actions.ts) lines 256 to 278) shows *"config.xml changed on disk: config.xml already exists since the editor loaded it, e.g. by hand or from another tab. Overwriting it loses that change"*, with **Overwrite** as the first choice. The probe chose it, and the launch file was replaced by a behavior tree. **File: yes.**
2. **A reload that read the disk before a save undoes the save on screen.** Verified. `load()` ([`documents.ts`](../src/client/store/documents.ts) lines 77 to 135) reads the folder, then keeps only the files that are dirty *when it returns*; a file saved meanwhile is clean, and is replaced by the version read before the save. The editor then shows the old content as saved. The next save is refused with "changed on disk", and the probe's **Overwrite** removed the saved edit from the file. This needs Reload, or the load after opening a folder, to overlap a save. **File: yes, its saved content.**
3. **Two saves of one file in flight report a false conflict.** Verified. `save()` sends the ETag the file had when it started (line 186), so a second save, e.g. Ctrl+S twice, or Ctrl+S then Run, which calls `saveAll()`, is refused with a 412 caused by the first. The dialog blames a change on disk; **Reload from disk** drops every edit made between the two saves, as the probe shows. **File: no; unsaved edits, yes.**
4. **A dialog closed by its backdrop or Escape never settles its promise.** Verified. `DialogHost` calls `close()` on a click on the backdrop and on Escape ([`dialogs.tsx`](../src/client/dialogs.tsx) lines 22 and 23), which removes the content without calling `done()`; `ConfirmForm` has no Escape handler of its own. Opening a dialog over another also drops the first one unsettled (line 13). So `saveFile()` waits forever after a conflict dialog closed that way, `saveAll()` with it, and the Run dialog, which a conflict dialog replaces, loses its error message when saving fails ([`RunDialog.tsx`](../src/client/components/RunDialog.tsx) line 31). **File: no.**
5. **A load of the old folder that ends late replaces the folder opened since.** Verified. Reload, then *Open folder* before the first answer: the first answer arrives last, and `load()` shows the old folder's files and sets `loadedRoot` to it while the server serves the new one. The server's `X-Behaviors-Root` check then refuses every save with 409, so nothing is written to the wrong folder, but edits made in that state can only be kept by opening the old folder again. **File: no.**
6. **A save that ends after another folder was opened writes into the new folder's state.** Verified. `save()` writes its result with `setFile({ ...get().files[path], ... })` (line 188) without checking that the folder or the file is still the one saved: the probe ends with a file entry named `undefined` in the new folder. With a file of the same path in the new folder, that file takes the old folder's ETag and baseline, shows unsaved, and its next save meets a false conflict. `revert()` (lines 198 to 215) and `runNative()` (lines 240 to 249) have the same gap. **File: no.**
7. **Undo after renaming a tree restores one file only.** Verified. `renameTree()` ([`actions.ts`](../src/client/actions.ts) lines 215 to 225) makes one undo step in each file it changes, and Undo acts on the current file: after Undo, the probe's tree is called `B` again while the SubTree of another file still includes `Bee`. The checks then report the broken reference. The rename also runs on blur ([`Inspector.tsx`](../src/client/components/Inspector.tsx) line 441), though the hint says "Press Enter to rename". **File: no.**
8. **A folder listing that answers late wins.** From reading. [`FolderDialog.tsx`](../src/client/components/FolderDialog.tsx) `go()` (lines 16 to 25) sets each listing as it arrives, so clicking two folders quickly can show, and then open, the first. Unsaved edits are still confirmed before they are dropped. **File: no.**
9. **No Error Boundary, and settings parsed without checking their shape.** From reading. `load()` of [`settings.ts`](../src/client/settings.ts) (lines 28 to 34) spreads whatever `localStorage` holds over the defaults; a `payloads` that is not an object throws in `RunForm` while rendering, and with no Error Boundary React removes the whole page, unsaved edits included until reload. **File: no; unsaved edits, yes, though only with a damaged `be.settings`.**
10. **`App` reads the store during render without subscribing**: `useStore.getState().files` at line 108 of [`App.tsx`](../src/client/App.tsx) decides the loading placeholder; it is right only because `loading` changes at the same time. **File: no.**

No security issue was found in the client: paths go to the server encoded part by part (`fileUrl`, [`api.ts`](../src/client/api.ts) line 55), and the server checks them with `safePath`.

## Recommendations

Ordered by value against effort; each fits one pull request.

1. **Tell a new file from a hidden one** (finding 1). Have the server answer 412 for `If-None-Match: *` with a flag, e.g. `exists: true`, and make `saveFile` show a different dialog for a file the editor never loaded: "config.xml already exists in the folder and is not a behavior file", with no Overwrite. Or list the paths of every XML file in `GET /api/workspace`, so that `filePathError` refuses them. Trade-off: one field in the API and in `openapi.ts`.
2. **One save at a time per file, and loads that do not undo saves** (findings 2, 3, 6). Keep a promise per path in the documents slice: a second `save()` waits for the first and then sends the new ETag. Number the loads, as pattern 11 says, and in `load()` keep a file's state when its ETag in the store is newer than the one read, i.e. the store saved it since. Check after every `await` that `root` is still the folder the work started in. Trade-off: about 30 lines in `documents.ts`, and 4 tests built on the probes of this review.
3. **Settle every dialog** (finding 4). Give `open()` the function that cancels the content, and call it from `close()` and from a new `open()`, so a backdrop click resolves `choose` as `undefined` and `confirm` as `false`. Trade-off: a few lines in `dialogs.tsx`, and the Run dialog should keep its state while a conflict dialog is shown, e.g. by asking for the conflicts before closing.
4. **Drop stale loads and listings** (findings 5, 8). A load counter in the slice, and an `ignore` flag in the effect of `FolderDialog`. Trade-off: small.
5. **One undo step for a rename everywhere** (finding 7). An `editMany(paths, change)` action that records one entry in a workspace-wide history, or at least a toast that says how many files to undo. Rename on Enter only. Trade-off: the undo model is per file today; a shared step is the larger change.
6. **An Error Boundary and settings checked on load** (finding 9). One boundary around each panel in `App.tsx`; `load()` of `settings.ts` keeps a stored value only when its type matches the default's. Trade-off: small.
7. **Services through one root, and keys in one file** (patterns 3 and 14). Make `api`, the rosbridge functions and the storage an object passed to the store creator, e.g. `createEditorStore(services)`, made in `main.tsx`; move `loadedRoot` into the store and pass it to the API calls; move the 4 storage keys into one `storageKeys.ts`. The tests then pass a fake API instead of `vi.mock()`. Trade-off: touches every test of the store; no change for the user.
8. **Move the rules out of components** (pattern 7). `newBehaviorFile`, `newTree`, the save-then-run of `RunDialog` and the discard check of `FolderDialog` into `actions.ts`, where `actions.test.ts` can reach them; replace the effect of `Browser` that switches the tab with a call in the commands that open a tree. Trade-off: moves code without changing behavior.
