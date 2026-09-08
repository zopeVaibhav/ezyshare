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
   ./start.sh --name "Your Name"
   ```

   Windows (double-click `start.cmd`, or from a terminal):
   ```bat
   start.cmd --name "Your Name"
   ```

   Approve the firewall prompt the first time so other machines can reach you.
   On Windows tick **Private networks**; on macOS click **Allow**.
3. Load the extension: open `chrome://extensions`, turn on **Developer mode**, click **Load unpacked**, pick the `extension/` folder.
4. Click the ezyshare toolbar icon to open the side panel. Your friend's name shows up within a few seconds.

### Keep it running after every login

macOS:
```bash
./install-autostart.sh "Your Name"
```

Windows (double-click, or pass a name):
```bat
install-autostart.cmd "Your Name"
```
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
./start.sh --name Alpha --peer 192.168.1.42:8787
```

## Security

The daemon exposes two separate surfaces on port 8787:

| Route | Who can reach it | What it does |
| --- | --- | --- |
| `/api/*` | loopback only, `chrome-extension://` origin only, custom header required | the extension's control API |
| `/inbox`, `/whoami` | anyone on the LAN | receives a link, reports the display name |

The custom-header requirement forces a CORS preflight, so a random web page in your browser cannot forge a send. Incoming links are validated as `http`/`https` and never opened automatically — you always click first.

Anyone on the same wifi can send you a link. That is the point, and it is also the limit: do not run this on untrusted public wifi. Pairing/allowlisting is the obvious next step.

## Troubleshooting

**Side panel says "Daemon not running"** — start it, then hit Refresh.

**Windows: `start.cmd` flashes and closes** — Node is not installed or not on PATH. Install from nodejs.org, reopen the terminal.

**Friend's name never appears** — check both daemons print the same LAN subnet in their startup banner, and that the firewall allows Node to accept incoming connections (macOS: System Settings → Network → Firewall → Options; Windows: Windows Defender Firewall → Allow an app, tick **Private**). If the network blocks broadcast, use `--peer`.

**"could not reach <name>"** — their daemon died or the firewall is blocking port 8787.

**No notification** — check Chrome notification permission for the extension in System Settings → Notifications → Google Chrome.

## Known limits

- Links only, no files.
- No pairing yet: any ezyshare daemon on the LAN can send to you.
- Traffic is plain HTTP on the LAN.
- Chrome / Chromium only. Daemon runs on macOS, Windows and Linux.
