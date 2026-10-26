#!/bin/bash -e

# The scripts act on the workspace root, so move there. This lets them be
# called from anywhere, e.g. via the aliases in the container.
cd "$(dirname "$(readlink -f "$0")")/.."

pnpm run typecheck
pnpm run test
bin/check-diagrams.sh
