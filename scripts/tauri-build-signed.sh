#!/usr/bin/env bash
# Production build with updater signing (same pattern as CI / Linux).
# On Windows, run from Git Bash so TAURI_SIGNING_PRIVATE_KEY matches `cat keyfile`.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"
export TAURI_SIGNING_PRIVATE_KEY="$(cat src-tauri/keys/updater.key)"
export TAURI_SIGNING_PRIVATE_KEY_PASSWORD=""
exec npm run tauri build
