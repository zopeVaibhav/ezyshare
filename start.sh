#!/usr/bin/env bash
# Start the ezyshare daemon in the foreground. Ctrl-C to stop.
set -euo pipefail
cd "$(dirname "$0")"
exec node daemon/ezyshare.mjs "$@"
