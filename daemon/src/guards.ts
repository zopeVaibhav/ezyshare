import type { IncomingMessage, ServerResponse } from "node:http";
import { API_HEADER, EXTENSION_ORIGIN, PEER_HEADER } from "./constants.ts";
import { json } from "./http.ts";
import { isLoopbackIp, remoteIp } from "./net.ts";
import { clean } from "./text.ts";
import type { ConfigStore } from "./config.store.ts";
import type { Pairing } from "./pairing.ts";

/*
    Only another daemon may deliver a link. A page in the victim's browser cannot set a
    custom header without a preflight, and this route answers none, so the browser
    blocks the request before it is sent.
*/
export function guardPeer(req: IncomingMessage, res: ServerResponse): boolean {
    if (req.headers.origin) {
        json(res, 403, { error: "browser requests not accepted here" });
        return false;
    }
    if (req.headers[PEER_HEADER] !== "1") {
        json(res, 403, { error: "not an ezyshare peer" });
        return false;
    }
    if (!/^application\/json\b/i.test(req.headers["content-type"] ?? "")) {
        json(res, 415, { error: "expected application/json" });
        return false;
    }
    return true;
}

/*
    Three gates on /api: a loopback source, the one chrome-extension origin this daemon
    is paired with, and a header that forces a preflight a web page cannot satisfy.
*/
export function guardApi(
    req: IncomingMessage,
    res: ServerResponse,
    config: ConfigStore,
    pairing: Pairing,
): boolean {
    if (!isLoopbackIp(remoteIp(req))) {
        json(res, 403, { code: "loopback_only", error: "loopback only" });
        return false;
    }

    const origin = req.headers.origin;
    if (origin) {
        if (!EXTENSION_ORIGIN.test(origin)) {
            json(res, 403, { code: "bad_origin", error: "bad origin" });
            return false;
        }
        if (config.current.extensionOrigin && config.current.extensionOrigin !== origin) {
            /*
                Machine-readable, because the panel has to tell a pairing conflict apart
                from a daemon that is simply not there.
            */
            pairing.challenge();
            json(res, 403, {
                code: "paired_elsewhere",
                error: "another extension is already paired with this daemon",
            });
            return false;
        }
        res.setHeader("access-control-allow-origin", origin);
        res.setHeader("access-control-allow-headers", `content-type, ${API_HEADER}`);
        res.setHeader("access-control-allow-methods", "GET, POST, OPTIONS");
        res.setHeader("access-control-max-age", "600");
        res.setHeader("vary", "origin");
    }

    if (req.method === "OPTIONS") {
        res.writeHead(204);
        res.end();
        return false;
    }

    if (!req.headers[API_HEADER]) {
        json(res, 403, { code: "missing_header", error: "missing x-ezyshare header" });
        return false;
    }

    /*
        Pin only once the request has cleared every check. Doing it earlier let any local
        process burn the one-time pairing slot with a request that was then rejected.
    */
    if (origin && !config.current.extensionOrigin) {
        config.current.extensionOrigin = origin;
        config.save();
        console.log(`paired with extension ${clean(origin, 128)}`);
    }
    return true;
}
