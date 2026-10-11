#!/usr/bin/env bash
# Start the factory with scripted agents, a fake GitHub and a fake boat.dev (no credentials needed), in the
# foreground, on http://127.0.0.1:${PORT:-7317}. The first start runs the dry run once to seed .dryrun/ with
# projects, runs and a discussion (about 3 minutes). It prints the link with its access token.
#   PORT=8000 scripts/run.sh
set -euo pipefail
cd "$(dirname "$0")/.."
[ -d node_modules ] || npm ci
if [ ! -f .dryrun/config.yaml ]; then
	DRYRUN_SANDBOX="${DRYRUN_SANDBOX:-0}" DRYRUN_DIR="$PWD/.dryrun" npm run dry-run
fi
export DRYRUN_BOAT_KEY="${DRYRUN_BOAT_KEY:-x}"
exec bin/factory serve --foreground --port "${PORT:-7317}" --config .dryrun/config.yaml \
	--fake-github .dryrun/github --fake-boat .dryrun/boat --scripted
