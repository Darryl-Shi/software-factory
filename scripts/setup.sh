#!/usr/bin/env bash
# Install dependencies (no build step: bin/factory runs src/cli.ts through tsx).
set -euo pipefail
cd "$(dirname "$0")/.."
if [ -f package-lock.json ]; then npm ci; else npm install; fi
