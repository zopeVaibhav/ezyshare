#!/usr/bin/env bash
# Install a macOS LaunchAgent so the ezyshare daemon starts at login and stays up.
set -euo pipefail
DIR="$(cd "$(dirname "$0")" && pwd)"
NODE="$(command -v node)"
LABEL="com.ezyshare.daemon"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
# No argument is the normal case: the daemon uses this Mac's own name.
# An explicit override is written verbatim into a login item, so it is restricted to
# characters that cannot break out of the plist XML or add extra ProgramArguments.
NAME="${1:-}"
NAME_ARGS=""
if [ -n "$NAME" ]; then
  if ! printf '%s' "$NAME" | grep -Eq '^[A-Za-z0-9 ._-]{1,64}$'; then
    echo "bad name: use 1-64 chars from letters, digits, space, dot, underscore, hyphen" >&2
    exit 1
  fi
  NAME_ARGS="
    <string>--name</string>
    <string>$NAME</string>"
fi

mkdir -p "$HOME/Library/LaunchAgents" "$HOME/.ezyshare"
chmod 700 "$HOME/.ezyshare"
cat > "$PLIST" <<PLISTEOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>$LABEL</string>
  <key>ProgramArguments</key>
  <array>
    <string>$NODE</string>
    <string>$DIR/daemon/ezyshare.mjs</string>$NAME_ARGS
  </array>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>StandardOutPath</key><string>$HOME/.ezyshare/daemon.log</string>
  <key>StandardErrorPath</key><string>$HOME/.ezyshare/daemon.log</string>
</dict>
</plist>
PLISTEOF

launchctl unload "$PLIST" 2>/dev/null || true
launchctl load "$PLIST"
echo "installed: $LABEL  (name: ${NAME:-auto})"
echo "logs:      ~/.ezyshare/daemon.log"
echo "remove:    launchctl unload $PLIST && rm $PLIST"
