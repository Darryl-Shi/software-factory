#!/usr/bin/env bash
# Install dependencies. No build step: bin/factory runs src/cli.ts through tsx.
set -euo pipefail
cd "$(dirname "$0")/.."
npm ci --no-audit --no-fund
