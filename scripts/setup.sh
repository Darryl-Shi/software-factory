#!/usr/bin/env bash
# Install the dependencies (Node 24+, git). No credentials are needed for the tests or the scripted demo.
set -euo pipefail
cd "$(dirname "$0")/.."
npm ci
