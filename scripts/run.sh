#!/usr/bin/env bash
# Start the factory and its web UI in the foreground (default http://127.0.0.1:7317; the access link is printed).
# Needs a configured factory (bin/factory setup). Extra args go to `factory serve`, e.g. --port 7318.
# Without credentials, a dry-run factory can be browsed instead, see README "Quickstart".
set -euo pipefail
cd "$(dirname "$0")/.."
exec bin/factory serve --foreground "$@"
