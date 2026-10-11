#!/usr/bin/env bash
# Start the factory in the foreground with its web UI (default http://127.0.0.1:7317/?token=…; the link is printed).
# Without credentials: FACTORY_DEMO=1 runs a dry run first (scripted agents, fake GitHub/boat) and serves its data.
set -euo pipefail
cd "$(dirname "$0")/.."
[ -d node_modules ] || npm ci
if [ "${FACTORY_DEMO:-}" = "1" ]; then
	dir="${DRYRUN_DIR:-$PWD/.dryrun}"
	[ -f "$dir/config.yaml" ] || DRYRUN_DIR="$dir" DRYRUN_SANDBOX="${DRYRUN_SANDBOX:-0}" npm run dry-run
	exec env DRYRUN_BOAT_KEY="${DRYRUN_BOAT_KEY:-x}" bin/factory serve --foreground --config "$dir/config.yaml" --fake-github "$dir/github" --fake-boat "$dir/boat" --scripted "$@"
fi
exec bin/factory serve --foreground "$@"
