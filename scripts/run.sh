#!/usr/bin/env bash
# Start the factory in the foreground without any credentials: scripted agents, a fake GitHub and a fake boat.dev on the
# local disk, sandbox off (the dry run's setup). The web UI listens on http://127.0.0.1:${PORT:-7317}; the link with
# its access token is printed and written to $FACTORY_DEV_HOME/web-url.
# For real use: bin/factory setup, then bin/factory serve (see README.md).
set -euo pipefail
cd "$(dirname "$0")/.."
HOME_DIR="${FACTORY_DEV_HOME:-$PWD/.factory-dev}"
PORT="${PORT:-7317}"
mkdir -p "$HOME_DIR"
if [ ! -f "$HOME_DIR/config.yaml" ]; then
	cat > "$HOME_DIR/config.yaml" <<YAML
version: 1
storage:
  kind: sqlite
  path: $HOME_DIR/factory.sqlite
workdir: $HOME_DIR/work
roles:
  architect: { model: scripted/architect }
  builder: { model: scripted/builder }
  helper: { model: scripted/helper }
  reviewer: { model: scripted/reviewer }
  qa: { model: scripted/qa }
  integrator: { model: scripted/integrator }
discussion:
  model: { model: scripted/discussant }
qa:
  enabled: false
sandbox:
  enabled: false
ci:
  noChecksTimeout: 5s
web:
  port: $PORT
YAML
fi
exec bin/factory serve --config "$HOME_DIR/config.yaml" --fake-github "$HOME_DIR/github" --fake-boat "$HOME_DIR/boat" --scripted --foreground
