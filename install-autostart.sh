#!/usr/bin/env bash
# Start the ezyshare daemon at login. macOS uses a LaunchAgent, Linux a systemd user unit.
set -euo pipefail
DIR="$(cd "$(dirname "$0")" && pwd)"

RUNTIME="$(command -v bun || command -v node || true)"
if [ -z "$RUNTIME" ]; then
  echo "Neither bun nor node found. Install bun from https://bun.sh" >&2
  exit 1
fi

# The name is written into a login item, so restrict it to characters that cannot break
# out of the plist XML or the unit file and add arguments of their own.
NAME="${1:-}"
if [ -n "$NAME" ] && ! printf '%s' "$NAME" | grep -Eq '^[A-Za-z0-9 ._-]{1,64}$'; then
  echo "bad name: use 1-64 chars from letters, digits, space, dot, underscore, hyphen" >&2
  exit 1
fi

mkdir -p "$HOME/.ezyshare"
chmod 700 "$HOME/.ezyshare"

case "$(uname -s)" in
  Darwin)
    LABEL="com.ezyshare.daemon"
    PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
    NAME_ARGS=""
    if [ -n "$NAME" ]; then
      NAME_ARGS="
    <string>--name</string>
    <string>$NAME</string>"
    fi

    mkdir -p "$HOME/Library/LaunchAgents"
    cat > "$PLIST" <<PLISTEOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>$LABEL</string>
  <key>ProgramArguments</key>
  <array>
    <string>$RUNTIME</string>
    <string>$DIR/daemon/ezyshare.ts</string>$NAME_ARGS
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
    ;;

  Linux)
    if ! command -v systemctl >/dev/null 2>&1; then
      echo "No systemd here, so there is nothing to install. Run ./start.sh yourself." >&2
      exit 1
    fi

    UNIT="$HOME/.config/systemd/user/ezyshare.service"
    NAME_ARGS=""
    [ -n "$NAME" ] && NAME_ARGS=" --name \"$NAME\""

    mkdir -p "$(dirname "$UNIT")"
    cat > "$UNIT" <<UNITEOF
[Unit]
Description=ezyshare daemon

[Service]
ExecStart=$RUNTIME $DIR/daemon/ezyshare.ts$NAME_ARGS
Restart=always
RestartSec=3

[Install]
WantedBy=default.target
UNITEOF

    systemctl --user daemon-reload
    systemctl --user enable --now ezyshare
    echo "installed: ezyshare.service  (name: ${NAME:-auto})"
    echo "logs:      journalctl --user -u ezyshare -f"
    echo "remove:    systemctl --user disable --now ezyshare && rm $UNIT"
    ;;

  *)
    echo "Unsupported system: $(uname -s). On Windows use install-autostart.cmd." >&2
    exit 1
    ;;
esac
