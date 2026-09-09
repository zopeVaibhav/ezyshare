const PORTS = [8787, 8788, 8789, 8790];
let base: string | null = null;

export type DaemonErrorCode =
    "unreachable" | "paired_elsewhere" | "bad_code" | "slow_down" | "request_failed";

export class DaemonError extends Error {
    code: DaemonErrorCode;

    constructor(code: DaemonErrorCode, message: string) {
        super(message);
        this.name = "DaemonError";
        this.code = code;
    }
}

async function errorBody(res: Response): Promise<{ code?: string; error?: string }> {
    try {
        return (await res.json()) as { code?: string; error?: string };
    } catch {
        return {};
    }
}

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

            if (res.ok) {
                base = `http://127.0.0.1:${port}`;
                await chrome.storage.local.set({ daemonPort: port });
                return base;
            }

            /*
                A daemon that answers is a daemon that is running. Treating its refusal as
                "wrong port" made a pairing conflict look identical to nothing listening,
                so the panel reported the one problem the user could not act on.
            */
            const body = await errorBody(res);
            if (body.code === "paired_elsewhere") {
                base = `http://127.0.0.1:${port}`;
                await chrome.storage.local.set({ daemonPort: port });
                throw new DaemonError("paired_elsewhere", body.error ?? "already paired");
            }
        } catch (err) {
            if (err instanceof DaemonError) throw err;
            /* try the next one */
        }
    }
    throw new DaemonError("unreachable", "daemon not running");
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
        const body = await errorBody(res);
        const detail = body.error ?? res.statusText;
        if (body.code === "paired_elsewhere") throw new DaemonError("paired_elsewhere", detail);
        if (body.code === "bad_code") throw new DaemonError("bad_code", detail);
        if (body.code === "slow_down") throw new DaemonError("slow_down", detail);
        throw new DaemonError("request_failed", detail);
    }

    return (await res.json()) as T;
}

/*
    The one call a locked-out extension is allowed to make. Needs a code the daemon printed
    to its own log, so another extension cannot simply take the pairing whenever it likes.
*/
export function claimPairing(code: string) {
    return api<{ ok: true }>("/api/pairing/claim", {
        method: "POST",
        body: JSON.stringify({ code }),
    });
}

export function isPairingConflict(err: unknown): boolean {
    return err instanceof DaemonError && err.code === "paired_elsewhere";
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
