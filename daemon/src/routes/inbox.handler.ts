import type { IncomingMessage, ServerResponse } from "node:http";
import { guardPeer } from "../guards.ts";
import { json, readBody } from "../http.ts";
import { remoteIp } from "../net.ts";
import { inboxPayload } from "../schemas/inbox.payload.ts";
import { clean } from "../text.ts";
import type { InboxStore } from "../inbox.store.ts";
import type { Limiter } from "../rate-limit.ts";
import type { PeerStore } from "../peers.store.ts";
import type { Signer } from "../secret.ts";

export type InboxDeps = {
    peers: PeerStore;
    inbox: InboxStore;
    signer: Signer | null;
    limit: Limiter;
};

export async function handleInbox(
    req: IncomingMessage,
    res: ServerResponse,
    deps: InboxDeps,
): Promise<void> {
    if (!guardPeer(req, res)) return;

    const ip = remoteIp(req);
    if (!deps.limit(ip)) return json(res, 429, { error: "slow down" });

    let body;
    try {
        body = await readBody(req);
    } catch {
        return json(res, 400, { error: "bad body" });
    }

    if (deps.signer) {
        const ts = Number(body.data.ts);
        if (!deps.signer.withinSkew(ts)) {
            return json(res, 401, { error: "stale or unsigned request" });
        }
        if (!deps.signer.matches(deps.signer.inboxMac(body.raw), req.headers["x-ezyshare-mac"])) {
            return json(res, 401, { error: "bad signature" });
        }
        if (!deps.signer.nonceIsNew(String(body.data.nonce ?? ""))) {
            return json(res, 401, { error: "replayed request" });
        }
    }

    const parsed = inboxPayload.safeParse(body.data);
    if (!parsed.success) {
        return json(res, 400, { error: "url must be a non-loopback http or https link" });
    }

    /*
        The sender names itself, so believe it only when the claimed id is a peer we already
        know at exactly this address. Anything else is labelled unknown and unverified.
    */
    const claimed = parsed.data.fromId ? deps.peers.get(parsed.data.fromId) : undefined;
    const verified = claimed !== undefined && claimed.addr === ip;

    const item = deps.inbox.add({
        fromId: verified ? claimed.id : "",
        fromName: verified ? claimed.name : `unknown (${clean(ip, 45)})`,
        url: parsed.data.url,
        title: parsed.data.title ?? "",
        verified,
    });

    console.log(`  in  ${item.fromName}: ${new URL(item.url).hostname}`);
    json(res, 200, { ok: true });
}
