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
- [The Neighbours](#the-neighbours)
- [Testability and Tests](#testability-and-tests)
- [Implementation Issues](#implementation-issues)
  - [Running and Stopping](#running-and-stopping)
  - [Saving and Loading](#saving-and-loading)
  - [The Server](#the-server)
  - [The XML and the Two Validators](#the-xml-and-the-two-validators)
  - [The Page](#the-page)
- [Security](#security)
- [Recommendations](#recommendations)

Reviewed on 2026-11-15, at commit `45588f4`. It judges the design that [docs/ARCHITECTURE.md](ARCHITECTURE.md) describes, and does not repeat it.

## Scope and Method

This review covers the whole module: the page in [`src/client`](../src/client) (32 files, 4,373 lines), the shared core in [`src/shared`](../src/shared) (1,460 lines), the server in [`src/server`](../src/server) (855 lines), the command line validator, the native validator in [`validator`](../validator) (275 lines), the 13 test files, and the neighbours: how the StepIt Macro rig starts the editor (`rig.launch.py`, section `launch.editor` of `rig.yaml`), the 16 objective files it edits there, the topic `/stepit_server/execution` of StepIt Commander, and the code written again in StepIt Camera's page and StepIt UI.

We read every file, and judged them against SOLID, separation of concerns, the boundaries of [The Layers](ARCHITECTURE.md#the-layers), testability, and the 14 patterns of our React skill. Where the architecture document or `CLAUDE.md` decides otherwise, e.g. commands as plain functions in `actions.ts` rather than hooks, or a server without authentication, the project wins: the review judges the choice and does not call it a defect.

Each suspected bug was reproduced with a throwaway Vitest probe mounted at `tests/probe`, run in the rig's image, then deleted: 8 probe files, about 150 cases. The probes of the server ran against the real `createApi` on a temporary folder and against `src/server/main.ts` on port 18086; those of the native validator against the program the rig builds, with BehaviorTree.CPP 4.10.0; those of the client against the in-memory server of [`fakeServer.ts`](../tests/fakeServer.ts) and a fake `WebSocket`. No goal was sent to a commander and no rig was started, so what a real rosbridge does is read from its source, and said so. A finding marked **verified** failed its probe; the others are **from reading**.

The whole suite, once: `tsc --noEmit` passes in 1.4 s, and `vitest run` passes 154 tests in 13 files in 4.3 s, the 6 of `native-real.test.ts` included, with `BTCPP_VALIDATOR_REAL` set to the rig's `build/editor-validator/btcpp_validate`. `bin/check-diagrams.sh` passes.

`src` is the code the review of 2026-10-16 read at `fac3127`: since then only `bin/check-diagrams.sh`, `bin/render-diagrams.sh`, `bin/test.sh` and the CI workflow changed. That review covered the client only. Its 10 findings are all still in the code, its 7 verified ones fail their probes again, and they are kept below, renumbered among the new ones.

## Verdict

The design is sound and small. The layers hold: `src/shared` imports nothing but xmldom, the client takes only types from the server, and one store with immutable documents gives undo, dirtiness and the checks without any derived state. The shared core is the best part: pure, 49 tests, and the rig's 16 objective files go through the parser and the writer with every element, attribute and comment kept.

The weaknesses are at the edges, where the editor meets something it does not own:

- **The robot.** The Execution tab decides that a run is over from the goal of this page, not from what the server publishes. Two verified paths end with the page showing a finished run and **no Stop button while the server still runs a tree**: a rosbridge connection that drops in the middle of a run (finding 1), and a commander that restarts and numbers its runs from 1 again (finding 2). Both are safety issues for the rig, though the Stop of StepIt UI, the gamepad and the cancel service still work.
- **The disk.** Two saves of one file in the same millisecond share one temporary file: the file left on disk is the start of one and the end of the other, and the server answers 200 (finding 7). A new file can replace an XML file the editor does not list (finding 8), and a reload in flight can hide a save (finding 9).
- **The network.** Two requests that any browser can send, `GET /%` and `GET //`, stop the production server (finding 14), and the rig does not start it again.
- **Asynchronous work in the page.** No load, save, revert, validation or listing is cancelled or checked for staleness, and a dialog closed by its backdrop never answers.

Measured against the React skill, the client is a well-kept store with module-level services around it: no composition root, 6 pieces of module state, 12 of the 16 component files read a store themselves, and the tests replace the API with `vi.mock()`.

## Structure and Boundaries

| Rule | Verdict | Evidence |
|---|---|---|
| `src/shared` imports nothing else, no `node:`, no React | Kept | Its only outside import is `@xmldom/xmldom`, in [`xml.ts`](../src/shared/xml.ts) line 7. |
| The client imports only types from the server | Kept | 4 imports, all `import type`: [`api.ts`](../src/client/api.ts) lines 3 and 4, [`store/types.ts`](../src/client/store/types.ts) line 12, [`FolderDialog.tsx`](../src/client/components/FolderDialog.tsx) line 5. |
| No `node:` module in the client | Kept | None. |
| The server and the CLI use `shared`; the CLI uses the server | Kept | 6 imports from the server into `shared`, 2 from the CLI into the server, none the other way. |
| The native validator shares no code with the rest | Kept, at a price | It takes the node models from the editor's parser through the manifest ([`native.ts`](../src/server/native.ts) lines 79 to 82), so "what BehaviorTree.CPP says" depends on `parseModels` being right. |
| Components render and call commands | Mostly kept | 4 commands live in components, see [Separation of Concerns](#separation-of-concerns); `ModelEditor` of [`Inspector.tsx`](../src/client/components/Inspector.tsx) calls `store.edit` itself (lines 143 to 149), as the architecture document says. |

The comment that opens [`store/types.ts`](../src/client/store/types.ts) still says "three slices" and lists four. [`workspace.ts`](../src/shared/workspace.ts) line 110 holds a comment that describes no function.

## Interfaces and Services

| Service | Where | Judgement |
|---|---|---|
| HTTP API, `api` | [`client/api.ts`](../src/client/api.ts) line 57 | A module object, imported by [`store/documents.ts`](../src/client/store/documents.ts) and `FolderDialog.tsx`. No interface; the tests replace the module with `vi.mock()`. |
| The folder the edits belong to, `loadedRoot` | `client/api.ts` line 22 | Mutable module state, a copy of the store's `root`, set by hand at 2 places of `documents.ts`. |
| rosbridge: `runTree`, `cancelAllGoals`, `followExecution` | [`ros.ts`](../src/client/ros.ts) | Plain functions, each over a `WebSocket` of its own: 3 connections for one rosbridge. Clean to test with a fake `WebSocket`. The price is in what they cannot share: nobody knows whether rosbridge is reachable, and a goal dies with its own socket (finding 1). |
| The run in progress, `currentRun` | [`actions.ts`](../src/client/actions.ts) line 292 | Module state outside the store, which holds `execution.own` for the same run; `endExecution` does not know which of them ended (finding 5). |
| Dialogs: `prompt`, `confirm`, `choose` | [`dialogs.tsx`](../src/client/dialogs.tsx) | A global store that holds JSX, opened from commands: right for this project. The flaw is how a dialog closes (finding 21). |
| Settings, `useSettings` | [`settings.ts`](../src/client/settings.ts) | A second store over `localStorage`, which reads `window.matchMedia` and sets the theme when the module is imported (lines 51 to 63): no test can import it without a browser. |
| The file API, `createApi` | [`server/api.ts`](../src/server/api.ts) | One closure, a chain of 11 `if` over `method path`, 68 lines. Readable at this size. It takes the folder and the base, so the tests build one on a temporary folder: the best seam of the module. |
| Files on disk | [`server/files.ts`](../src/server/files.ts) | Shared by the API and the CLI. `readBehaviorFiles` gives the ETag of the decoded text, `currentEtag` that of the bytes: two definitions of one value (finding 11). |
| The native validator | [`server/native.ts`](../src/server/native.ts), [`validator/main.cpp`](../validator/main.cpp) | A child process behind JSON in and JSON lines out, with a fake one for the tests: a good boundary. Nothing limits how many run at once. |

There is no composition root: [`main.tsx`](../src/client/main.tsx) imports `./settings` for its side effects and renders `App`, and every service is chosen by the module that imports it.

## Separation of Concerns

- **Rules in components.** [`Browser.tsx`](../src/client/components/Browser.tsx) holds `newBehaviorFile()` (lines 20 to 36), the command that creates a file; [`TreeEditor.tsx`](../src/client/components/TreeEditor.tsx) holds `newTree()` (lines 76 to 82); [`RunDialog.tsx`](../src/client/components/RunDialog.tsx) `start()` holds "save every file, then run" (lines 24 to 36); `FolderDialog.tsx` `open()` holds "ask before dropping unsaved edits, except for the folder already open" (lines 29 to 38). No test of `actions.ts` reaches them.
- **When a run is over is decided in three places**: `runTree` settles the promise when its socket closes ([`ros.ts`](../src/client/ros.ts) line 75), `endExecution` turns that into a result ([`store/execution.ts`](../src/client/store/execution.ts) line 95), and `ExecutionPanel` hides Stop when there is a result ([`ExecutionPanel.tsx`](../src/client/components/ExecutionPanel.tsx) line 136). None of them asks the server, which is the only one that knows.
- **Policy in an effect of a component.** `Browser.tsx` lines 142 to 146 switch the saved setting `browserTab` when the selected tree changes, and write it to `localStorage` on each navigation.
- **The server knows what a model is.** `validateNative` parses every file with the editor's parser to write the manifest. It is the documented way around a library with no API for `<TreeNodesModel>`, and it is kept in one function.
- **The analysis** is computed once in `App` and passed down: a documented choice, cheap to follow, and kept.

## SOLID

| Principle | Verdict | Where |
|---|---|---|
| Single responsibility | Partly violated | [`Inspector.tsx`](../src/client/components/Inspector.tsx), 538 lines, holds 9 components. [`store/documents.ts`](../src/client/store/documents.ts) mixes the state of the files with the calls to the server and the toasts. `applySnapshot` of `store/execution.ts` answers four questions in 29 lines: is it ours, has ours ended, is it the same run, is it new. |
| Open/closed | No violation found | A check is a `Rule` added to `RULES`; a command is a function added to `actions.ts`; a route is a branch of `createApi` and an entry of `openapi.ts`. |
| Liskov substitution | Not applicable | No hierarchy besides `ApiError` and `HttpError`. |
| Interface segregation | No violation found | The slices expose small sets of actions; `Rule` has 5 optional hooks. |
| Dependency inversion | Violated in the client | The store depends on the concrete `api` module (`documents.ts` line 6), the commands on the concrete `ros.ts` and `dialogs.tsx` (`actions.ts` lines 15 and 16). Kept in the server: `createApi(root, options)`. |

## The React Patterns

| Pattern | Verdict | Evidence |
|---|---|---|
| 1. One store | Kept | One store of four slices; `useSettings` is a second, documented one. Copies outside it: `loadedRoot` in `client/api.ts`, `currentRun` in `actions.ts`. |
| 2. Derive, never copy | Mostly kept | Dirtiness, the analysis and the staleness of the native check are derived. `Inspector.tsx` line 400 copies `tree.id` into state with an effect, though the component is keyed by `tree.uid`. Whether a run is running is a copy too: `execution.result`, set by the goal, while the last snapshot says `running` (findings 1 and 2). |
| 3. Injection and a composition root | Not followed | No provider; services are imported modules. |
| 4. A component knows only its props | Followed by the small ones | `NodeLabel`, `Ports`, `icons`, `XmlView` and `Splitter` know only their props. 12 of 16 component files read `useStore` or `useSettings`, and the client calls `getState()` 68 times. |
| 5. Props down, callbacks up | Kept | Inputs are controlled; `Splitter`, `Problems` and `SearchBox` report through `onChange` and `onToggle`. |
| 6. Hooks as view models | Replaced by the project | Commands are plain functions over `useStore.getState()`, a documented choice that tests well without React. The only hook is `useAnalysis`. |
| 7. Thin components | Partly | See [Separation of Concerns](#separation-of-concerns). |
| 8. Effects at the edges | Mostly kept | 16 effects. The subscriptions of `App` and `SettingsMenu` have cleanups. Two set state from state: `Browser` lines 143 to 146 and `AddNodeDialog` line 70; `FolderDialog` line 26 starts a request without a cleanup. |
| 9. Async never blocks | Kept | Parsing runs on the main thread: a 9.5 MB file took 1.3 s in the probe, far above any real objective. |
| 10. Progress and cancellation | Not followed | No `AbortController` in the client. A run can be stopped; no request can. |
| 11. Stale work dropped | Not followed | Findings 9, 10, 12, 13 and 23. |
| 12. Errors as values | Partly | `save()` returns a `SaveResult`; `runTree` resolves with a `RunResult` and never rejects. `client/api.ts` throws, and there is no Error Boundary. |
| 13. Pure utility modules | Kept | [`execution.ts`](../src/client/execution.ts) is pure and has 28 tests; `src/shared` holds the rest. |
| 14. Storage keys in one file | Not followed | 4 keys in 4 files: `be.settings` in `settings.ts` line 26 and again in [`index.html`](../index.html) line 12, `be.left` and `be.right` in `App.tsx`, `be.problems` in `TreeEditor.tsx`. |

## Coupling and Duplication

- **The folder of the edits is kept twice**, as `root` in the store and as `loadedRoot` in `client/api.ts`. Weight: low today.
- **The run in progress is kept twice**, as `currentRun` and as `execution.own`. Weight: medium, see finding 5.
- **The way a folder is reset** is written twice, in `load()` and `openFolder()` of `documents.ts`. Weight: low.
- **The ETag is computed in two ways**, see finding 11. Weight: medium.
- **The fake server repeats the preconditions of the real one** ([`fakeServer.ts`](../tests/fakeServer.ts) `check` against `checkPreconditions`), kept in step by hand; nothing runs the client against `createApi`. Weight: medium: the 15 store tests would pass with a server that answers differently.
- **The built-in nodes are listed twice**, in [`builtins.ts`](../src/shared/builtins.ts) and by the library: documented as a fallback, and the server prefers the library. Weight: low.
- **The settings store and its theme code exist three times**: [`settings.ts`](../src/client/settings.ts) here (63 lines), in StepIt Camera's page (68 lines, 31 lines apart from ours once the key is renamed) and in StepIt UI (80 lines), under three keys, `be.settings`, `stepit.settings` and `stepit-ui.settings`. The keys never meet: each page has its own port, so its own `localStorage`, and a theme chosen in one page is not the theme of the others. Weight: low, and no finding of this module alone.
- **The rosbridge client exists four times**: `ros.ts` here, and one in StepIt UI, StepIt Camera's page and the Freezer's page. StepIt UI cancels every goal with the same service call as `cancelAllGoals` (`ui/src/commander/commander.ts` line 44). Weight: low; they are four repositories' worth of independence.
- **The two diagram scripts are copied into every module**: `bin/render-diagrams.sh` exists in 4 texts over 6 places, ours differing from the commander's by the place of one comment; `bin/check-diagrams.sh` in 3 texts, ours equal to the commander's, the Freezer's and the motors'. No difference changes what they do. Weight: low.

## The Neighbours

- **The rig starts the editor without a base folder.** `rig.launch.py` sets `PORT`, `BEHAVIORS_DIR` and `BTCPP_VALIDATOR`, not `BEHAVIORS_BASE` nor `HOST`. So the *Open folder* dialog and `PUT /api/root` reach the whole home folder of the container's user, with the repository in it, on every network interface: see [Security](#security).
- **The rig does not start the editor again.** It is an `ExecuteProcess` without `respawn`: after finding 14 the editor is gone until the rig restarts.
- **14 of the rig's 16 objective files are not in the editor's layout.** Verified: only `stack.xml` and the examples of this repository come back byte for byte. The first save of any other rewrites it, from 2 changed lines (`mark_far.xml`) to 62 (`focus_stack.xml`, whose attributes wrapped by hand are joined into one line, and whose blank lines between steps go). Nothing is lost: the probe counted the same elements, attributes, comments and texts before and after in all 16. It is the documented price of one fixed layout, and it is paid in the diffs of the rig.
- **The run numbers of StepIt Commander start at 1 with each start** (`++runs_`, `stepit_server.cpp` line 148), and a snapshot carries nothing else that tells one life of the commander from the next: the cause of finding 2. A snapshot is published only when something changes, so a run that waits on a long move publishes nothing.
- **rosbridge does not cancel a goal when its client leaves**, from reading `send_action_goal.py` of the rig's image: it has no `finish()`. A run therefore outlives the page that started it, which is what the rig wants, and what makes finding 1 matter.
- **BehaviorTree.CPP is 4.10.0 on both sides**: the editor's own image builds that tag, and the rig links the validator against `ros-jazzy-behaviortree-cpp` 4.10.0.

## Testability and Tests

| What | Tested | How |
|---|---|---|
| Parser and writer | 12 cases | [`xml.test.ts`](../tests/xml.test.ts): the 4 examples byte for byte, comments in trees, `<include>`. Nothing the writer drops, and no file in another layout. |
| Checks, tree edits, workspace, payload | 20, 14, 9, 6 cases | Each rule alone, and the broken fixtures. |
| The file API | 20 cases | [`api.test.ts`](../tests/api.test.ts), the real `createApi` on a temporary folder. No two requests at once, no symlink, no hidden path. |
| The native validator | 3 and 6 cases | A fake program, and the real one where it is built. Nothing about types, includes or a program that dies. |
| The documents slice and the commands | 15 and 11 cases | Against `fakeServer.ts`, one operation at a time. |
| The run and its slice | 28 and 8 cases | [`execution.test.ts`](../tests/execution.test.ts), [`ros.test.ts`](../tests/ros.test.ts). The case "the run that replaced it" exists; "the connection drops", "the snapshot says running after the goal ended" and "the numbers start again" do not. |
| The production server, `main.ts` | No | The tests call `createApi`; finding 14 lives in the 12 lines around it. |
| Dialogs, settings, `useAnalysis`, the 16 components | No | No DOM environment and no React Testing Library. |
| Two operations in flight | No | Findings 7, 9, 10, 12 and 13 each fail a probe of a few lines. |
| The OpenAPI description | One direction | The test calls each described route; a route added to `createApi` and forgotten in `openapi.ts` passes. Today the 6 operations of the files, the folders and the validation are described, and the 3 routes of the documentation itself are not. |

The missing seams: the API of the client is a module, not an injected interface; `settings.ts` reads `window` when imported; the rules held in `RunDialog`, `FolderDialog` and `Browser` are reached only by rendering them; and `main.ts` starts listening when it is imported, so no test can hold its request handler.

## Implementation Issues

Ordered by severity inside each part, numbered across them. **File** says whether the issue can lose a user's file or edits; **Safety** whether it is a safety issue for a rig whose motors the objectives move.

### Running and Stopping

1. **A rosbridge connection that drops during a run of this editor ends the run on screen, and takes the Stop button away, while the server goes on.** Verified. `runTree` settles its promise with `outcome: 'failed'` when its socket closes ([`ros.ts`](../src/client/ros.ts) line 75); `endExecution` marks every running node halted; `ExecutionPanel` shows Stop only without a result (line 136). The probe then played the next snapshot of the same run, still `running: true`, as the page gets it once `followExecution` connects again: `applySnapshot` keeps the result ([`store/execution.ts`](../src/client/store/execution.ts) lines 75 to 79) and rewrites the statuses of that snapshot from running to halted. The page says "Could not run the tree" with every node halted, for a tree that is moving the rail. Only reloading the page brings a Stop back. **File: no. Safety: yes**: the page hides its own Stop and states the opposite of what the robot does; the Stop of StepIt UI and the gamepad still work.
2. **After a restart of the commander, a run started elsewhere can show as this editor's last run, ended.** Verified. A page that ran an objective as run 1 keeps `own: true, run: 1` with its result. The rig restarts and StepIt UI starts a stack, run 1 of the new commander: `applySnapshot` takes it for the end of our run (same line 75), keeps our tree ID and our result, and shows no Stop. The first run after each start has the number 1, so a page left open over a restart meets it. **File: no. Safety: yes**, as finding 1.
3. **A run of this editor that another client preempts can leave the page on "Aborted" while the other run moves.** From reading, with a probe of the store. While our run has no result, a snapshot of another run is stored and not shown; when our result arrives nothing shows that snapshot, and the next one comes only when the other run changes. It needs the first snapshot of the new run to reach the page before the result of ours, over two sockets; the existing test covers the other order. **File: no. Safety: yes, for as long as the new run publishes nothing.**
4. **Stop pressed before the goal's socket is open does nothing, and says nothing.** Verified. `cancel()` sends only on an open socket (`ros.ts` lines 105 to 109); the goal is sent when the socket opens, a moment later. The button stays, so a second press works. `cancelAllGoals` reports success for any answer that is not `result: false`, without reading the `return_code` of `CancelGoal` (from reading). **Safety: minor.**
5. **The result of one goal ends whatever run the page shows.** Verified at the level of `startRun`: `endExecution` takes no run, so with two goals of this page the result of the first ends the second on screen, as in finding 1. Reaching it needs the Run form submitted twice before React renders `saving` ([`RunDialog.tsx`](../src/client/components/RunDialog.tsx) line 39, from reading). **Safety: as finding 1, far less likely.**
6. **Nothing shows whether rosbridge is reachable.** From reading. `followExecution` connects again every 3 s and tells nobody; a run started elsewhere stays "Running" on a page whose connection is gone, and a connection that hangs without closing is never noticed. **Safety: it is the reason findings 1, 2 and 3 go unseen.**

### Saving and Loading

7. **Two saves of one file in the same millisecond mix their contents on disk.** Verified. `writeAtomically` names its temporary file from the process and `Date.now()` ([`server/api.ts`](../src/server/api.ts) line 180): two requests for one path in one millisecond write the same file, each from offset 0, and the first rename wins. With a short and a long body the probe found on disk the short document followed by the last 59 characters of the long one, in 2 of the first 7 rounds; the server answered 200 to one request, with an ETag that is not the file's, and 500 `ENOENT` to the other. Behind it is a check and a write that are two steps: `checkPreconditions` and the write are not one step (lines 258 to 260), so in 8 of 200 rounds both saves with the same `If-Match` were accepted and one was lost without a word. It needs two clients, or a script: one page sends the same content twice. **File: yes, it leaves a file that is neither version. Safety: no.**
8. **A new file overwrites an XML file the editor does not list.** Verified. The server lists only behavior files, so a launch or configuration file is invisible, and `filePathError` checks a new path against the loaded files only ([`ids.ts`](../src/shared/ids.ts) line 21). Saving the new file gets a 412, and `saveFile` ([`actions.ts`](../src/client/actions.ts) lines 256 to 278) shows "config.xml already exists since the editor loaded it, e.g. by hand or from another tab", with **Overwrite** first. The probe chose it, and the file was replaced by a tree. The rig's objectives folder holds no such file today. **File: yes. Safety: no.**
9. **A reload that read the disk before a save undoes the save on screen.** Verified. `load()` ([`documents.ts`](../src/client/store/documents.ts) lines 77 to 135) keeps only the files that are dirty when it returns; a file saved meanwhile is clean, and is replaced by the version read before the save. The next save is refused as "changed on disk", and **Overwrite** then removes the saved edit from the file. **File: yes, its saved content.**
10. **Two saves of one file in flight report a false conflict.** Verified: the first is saved, the second gets 412 with the ETag the first just wrote. Ctrl+S held down, or Ctrl+S then Run, does it. The dialog blames a change on disk; **Reload from disk** drops the edits made between the two. **File: no; unsaved edits, yes.**
11. **A file that is not valid UTF-8 can never be saved without the conflict dialog, and loses its characters.** Verified with one byte of Latin-1 in a file that declares `ISO-8859-1`. `readBehaviorFiles` decodes as UTF-8 and hashes the text ([`files.ts`](../src/server/files.ts) lines 60 and 61); `currentEtag` hashes the bytes (`server/api.ts` line 150). The two never agree, so every save answers "was changed on disk"; **Overwrite** then writes U+FFFD in place of each such byte, under a declaration the writer has changed to UTF-8. **File: yes, those characters.**
12. **A load of the old folder that ends late replaces the folder opened since.** Verified: the page then shows the old folder's files and name while the server serves the new one. The `X-Behaviors-Root` check refuses every save with 409, so nothing is written to the wrong folder. **File: no.**
13. **A save that ends after another folder was opened writes into the new folder's state.** Verified: `save()` stores its result with `setFile({ ...get().files[path], … })` (line 188), and the probe ends with an entry named `undefined` among the new folder's files. `revert()` and `runNative()` have the same gap. **File: no.**

### The Server

14. **One request stops the production server.** Verified on port 18086: `GET /%` and `GET //` each end the process. [`main.ts`](../src/server/main.ts) builds a `URL` (line 33) and calls `decodeURIComponent` (line 38) in the request handler with no `try`: the first throws `Invalid URL` for `//`, the second `URI malformed` for a bad escape. Under `/api/` the same bad escape answers 400, because `createApi` catches it. A mistyped address is enough, and anything that scans the network does it. The rig does not start the editor again. **File: unsaved edits stay in the page but cannot be saved until the server is back. Safety: no**: a page already open keeps its Stop, which goes to rosbridge; a page cannot be opened or reloaded.
15. **A symbolic link takes a path out of its folder.** Verified. `safePath` compares resolved strings, not real paths (`server/api.ts` lines 114 and 115): through a linked folder inside the behaviors folder, `PUT` wrote a file outside and `DELETE` removed one there. `folderPath` has the same gap: a link inside the base opened a folder outside it. `..`, encoded separators, absolute paths, a null byte and bad escapes are all refused, and so is leaving `dist`. A file may also be written where the list never shows it: `.git/hooks/x.xml` and a file named `.xml` were created. **File: yes, outside the folder, given a link. Safety: no.**
16. **Small wrong answers**, verified: a malformed `X-Behaviors-Root` answers 500, not 400 (`checkRoot` line 232); `{"files": [null]}` to `/api/validate` answers 500; a folder named `sub.xml` makes `PUT` and `DELETE` on it answer 500 with a path of the server. A file removed between the listing and the reading fails the whole `GET /api/workspace` (`Promise.all` in `readBehaviorFiles`, from reading). **File: no.**

### The XML and the Two Validators

17. **Saving drops more than the architecture document lists, without telling.** Verified on hand-made files; none of the rig's 16 files holds any of it today. The documented losses are confirmed: a comment between two models or inside one, an unknown element in `<TreeNodesModel>`, text, CDATA, processing instructions and a `<!DOCTYPE>` ([`xml.ts`](../src/shared/xml.ts) `parseModels`, lines 141, 143 and 150). Not listed, and also lost: the `ID` of `<Action ID="Action"/>`, which comes back as `<Action/>` (`parseNode` line 128 with `nodeXmlAttrs` line 203); markup inside a port's description, flattened to text; an empty `<description/>`; a reference to an entity declared in the file, written back as the text `&amp;j;`; a carriage return in an attribute. The file does not show as changed and nothing warns, while [`CLAUDE.md`](../.claude/CLAUDE.md) still promises "Nothing is lost on save". **File: yes: comments, mostly. Safety: no.**
18. **The editor and BehaviorTree.CPP disagree on what is XML.** Verified with both parsers on the same text. The editor refuses, and shows as unreadable, a file that starts with a byte order mark and a file whose comment holds `--`, e.g. `<!-- run with --fake -->`; the library loads both, so the robot runs a file the editor cannot open. The other way, `parseDocument` silences xmldom's errors (`onError: () => {}`, line 61) and accepts `<AlwaysSuccess name/>` and `name=x`, which the library refuses: the editor's checks report nothing, and the next save repairs the file to `name="name"`. **File: no. Safety: no.**
19. **"Authoritative" stops at the types, the directions and the duplicates.** Verified. For a node declared in a `<TreeNodesModel>`, the library accepts the word `many` in a port of type `int` and a literal in an output port, since `registerModel` builds each `PortInfo` without a type ([`main.cpp`](../validator/main.cpp) line 153); it also accepts the same tree ID in two files. The editor's checks report all three. The other way, only the library reports a script that does not parse (`_skipIf="a +* 1"`). The architecture document says so for the types. **File: no. Safety: no**: a wrong literal fails on the robot when the node reads it.
20. **The validator follows `<include>` out of its temporary folder, and one file can end it.** Verified: `<include path="/etc/passwd"/>` makes the library open that file ("Error parsing the XML … Line number=1"), and a file that includes itself ends the program after 0.2 s with "The validator exited with code 2". 3,000 nested decorators are refused cleanly by the library, 9.5 MB of nodes take 2 s, and an entity bomb does nothing. The 60 s limit of `run()` reports a killed program as "exited with code 2" too, without the word timeout (`native.ts` lines 25 and 105, from reading), and each `POST /api/validate` starts a program of its own, with no limit on how many. In the editor's parser, 20,000 nested elements throw `RangeError` out of `parseDocument`, which fails the whole folder with "Cannot load the behaviors" (verified). **File: no. Safety: no.**

### The Page

21. **A dialog closed by its backdrop or Escape never settles its promise.** Verified. `DialogHost` calls `close()` ([`dialogs.tsx`](../src/client/dialogs.tsx) lines 22 and 23), which removes the content without calling `done()`; a dialog opened over another drops the first unsettled. So `saveFile()` waits for ever after a conflict dialog closed that way, `saveAll()` with it, and the Run dialog, which a conflict dialog replaces, loses its message. **File: no.**
22. **Undo after renaming a tree restores one file only**, and the rename runs on blur though the hint says "Press Enter". Verified: after Undo the tree is `A` again while the other file still includes `Renamed`. **File: no.**
23. **A folder listing that answers late wins** ([`FolderDialog.tsx`](../src/client/components/FolderDialog.tsx) `go()`, lines 16 to 25). From reading. **File: no.**
24. **No Error Boundary, and settings parsed without checking their shape** ([`settings.ts`](../src/client/settings.ts) `load()`, lines 28 to 34): a damaged `be.settings` throws in `RunForm` while rendering, and React removes the page. From reading. **File: unsaved edits, with a damaged setting only.**
25. **`App` reads the store during render without subscribing** ([`App.tsx`](../src/client/App.tsx) line 108). From reading; right only because `loading` changes with it. **File: no.**

Suspicions that a probe disproved: the 60 s limit cannot be reached with size alone, as 10 MB, the largest body, validates in 2 s; an entity bomb expands in neither parser; no path with `..`, an encoded separator or an absolute part leaves the folder; a cross-origin page cannot write, as the preflight of its `PUT` is answered 405; and the rig's own objectives lose nothing on a save, including their comments inside trees and the descriptions of their payload ports.

## Security

The server has no authentication and listens on every interface: a documented choice, with a warning in the README, and in the rig the same network already reaches rosbridge, which runs any objective. We judge it against that, and three things go further than the choice needs:

- **In the rig the API reaches the home folder, not the objectives.** `BEHAVIORS_BASE` is not set, so `PUT /api/root` opens any folder under the home of the container's user, the repository included, and an unconditional `PUT` or `DELETE` (verified: both answer 200 without `If-Match`) then replaces or removes any `.xml` file there, e.g. a `package.xml`. Opening another folder also changes it for every page until someone opens the objectives again.
- **What is written is what the robot runs next.** An objective saved through the API runs on the next goal with no build, by the rig's design. An unauthenticated write is therefore a change to how the motors move. This is the one place where the choice is a safety matter, not only a matter of files.
- **The `Host` header is not checked**, so a page on another site whose name is made to resolve to the rig is same-origin with the API. From reading; the probe confirms a `PUT` with a foreign `Host` is accepted. `POST /api/validate` is accepted from any origin as a simple request (verified), which starts the validator.

No secret is stored or printed by the module.

## Recommendations

Ordered by value against effort; each fits one pull request.

1. **Let the server say whether a run is running** (findings 1, 2, 3, 5 and 6). In `store/execution.ts`, a snapshot with `running: true` shows as running, with Stop, whatever the goal of this page said; a socket that closes ends the goal as "connection lost: the run may still be going", not as failed; `endExecution` takes the run it ends; and the header shows whether rosbridge is connected. In the commander, add to each snapshot something that changes with each start, e.g. its start time, and compare it with the number. Trade-off: about 40 lines and 4 tests here; one field in the commander's message, which is a change to a neighbour.
2. **One write at a time per path, into a file of its own** (finding 7). A random suffix for the temporary file, and a map of promises by path so that the check and the write of one file never interleave. Trade-off: 15 lines in `server/api.ts`; the probe becomes the test.
3. **A server that survives any request** (findings 14 and 16). A `try` around the handler of `main.ts` that answers 400, with the handler exported so a test can call it; `respawn=True` in `rig.launch.py`. Trade-off: 10 lines, and one in the rig.
4. **Give the rig's editor its folder only** ([Security](#security)). `BEHAVIORS_BASE` set to the objectives folder in `rig.launch.py`. Then, here: answer 428 to a `PUT` or `DELETE` without a precondition, check `Host` against the address served, and compare real paths in `safePath` and `folderPath` (finding 15). Trade-off: the first is one line in the rig; the second breaks callers that rely on the unconditional writes the README documents.
5. **Tell a new file from a hidden one** (finding 8). List the paths of every XML file in `GET /api/workspace`, so that `filePathError` refuses them, or give the 412 of `If-None-Match: *` a dialog of its own with no Overwrite. Trade-off: one field in the API and in `openapi.ts`.
6. **One save at a time per file, and loads that do not undo saves** (findings 9, 10, 12, 13 and 23). A promise per path in the documents slice; a counter of loads; a check after every `await` that `root` is still the folder the work started in; an `ignore` flag in `FolderDialog`. Trade-off: about 40 lines and 5 tests built on the probes.
7. **Settle every dialog** (finding 21). `open()` takes the function that cancels the content, called by `close()` and by the next `open()`. Trade-off: a few lines; the Run dialog should ask for the conflicts before it closes.
8. **Keep what the writer drops, or say that it will** (findings 17 and 18). Comments on a model as on a node; unknown elements of `<TreeNodesModel>` as raw XML; the `ID` of an explicit node always written. For the rest, a warning when a file is loaded that holds what the model does not keep, counted as the probe did, and a parse error instead of a silent repair. Strip a byte order mark. Round-trip tests of the hard cases, and the sentence of `CLAUDE.md` made true. Trade-off: 2 fields in `types.ts`; the warning costs a second walk of each file.
9. **One ETag, over the bytes** (finding 11). `readBehaviorFiles` hashes the buffer and marks a file that does not decode as unreadable, so it is shown and never rewritten. Trade-off: small.
10. **Types for the dummy ports** (finding 19). Map the common type names, `int`, `double`, `bool`, `std::string`, to the library's types in `registerModel`, so the library checks their literals too. Trade-off: about 20 lines of C++, and 2 cases in `native-real.test.ts`; other types stay unchecked.
11. **One undo step for a rename everywhere**, **an Error Boundary and settings checked on load** (findings 22 and 24). Trade-off: the undo model is per file today; a shared step is the larger change.
12. **Services through one root, and keys in one file** (patterns 3 and 14). `createEditorStore(services)` made in `main.tsx`, with the API, rosbridge and the storage; `loadedRoot` and `currentRun` into the store; the 4 keys into one module. Run the store tests against `createApi` on a temporary folder, so the fake server stops repeating the real one. Trade-off: touches every test of the store; no change for the user.
13. **Move the rules out of components** (pattern 7): `newBehaviorFile`, `newTree`, the save-then-run and the discard check into `actions.ts`. Trade-off: moves code without changing behaviour.
14. **Test the OpenAPI description both ways**: a list of routes that `createApi` and the test share. Trade-off: turns the chain of `if` into a table, which is the larger part of the work.
