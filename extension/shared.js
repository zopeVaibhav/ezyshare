// Shared helpers for talking to the local ezyshare daemon.
const PORTS = [8787, 8788, 8789, 8790];
let base = null;

// The daemon tells people to try --port 8788 when 8787 is busy, so hunting for it beats
// hardcoding one port and reporting "daemon not running" forever.
async function resolveBase() {
    if (base) return base;
    const { daemonPort } = await chrome.storage.local.get("daemonPort");
    const order = daemonPort ? [daemonPort, ...PORTS.filter((p) => p !== daemonPort)] : PORTS;
    for (const port of order) {
        try {
            const res = await fetch(`http://127.0.0.1:${port}/api/me`, {
                headers: { "x-ezyshare": "1" },
            });
            if (res.ok) {
                base = `http://127.0.0.1:${port}`;
                await chrome.storage.local.set({ daemonPort: port });
                return base;
            }
        } catch {
            /* try the next one */
        }
    }
    throw new Error("daemon not running");
}

export async function api(path, options = {}) {
    const root = await resolveBase();
    let res;
    try {
        res = await fetch(`${root}${path}`, {
            ...options,
            headers: {
                "x-ezyshare": "1",
                "content-type": "application/json",
                ...(options.headers || {}),
            },
        });
    } catch (err) {
        base = null;
        throw err;
    }
    if (!res.ok) {
        let detail = res.statusText;
        try {
            detail = (await res.json()).error || detail;
        } catch {
            /* not json */
        }
        throw new Error(detail);
    }
    return res.json();
}

export function sendLink(peerId, url, title) {
    return api("/api/send", { method: "POST", body: JSON.stringify({ peerId, url, title }) });
}
