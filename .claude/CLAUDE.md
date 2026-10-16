# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What This Repository Is

The StepIt Editor is a web application that edits the behavior trees of BehaviorTree.CPP 4: it opens a folder of tree XML files, shows each tree as an indented list, checks the trees as we type, saves the XML back, and runs a tree on a BehaviorTree.ROS2 server through rosbridge. How it is built: [docs/ARCHITECTURE.md](../docs/ARCHITECTURE.md). What it does and its HTTP API: the [README](../README.md).

## Working Environment

The preferred way is the Docker container, which also builds BehaviorTree.CPP for the native validator. Inside it the scripts of `bin/` are on the `PATH` and aliased:

```bash
./docker/dock.sh editor build                  # the image; the first build compiles BehaviorTree.CPP
./docker/dock.sh editor start ~/my_robot/behaviors   # a shell, with that folder mounted at ~/behaviors
update      # pnpm install
build       # vite build, then the native validator when BehaviorTree.CPP is installed
test        # typecheck + vitest
serve       # the editor on http://localhost:8080
dev         # Vite with hot reload
validate    # the command line validator
```

On the host, with Node.js 24 and `corepack enable`, call the scripts by path, e.g. `./bin/test.sh`, and set `BEHAVIORS_DIR` and `PORT` for `./bin/serve.sh`; the native validator is then skipped unless BehaviorTree.CPP is installed. One test file: `pnpm exec vitest run tests/xml.test.ts`.

## Architecture

It follows one idea: **the XML files are the truth**. The editor reads them into a model, lets us change the model, and writes them back with nothing lost.

| Folder | Runs in | Rule |
|---|---|---|
| `src/shared` | Browser and Node.js | The model, the XML parser and writer, the workspace index, the checks, the tree edits. **No I/O, no `node:` modules, no React**: it is what lets the editor, the server and the CLI agree on what a valid tree is. |
| `src/server` | Node.js | The HTTP API over the folder, the production server, the runner of the native validator. |
| `src/client` | Browser | The React user interface (React 19, zustand), its store and its commands. Imports only *types* from the server, never its code. |
| `src/cli` | Node.js | The command line validator, for CI and pre-commit hooks. |
| `validator` | Native | The C++ program that loads the files with BehaviorTree.CPP 4.10.0, the version the commander uses. |

The dependencies point one way: everything may use `shared`, and `shared` uses nothing else.

Easy to break:

- **Nothing is lost on save.** Comments and unknown elements, e.g. `<include>`, are kept; only BTCPP format 4 is supported. A change to the parser or the writer needs a round-trip test.
- **A file changed on disk is never overwritten unseen**: saving asks whether to overwrite or reload.
- **Only the main tree of a file is an objective** (`main_tree_to_execute`); the others are subtrees, which cannot be run, as in StepIt Commander.
- **The payload of a tree** is declared as the ports of its own `<SubTree>` model in a `<TreeNodesModel>`, the example after `e.g.` in the description.
- Every route of the HTTP API is described in `src/server/openapi.ts`, served at `/api/openapi.json`: a new route goes there too.

## Tests

vitest, in `tests/`, one file per part, with `tests/fakeServer.ts` for rosbridge and `tests/fixtures/` for the trees. `tests/native-real.test.ts` runs only where the native validator is built, i.e. in the container and in CI.

## CI

`.github/workflows/ci.yml`: typecheck, test and build with Node.js 24, and a job that builds the native validator against the ROS package of BehaviorTree.CPP and runs its tests.

## Architecture and Review Documents

For the `architect` and `reviewer` skills: what they cannot find out alone.

- `docs/ARCHITECTURE.md` follows the one idea above. Its sections, in order: Introduction, The Big Picture, The Layers, The Shared Core, The Server, The Native Validator, The Client, The Command Line Validator, Tests, How to Extend the Editor, Design Decisions and Trade-offs.
- **The review is a separate document, `docs/Review.md`**, opened with the date and the commit reviewed; `docs/ARCHITECTURE.md` describes the design and holds no review. Say whether an issue can lose a user's file.
- The first things to check: an import into `src/shared` of anything outside it, of a `node:` module or of React; client code that imports server code rather than types; a round trip of the XML that loses something.
- **Probes**: a throwaway test is a vitest file in `tests/`, run with `pnpm exec vitest run tests/<file>`, in the container when it needs the native validator.

## Conventions

- TypeScript strict; `pnpm run typecheck` must pass.
- Update the README (its HTTP API, its validation rules) and `docs/ARCHITECTURE.md` when the interface or a layer changes.
