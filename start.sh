#!/usr/bin/env bash
# Start the ezyshare daemon in the foreground. Ctrl-C to stop.
set -euo pipefail
cd "$(dirname "$0")"

if command -v bun >/dev/null 2>&1; then
  exec bun daemon/ezyshare.ts "$@"
fi

# Node 22.6+ runs TypeScript directly, so it works as a fallback.
if command -v node >/dev/null 2>&1; then
  exec node daemon/ezyshare.ts "$@"
fi

echo "Neither bun nor node found. Install bun from https://bun.sh" >&2
exit 1
