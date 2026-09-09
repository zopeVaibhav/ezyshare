#!/usr/bin/env bash
# One-command setup: install, build, start, and print what to paste into Chrome.
set -euo pipefail
cd "$(dirname "$0")"

# ANSI-C quoting, so these hold real escape bytes and work inside a plain heredoc too.
GREEN=$'\033[0;32m'; RED=$'\033[0;31m'; CYAN=$'\033[0;36m'; BOLD=$'\033[1m'; RESET=$'\033[0m'
step() { printf "${CYAN}==>${RESET} %s\n" "$1"; }
fail() { printf "${RED}%s${RESET}\n" "$1" >&2; exit 1; }

AUTOSTART=1
NAME=""
for arg in "$@"; do
  case "$arg" in
    --no-autostart) AUTOSTART=0 ;;
    --name=*) NAME="${arg#--name=}" ;;
    -h|--help)
      echo "Usage: ./setup.sh [--name=\"Your Name\"] [--no-autostart]"
      exit 0 ;;
    *) fail "unknown option: $arg" ;;
  esac
done

step "Checking for bun"
if ! command -v bun >/dev/null 2>&1; then
  echo
  echo "bun is not installed. Install it, then run this again:"
  echo
  echo "    curl -fsSL https://bun.sh/install | bash"
  echo
  fail "Missing bun."
fi
printf "    bun %s\n" "$(bun --version)"

step "Installing dependencies"
bun install --silent >/dev/null 2>&1

step "Building the extension"
bun run build >/dev/null 2>&1

EXT_PATH="$(cd dist/extension && pwd)"

if [ "$AUTOSTART" -eq 1 ]; then
  step "Installing the login item so the daemon starts with your machine"
  if [ -n "$NAME" ]; then
    ./install-autostart.sh "$NAME" >/dev/null 2>&1
  else
    ./install-autostart.sh >/dev/null 2>&1
  fi
  printf "    daemon running, logs at ~/.ezyshare/daemon.log\n"
else
  step "Skipping the login item"
  printf "    start it yourself with: ./start.sh\n"
fi

if command -v pbcopy >/dev/null 2>&1; then
  printf "%s" "$EXT_PATH" | pbcopy
  COPIED=" (copied to your clipboard)"
else
  COPIED=""
fi

cat <<EOF

${GREEN}Done.${RESET} One manual step is left, because Chrome will not let a script install an extension.

  ${BOLD}1.${RESET} Open  chrome://extensions
  ${BOLD}2.${RESET} Turn on  Developer mode  (top right)
  ${BOLD}3.${RESET} Click  Load unpacked  and choose this folder${COPIED}:

       ${BOLD}${EXT_PATH}${RESET}

  ${BOLD}4.${RESET} Click the ezyshare icon in the toolbar.

Allow the firewall prompt the first time, or nobody will be able to reach you.
Everyone you want to share with runs these same steps on their own machine.
EOF
