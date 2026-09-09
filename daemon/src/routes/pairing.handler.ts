import type { IncomingMessage, ServerResponse } from "node:http";
import { API_HEADER, EXTENSION_ORIGIN } from "../constants.ts";
import { json, readBody } from "../http.ts";
import { isLoopbackIp, remoteIp } from "../net.ts";
import { createLimiter } from "../rate-limit.ts";
import { clean } from "../text.ts";
import type { ApiDeps } from "./api.handler.ts";

/* Guessing a six digit code should not be worth attempting. */
const claimLimit = createLimiter(5, 60_000);

export async function handlePairingClaim(
    req: IncomingMessage,
    res: ServerResponse,
    deps: ApiDeps,
): Promise<void> {
    const ip = remoteIp(req);
    if (!isLoopbackIp(ip)) return json(res, 403, { code: "loopback_only", error: "loopback only" });
    if (!req.headers[API_HEADER]) {
        return json(res, 403, { code: "missing_header", error: "missing x-ezyshare header" });
    }

    const origin = req.headers.origin;
    if (!origin || !EXTENSION_ORIGIN.test(origin)) {
        return json(res, 403, { code: "bad_origin", error: "bad origin" });
    }

    res.setHeader("access-control-allow-origin", origin);
    res.setHeader("vary", "origin");

    if (!claimLimit(ip)) return json(res, 429, { code: "slow_down", error: "too many attempts" });

    let body;
    try {
        body = await readBody(req);
    } catch {
        return json(res, 400, { error: "bad body" });
    }

    if (!deps.pairing.claim(body.data.code)) {
        return json(res, 403, { code: "bad_code", error: "wrong or expired code" });
    }

    deps.config.current.extensionOrigin = origin;
    deps.config.save();
    console.log(`paired with extension ${clean(origin, 128)}`);
    json(res, 200, { ok: true });
}
