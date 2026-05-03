#!/usr/bin/env bash
# Re-sign the NSIS updater .zip after a build (or if signing was skipped).
# Uses the same env pattern as tauri-build-signed.sh and a working `tauri build`.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"
VERSION="$(node -p "require('./package.json').version")"
ZIP="src-tauri/target/release/bundle/nsis/TaskManagerPlus_${VERSION}_x64-setup.nsis.zip"
export TAURI_SIGNING_PRIVATE_KEY="$(cat src-tauri/keys/updater.key)"
export TAURI_SIGNING_PRIVATE_KEY_PASSWORD=""
exec npx tauri signer sign "$ZIP"
