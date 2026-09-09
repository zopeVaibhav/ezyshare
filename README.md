# ezyshare

Drop a link on a friend's name in the Chrome side panel. It pops up on their machine and opens in their browser. Same wifi, no cloud, no account, no WhatsApp copy-paste.

## How it works

Chrome extensions cannot see the local network on their own, so each machine runs a tiny Node daemon:

```
your Chrome  --(localhost HTTP)-->  your daemon  --(LAN HTTP)-->  friend's daemon  --> friend's Chrome
                                         |                              |
                                         +------ UDP broadcast ---------+
                                             (peer discovery, port 38477)
```

- **Discovery**: every daemon broadcasts `{id, name, port}` on UDP 38477 every 3s. Peers that go quiet for 12s disappear from the list.
- **Transfer**: sending is a plain `POST /inbox` from your daemon straight to your friend's daemon. The link never leaves the LAN.
- **Notification**: the extension long-polls its own daemon, so a delivered link raises a Chrome notification within a second. Clicking it opens the tab.
- **Persistence**: the inbox is stored in `~/.ezyshare/inbox.json`, so links survive a browser or daemon restart.

Zero npm dependencies. Node 18+ is the only requirement.

## Install (do this on every machine)

Needs Node 18+ on each machine. Check with `node -v`; get it from https://nodejs.org.

1. Copy this folder to the machine.
2. Start the daemon.

   macOS / Linux:
   ```bash
   ./start.sh
   ```

   Windows: double-click `start.cmd`.

   No arguments needed. Other people see this machine's own name — whatever macOS
   System Settings, or Windows, already calls it. Override it with `--name "Something Else"`
   only if you want to.

   Approve the firewall prompt the first time so other machines can reach you.
   On Windows tick **Private networks**; on macOS click **Allow**.
3. Load the extension: open `chrome://extensions`, turn on **Developer mode**, click **Load unpacked**, pick the `extension/` folder.
4. Click the ezyshare toolbar icon to open the side panel. Your friend's name shows up within a few seconds.

### Keep it running after every login

macOS:
```bash
./install-autostart.sh
```

Windows: double-click `install-autostart.cmd`.

Both take an optional name argument, same as `start.sh`.
Drops a hidden launcher in your Startup folder. Undo with `uninstall-autostart.cmd`.

Linux (systemd user service):
```bash
mkdir -p ~/.config/systemd/user
cat > ~/.config/systemd/user/ezyshare.service <<EOF
[Unit]
Description=ezyshare daemon
[Service]
ExecStart=$(command -v node) $PWD/daemon/ezyshare.mjs --name "$(hostname)"
Restart=always
[Install]
WantedBy=default.target
EOF
systemctl --user enable --now ezyshare
```

## Turning it on and off

The daemon runs all the time; the switch in the top right of the side panel controls whether you are actually sharing.

| Switch | What happens |
| --- | --- |
| **on** | you broadcast your name, peers see you, `/inbox` accepts links |
| **off** | broadcasting stops, your peer list empties, `/inbox` and `/whoami` return 503, and you disappear from everyone else's panel within 12 seconds |

The setting is written to `~/.ezyshare/config.json`, so it survives restarts. You never need the terminal for this.

## Sending a link

Three ways, all equivalent:

- **Drag** a link from any page onto a name card in the side panel.
- **Click** a name card to send the tab you are currently on.
- **Right-click** a link or page, then *ezyshare to… → name*.

The card flashes green on success, red with the reason on failure.

## Receiving

A notification says who sent it and what it is. Click it and the link opens in a new tab. Missed it? The side panel keeps the last 25 under **Received**, and the toolbar badge shows the unread count.

## Daemon flags

```
--name <str>            display name other people see (default: hostname)
--port <n>              http port (default 8787)
--discovery-port <n>    udp broadcast port (default 38477)
--peer <host:port>      add a peer by hand, repeatable
--dir <path>            state directory (default ~/.ezyshare)
```

`--peer` is the escape hatch for networks that block UDP broadcast (many guest and office APs). Point each machine at the other's LAN IP:

```bash
./start.sh --peer 192.168.1.42:8787
```

## Security

The daemon exposes two surfaces on port 8787, guarded differently:

| Route | Who can reach it | Gate |
| --- | --- | --- |
| `/api/*` | the extension | loopback source, **one pinned `chrome-extension://` origin**, and an `X-Ezyshare` header that forces a CORS preflight |
| `/inbox` | other ezyshare daemons on the LAN | `X-Ezyshare-Peer` header, `application/json` content type, **no `Origin` header**, rate limited |
| `/whoami` | anyone on the LAN | none, returns display name only |

What that buys you:

- **A web page in your browser cannot send or receive links.** Both routes require a custom header, which a page cannot set without a preflight, and neither route answers a preflight from a web origin. This is the gap that matters: without it, any site you visit could have popped a fake "Alice sent you a link" notification pointing at a phishing page.
- **Only your extension talks to the API.** The first `chrome-extension://` origin to call `/api` is pinned in `~/.ezyshare/config.json`; any other extension you install gets a 403. Use `--reset-pairing` if you reload the extension under a new ID.
- **Sender names are verified, not claimed.** An incoming link is labelled with a peer's name only when the claimed ID matches a peer already known at that exact source address. Anything else shows as `unknown (<ip>)` with a red bar in the panel and an "Unverified sender" notification.
- **Peer IDs cannot be stolen.** A peer ID stays bound to the address that first announced it until its TTL expires, so someone who overhears your broadcast cannot re-announce your ID from their machine and silently receive the links meant for you.
- **Announces are only accepted from your own subnet**, and the peer list is capped. A spoofed announce pointing at `127.0.0.1` or `169.254.169.254` is dropped, so a click can never be turned into a probe of your own machine. Send errors are deliberately vague for the same reason.
- **Inbound links must be non-loopback `http`/`https`.** `javascript:`, `file:`, `data:` and `http://127.0.0.1/...` are all refused, on the wire and when reloading `~/.ezyshare/inbox.json` from disk.
- **Floods are capped**: 12 links per source address per minute, and more than 3 at once collapse into a single notification instead of a wall of sticky ones.
- **State files** (`id`, `config.json`, `inbox.json`) are written `0600` in a `0700` directory, and the daemon re-applies that mode on every start in case an installer created the directory first. The log records hostnames, never full URLs.
- **A malformed request cannot kill the daemon.** A JSON body that parses to something other than an object is replaced with an empty one, and the process survives an unhandled rejection rather than exiting.
- **One address cannot fill the peer list.** New peer ids are capped at 4 per source address per minute, so hiding your real peers behind 256 fakes would take 64 distinct machines.

What it still does not do:

- **No pairing secret.** Any ezyshare daemon on your wifi can send you a link. It will be labelled with a verified name if it is a known peer, but there is no allowlist. Do not run this on public wifi.
- **Plain HTTP on the LAN.** Anyone who can sniff the network sees the links you share.
- **`/api` trusts the local machine.** Another user account or a compromised process on your own machine can read your inbox, clear it, turn sharing off, and send links as you — the origin pin only constrains callers that send an `Origin` header, and a non-browser caller simply omits it. A token file read by both sides would fix this.
- **Verification is by source address.** Two peers behind the same address — anything on your own machine, or a manual `--peer` pointing at localhost — can claim each other's identity.

## Troubleshooting

**Side panel says "Daemon not running"** — start it, then hit Refresh.

**Windows: `start.cmd` flashes and closes** — Node is not installed or not on PATH. Install from nodejs.org, reopen the terminal.

**Friend's name never appears** — check both daemons print the same LAN subnet in their startup banner, and that the firewall allows Node to accept incoming connections (macOS: System Settings → Network → Firewall → Options; Windows: Windows Defender Firewall → Allow an app, tick **Private**). If the network blocks broadcast, use `--peer`.

**"could not reach <name>"** — their daemon died or the firewall is blocking port 8787.

**No notification** — check Chrome notification permission for the extension in System Settings → Notifications → Google Chrome.

**"another extension is already paired"** — you reloaded the extension and Chrome gave it a new ID. Restart the daemon once with `--reset-pairing`, or delete `extensionOrigin` from `~/.ezyshare/config.json`.

**Everyone vanished and nothing sends** — check the switch in the top right of the side panel. Off means invisible.

## Known limits

- Links only, no files.
- No pairing secret yet: any ezyshare daemon on the LAN can send to you, though unknown senders are flagged.
- Traffic is plain HTTP on the LAN.
- Chrome / Chromium only. Daemon runs on macOS, Windows and Linux.
