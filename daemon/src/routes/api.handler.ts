import crypto from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import { MAC_HEADER, PEER_HEADER } from "../constants.ts";
import { json, readBody } from "../http.ts";
import { readPayload, sendPayload, statePayload } from "../schemas/api.payload.ts";
import type { ConfigStore } from "../config.store.ts";
import type { Discovery } from "../discovery.ts";
import type { Identity } from "../ezyshare.type.ts";
import type { InboxStore } from "../inbox.store.ts";
import type { PeerStore } from "../peers.store.ts";
import type { Signer } from "../secret.ts";

export type ApiDeps = {
    self: Identity;
    config: ConfigStore;
    peers: PeerStore;
    inbox: InboxStore;
    signer: Signer | null;
    discovery: Discovery;
};

export function handleMe(res: ServerResponse, deps: ApiDeps): void {
    json(res, 200, {
        id: deps.self.id,
        name: deps.self.name,
        port: deps.self.port,
        seq: deps.inbox.seq(),
        enabled: deps.config.current.enabled,
    });
}

export function handlePeers(res: ServerResponse, deps: ApiDeps): void {
    /*
        `secured` lets the panel tell the user whether a shared secret is in force. It is a
        boolean on purpose: the secret itself never leaves the daemon.
    */
    json(res, 200, {
        me: { id: deps.self.id, name: deps.self.name },
        enabled: deps.config.current.enabled,
        secured: deps.signer !== null,
        peers: deps.config.current.enabled ? deps.peers.list() : [],
    });
}

export async function handleState(
    req: IncomingMessage,
    res: ServerResponse,
    deps: ApiDeps,
): Promise<void> {
    if (req.method === "POST") {
        let body;
        try {
            body = await readBody(req);
        } catch {
            return json(res, 400, { error: "bad body" });
        }
        const parsed = statePayload.safeParse(body.data);
        const next = parsed.success && parsed.data.enabled === true;

        if (next !== deps.config.current.enabled) {
            deps.config.current.enabled = next;
            deps.config.save();
            deps.peers.clear();
            if (next) deps.discovery.announce();
            console.log(next ? "sharing on" : "sharing off (invisible to peers)");
        }
    }
    json(res, 200, { enabled: deps.config.current.enabled });
}

export async function handleSend(
    req: IncomingMessage,
    res: ServerResponse,
    deps: ApiDeps,
): Promise<void> {
    if (!deps.config.current.enabled) return json(res, 409, { error: "sharing is off" });

    let body;
    try {
        body = await readBody(req);
    } catch {
        return json(res, 400, { error: "bad body" });
    }

    const parsed = sendPayload.safeParse(body.data);
    if (!parsed.success) {
        return json(res, 400, { error: "url must be a non-loopback http or https link" });
    }

    const peer = deps.peers.get(parsed.data.peerId);
    if (!peer) return json(res, 404, { error: "peer not found" });

    const payload: Record<string, unknown> = {
        fromId: deps.self.id,
        url: parsed.data.url,
        title: parsed.data.title ?? "",
    };
    if (deps.signer) {
        payload.ts = Date.now();
        payload.nonce = crypto.randomBytes(16).toString("hex");
    }

    const rawOut = JSON.stringify(payload);
    const headers: Record<string, string> = {
        "content-type": "application/json",
        [PEER_HEADER]: "1",
    };
    if (deps.signer) headers[MAC_HEADER] = deps.signer.inboxMac(rawOut);

    try {
        const response = await fetch(`http://${peer.addr}:${peer.port}/inbox`, {
            method: "POST",
            headers,
            body: rawOut,
            signal: AbortSignal.timeout(5000),
        });
        /*
            Deliberately vague. Relaying the peer's status or the socket error would turn one
            click into a port scanner for whatever address that peer record points at.
        */
        if (!response.ok) return json(res, 502, { error: `${peer.name} refused it` });
    } catch {
        return json(res, 502, { error: `could not reach ${peer.name}` });
    }

    console.log(`  out ${peer.name}: ${new URL(parsed.data.url).hostname}`);
    json(res, 200, { ok: true, to: peer.name });
}

export function handleInboxRead(
    req: IncomingMessage,
    res: ServerResponse,
    url: URL,
    deps: ApiDeps,
): void {
    const since = Number(url.searchParams.get("since") ?? 0);
    const wait = Math.min(Math.max(Number(url.searchParams.get("wait")) || 0, 0), 60_000);

    const reply = () => json(res, 200, { seq: deps.inbox.seq(), items: deps.inbox.since(since) });
    if (deps.inbox.since(since).length > 0 || wait === 0) return reply();

    let done = false;
    const finish = () => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        cancel();
        reply();
    };
    const timer = setTimeout(finish, wait);
    const cancel = deps.inbox.wait(finish);

    req.on("close", () => {
        done = true;
        clearTimeout(timer);
        cancel();
    });
}

export async function handleMarkRead(
    req: IncomingMessage,
    res: ServerResponse,
    deps: ApiDeps,
): Promise<void> {
    let body;
    try {
        body = await readBody(req);
    } catch {
        return json(res, 400, { error: "bad body" });
    }
    const parsed = readPayload.safeParse(body.data);
    const ids = new Set(parsed.success ? (parsed.data.ids ?? []) : []);
    const all = parsed.success && parsed.data.all === true;
    json(res, 200, { ok: true, unread: deps.inbox.markRead(ids, all) });
}

export function handleClear(res: ServerResponse, deps: ApiDeps): void {
    deps.inbox.clear();
    json(res, 200, { ok: true });
}
