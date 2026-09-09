const PORTS = [8787, 8788, 8789, 8790];
let base: string | null = null;

/*
    The daemon suggests --port 8788 when 8787 is busy, so hunt for it rather than
    hardcoding one port and reporting "daemon not running" forever.
*/
async function resolveBase(): Promise<string> {
    if (base) return base;

    const { daemonPort } = await chrome.storage.local.get("daemonPort");
    const known = typeof daemonPort === "number" ? daemonPort : null;
    const order = known ? [known, ...PORTS.filter((port) => port !== known)] : PORTS;

    for (const port of order) {
        try {
            const res = await fetch(`http://127.0.0.1:${port}/api/me`, {
                headers: { "x-ezyshare": "1" },
            });
            if (!res.ok) continue;
            base = `http://127.0.0.1:${port}`;
            await chrome.storage.local.set({ daemonPort: port });
            return base;
        } catch {
            /* try the next one */
        }
    }
    throw new Error("daemon not running");
}

export async function api<T>(path: string, options: RequestInit = {}): Promise<T> {
    const root = await resolveBase();
    let res: Response;

    try {
        res = await fetch(`${root}${path}`, {
            ...options,
            headers: {
                "x-ezyshare": "1",
                "content-type": "application/json",
                ...(options.headers ?? {}),
            },
        });
    } catch (err) {
        base = null;
        throw err;
    }

    if (!res.ok) {
        let detail = res.statusText;
        try {
            const body = (await res.json()) as { error?: string };
            detail = body.error ?? detail;
        } catch {
            /* not json */
        }
        throw new Error(detail);
    }

    return (await res.json()) as T;
}

export function sendLink(peerId: string, url: string, title: string) {
    return api<{ ok: true; to: string }>("/api/send", {
        method: "POST",
        body: JSON.stringify({ peerId, url, title }),
    });
}

export function errorText(err: unknown): string {
    return err instanceof Error ? err.message : String(err);
}
