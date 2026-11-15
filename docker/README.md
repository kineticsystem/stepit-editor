# Running the editor inside a Docker container

The container user and password are:

**developer:developer**

## Prerequisites

First, you must install Docker.

```bash
curl -fsSL https://get.docker.com -o get-docker.sh
sudo sh get-docker.sh
```

## Build and start up a container

The container is defined in `docker-compose.yml`; `dock.sh` is a thin wrapper
that supplies the container name, the host uid/gid and the folder of behaviors,
then calls `docker compose`.

In the commands below, `<container-name>` is the name we give the container,
e.g. `editor`; every command needs it.

Build the image and create the container. The image contains Node.js, pnpm and
BehaviorTree.CPP, which is compiled from source, so the first build takes a few
minutes:

```bash
./docker/dock.sh <container-name> build
```

This is also how you pick up changes to the `Dockerfile`: it rebuilds only the
layers that changed, so there is no need to `clean` first.

The quickest way to use the editor: install, build and serve it on
<http://localhost:8080>, editing the behaviors in `folder`:

```bash
./docker/dock.sh <container-name> serve [folder]
```

Or start the container with an interactive shell:

```bash
./docker/dock.sh <container-name> start [folder]
```

The folder of behaviors is mounted in the container at `~/behaviors`. It
defaults to `$BEHAVIORS_DIR`, and then to the examples in `./behaviors`. Passing
a different folder than last time recreates the container, since a mount cannot
change on a running container. Set `EDITOR_PORT` (default 8080) or `DEV_PORT`
(default 5173) to publish the editor on other host ports.

Run this to stop the container:

```bash
./docker/dock.sh <container-name> stop
```

Finally, run this to remove the container and the image:

```bash
./docker/dock.sh <container-name> clean
```

## Working with the code

Inside the container, the repo is bind-mounted at `~/ws`. `~/ws/bin` is on the
`PATH` and the scripts are aliased, so these work from any directory:

```bash
update      # pnpm install
build       # bundle the editor into dist/, build the BehaviorTree.CPP validator
serve       # serve dist/ and the API on port 8080
dev         # or: the Vite development server with hot reload, on port 5173
test        # type-check, run the unit tests and check the diagrams
validate    # check ~/behaviors (or a given folder) from the command line
```

From a non-interactive shell (e.g. `docker exec <container-name> build.sh`),
call the scripts by their full names: `update.sh`, `build.sh`, and so on.

The interactive shell setup -- the aliases -- lives in `docker/bashrc`, which
the image installs as `~/.bashrc.editor`. Variables belong in the `Dockerfile`
as `ENV` instead, so that they apply to non-interactive commands too.
