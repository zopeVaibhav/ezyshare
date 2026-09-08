#!/usr/bin/env bash
# Install a macOS LaunchAgent so the ezyshare daemon starts at login and stays up.
set -euo pipefail
DIR="$(cd "$(dirname "$0")" && pwd)"
NODE="$(command -v node)"
LABEL="com.ezyshare.daemon"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
NAME="${1:-$(scutil --get ComputerName 2>/dev/null || hostname -s)}"

mkdir -p "$HOME/Library/LaunchAgents" "$HOME/.ezyshare"
cat > "$PLIST" <<PLISTEOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>$LABEL</string>
  <key>ProgramArguments</key>
  <array>
    <string>$NODE</string>
    <string>$DIR/daemon/ezyshare.mjs</string>
    <string>--name</string>
    <string>$NAME</string>
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
echo "installed: $LABEL  (name: $NAME)"
echo "logs:      ~/.ezyshare/daemon.log"
echo "remove:    launchctl unload $PLIST && rm $PLIST"
