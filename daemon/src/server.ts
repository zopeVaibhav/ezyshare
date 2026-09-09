import http from "node:http";
import type { Server } from "node:http";
import { createLimiter } from "./rate-limit.ts";
import { guardApi } from "./guards.ts";
import { json } from "./http.ts";
import { handleInbox } from "./routes/inbox.handler.ts";
import { handlePairingClaim } from "./routes/pairing.handler.ts";
import { handleWhoami } from "./routes/whoami.handler.ts";
import {
    handleClear,
    handleInboxRead,
    handleMarkRead,
    handleMe,
    handlePeers,
    handleSend,
    handleState,
} from "./routes/api.handler.ts";
import type { ApiDeps } from "./routes/api.handler.ts";

export function createServer(deps: ApiDeps): Server {
    const inboxLimit = createLimiter(12, 60_000);

    const server = http.createServer((req, res) => {
        void route(req, res).catch(() => {
            if (!res.headersSent) json(res, 500, { error: "internal error" });
        });
    });

    async function route(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
        const url = new URL(req.url ?? "/", "http://localhost");
        const path = url.pathname;
        const enabled = deps.config.current.enabled;

        if (path === "/whoami" && req.method === "GET") {
            if (!enabled) return json(res, 503, { error: "sharing is off" });
            return handleWhoami(req, res, url, deps.self, deps.signer);
        }

        if (path === "/inbox" && req.method === "POST") {
            if (!enabled) return json(res, 503, { error: "sharing is off" });
            return handleInbox(req, res, {
                peers: deps.peers,
                inbox: deps.inbox,
                signer: deps.signer,
                limit: inboxLimit,
            });
        }

        if (!path.startsWith("/api/")) return json(res, 404, { error: "not found" });
        /*
            The claim route is the one /api path a locked-out extension may reach, and it
            still has to prove it knows a code only the daemon printed.
        */
        if (path === "/api/pairing/claim" && req.method === "POST") {
            return handlePairingClaim(req, res, deps);
        }
        if (!guardApi(req, res, deps.config, deps.pairing)) return;

        if (path === "/api/me") return handleMe(res, deps);
        if (path === "/api/peers") return handlePeers(res, deps);
        if (path === "/api/state") return handleState(req, res, deps);
        if (path === "/api/inbox") return handleInboxRead(req, res, url, deps);
        if (path === "/api/send" && req.method === "POST") return handleSend(req, res, deps);
        if (path === "/api/inbox/read" && req.method === "POST")
            return handleMarkRead(req, res, deps);
        if (path === "/api/inbox/clear" && req.method === "POST") return handleClear(res, deps);

        return json(res, 404, { error: "not found" });
    }

    server.on("clientError", (_err, socket) => {
        if (socket.writable) socket.end("HTTP/1.1 400 Bad Request\r\n\r\n");
    });

    return server;
}
