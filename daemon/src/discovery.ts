import crypto from "node:crypto";
import dgram from "node:dgram";
import dns from "node:dns";
import {
    ANNOUNCE_INTERVAL_MS,
    HTTP_PORT_DEFAULT,
    MANUAL_PROBE_INTERVAL_MS,
    MAX_ANNOUNCE_BYTES,
    MAX_PEERS,
    REAP_INTERVAL_MS,
} from "./constants.ts";
import { broadcastAddresses, onLocalSubnet } from "./net.ts";
import { createLimiter } from "./rate-limit.ts";
import { announcePayload, whoamiResponse } from "./schemas/inbox.payload.ts";
import { clean } from "./text.ts";
import type { ConfigStore } from "./config.store.ts";
import type { Identity } from "./ezyshare.type.ts";
import type { PeerStore } from "./peers.store.ts";
import type { Signer } from "./secret.ts";

export type Discovery = {
    announce: (target?: { address: string; port: number }) => void;
    probeManualPeers: () => Promise<void>;
    start: () => void;
    stop: () => void;
};

export type DiscoveryOptions = {
    self: Identity;
    dport: number;
    manualPeers: string[];
    peers: PeerStore;
    config: ConfigStore;
    signer: Signer | null;
};

export function createDiscovery(options: DiscoveryOptions): Discovery {
    const { self, dport, manualPeers, peers, config, signer } = options;
    const socket = dgram.createSocket({ type: "udp4", reuseAddr: true });
    const replyLimit = createLimiter(1, 10_000);
    const announceLimit = createLimiter(4, 60_000);
    const timers: NodeJS.Timeout[] = [];

    function announce(target?: { address: string; port: number }): void {
        if (!config.current.enabled) return;
        const body: Record<string, unknown> = {
            t: "hi",
            id: self.id,
            name: self.name,
            port: self.port,
        };
        if (signer) {
            body.ts = Date.now();
            body.mac = signer.announceMac(self.id, self.name, self.port, body.ts as number);
        }
        const message = Buffer.from(JSON.stringify(body));
        const targets = target
            ? [target]
            : broadcastAddresses().map((address) => ({ address, port: dport }));

        for (const to of targets) {
            socket.send(message, to.port, to.address, (err) => {
                if (err && process.env.EZYSHARE_DEBUG) {
                    console.error("announce failed", to.address, err.message);
                }
            });
        }
    }

    socket.on("message", (buf, rinfo) => {
        if (!config.current.enabled || buf.length > MAX_ANNOUNCE_BYTES) return;

        let parsed: unknown;
        try {
            parsed = JSON.parse(buf.toString());
        } catch {
            return;
        }

        const result = announcePayload.safeParse(parsed);
        if (!result.success) return;
        const msg = result.data;
        if (msg.id === self.id) return;
        if (!onLocalSubnet(rinfo.address)) return;

        const name = clean(msg.name ?? "unknown");

        if (signer) {
            if (msg.ts === undefined || !signer.withinSkew(msg.ts)) return;
            if (!signer.matches(signer.announceMac(msg.id, name, msg.port, msg.ts), msg.mac))
                return;
            if (!signer.nonceIsNew(`hi:${msg.id}:${msg.ts}:${msg.mac ?? ""}`)) return;
        }

        const held = peers.heldByAnother(msg.id, rinfo.address, msg.port);
        if (held) {
            if (!held.warned) {
                held.warned = true;
                console.warn(
                    `! ignoring second claim on id ${msg.id} from ${rinfo.address}:${msg.port} (held by ${held.addr}:${held.port})`,
                );
            }
            return;
        }

        const existing = peers.get(msg.id);
        if (!existing) {
            /*
                Rejecting at the cap turned unbounded growth into a lockout: 256 packets of random
                ids from one address hid every real peer. Rate limit new ids per source, and evict
                the stalest entry when the map is full instead of refusing the newcomer.
            */
            if (!announceLimit(rinfo.address)) return;
            if (!peers.evictStalest()) return;
        }

        peers.set({
            id: msg.id,
            name,
            addr: rinfo.address,
            port: msg.port,
            lastSeen: Date.now(),
            manual: false,
        });

        if (!existing) {
            console.log(`+ ${name} (${rinfo.address})`);
            if (replyLimit(rinfo.address)) announce({ address: rinfo.address, port: dport });
        }
    });

    socket.on("error", (err: NodeJS.ErrnoException) => {
        console.error(`discovery socket error: ${err.message}`);
        if (err.code === "EADDRINUSE") {
            console.error("another ezyshare daemon is already running on this machine.");
            process.exit(1);
        }
    });

    async function probeManualPeers(): Promise<void> {
        if (!config.current.enabled) return;

        for (const spec of manualPeers) {
            const at = spec.lastIndexOf(":");
            const host = at > 0 ? spec.slice(0, at) : spec;
            const port = at > 0 ? Number(spec.slice(at + 1)) : HTTP_PORT_DEFAULT;
            if (!Number.isInteger(port) || port < 1 || port > 65535) continue;

            try {
                const nonce = crypto.randomBytes(16).toString("hex");
                const res = await fetch(`http://${host}:${port}/whoami?nonce=${nonce}`, {
                    signal: AbortSignal.timeout(2000),
                });
                const parsed = whoamiResponse.safeParse(await res.json());
                if (!parsed.success) continue;

                const who = parsed.data;
                if (who.id === self.id) continue;

                const name = clean(who.name);
                if (signer) {
                    const expected = signer.whoamiMac(who.id, name, who.port ?? port, nonce);
                    if (!signer.matches(expected, who.mac)) continue;
                }

                const existing = peers.get(who.id);
                if (existing && !existing.manual) continue;
                if (!existing && peers.size() >= MAX_PEERS) continue;

                /*
                    Store the resolved address, not the operator's string: sender verification
                    compares against the socket's IP, which a hostname could never match.
                */
                const { address } = await dns.promises.lookup(host, { family: 4 });
                peers.set({
                    id: who.id,
                    name,
                    addr: address,
                    port,
                    lastSeen: Date.now(),
                    manual: true,
                });
            } catch {
                /* peer offline */
            }
        }
    }

    return {
        announce,
        probeManualPeers,

        start() {
            socket.bind(dport, () => {
                socket.setBroadcast(true);
                announce();
                timers.push(setInterval(announce, ANNOUNCE_INTERVAL_MS));
            });

            timers.push(
                setInterval(() => {
                    peers.reap((peer) => console.log(`- ${peer.name}`));
                }, REAP_INTERVAL_MS),
            );

            if (manualPeers.length) {
                void probeManualPeers();
                timers.push(setInterval(() => void probeManualPeers(), MANUAL_PROBE_INTERVAL_MS));
            }
        },

        stop() {
            for (const timer of timers) clearInterval(timer);
            timers.length = 0;
            socket.close();
        },
    };
}
