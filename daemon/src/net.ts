import os from "node:os";
import type { IncomingMessage } from "node:http";
import { MAX_URL } from "./constants.ts";

type Interface = { address: string; netmask: string };

export function ipv4Interfaces(): Interface[] {
    const out: Interface[] = [];
    for (const list of Object.values(os.networkInterfaces())) {
        for (const ni of list ?? []) {
            if (ni.family !== "IPv4" || ni.internal || !ni.netmask) continue;
            out.push({ address: ni.address, netmask: ni.netmask });
        }
    }
    return out;
}

export function toInt(ip: string): number | null {
    const parts = ip.split(".").map(Number);
    if (parts.length !== 4) return null;
    if (parts.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return null;
    return (
        (((parts[0] as number) << 24) |
            ((parts[1] as number) << 16) |
            ((parts[2] as number) << 8) |
            (parts[3] as number)) >>>
        0
    );
}

let subnetCache: { at: number; list: Interface[] } = { at: 0, list: [] };

function localSubnets(): Interface[] {
    if (Date.now() - subnetCache.at > 30_000) {
        subnetCache = { at: Date.now(), list: ipv4Interfaces() };
    }
    return subnetCache.list;
}

/*
    Announces are trusted only from our own IPv4 subnets. This is what stops a spoofed
    loopback or metadata-endpoint peer turning /api/send into a port scanner.
*/
export function onLocalSubnet(ip: string): boolean {
    const value = toInt(ip);
    if (value === null) return false;
    for (const ni of localSubnets()) {
        const net = toInt(ni.address);
        const mask = toInt(ni.netmask);
        if (net === null || mask === null) continue;
        if ((value & mask) >>> 0 === (net & mask) >>> 0) return true;
    }
    return false;
}

export function broadcastAddresses(): string[] {
    const out = new Set<string>(["255.255.255.255"]);
    for (const ni of ipv4Interfaces()) {
        const ip = ni.address.split(".").map(Number);
        const mask = ni.netmask.split(".").map(Number);
        out.add(ip.map((o, i) => o | (~(mask[i] as number) & 255)).join("."));
    }
    return [...out];
}

/*
    The URL parser already collapses 127.1, 2130706433 and 0x7f000001 to 127.0.0.1.
    These are the spellings it does not collapse, and each still reaches the
    recipient's own machine.
*/
export function isLoopbackHost(host: string): boolean {
    const bare = host
        .replace(/^\[|\]$/g, "")
        .toLowerCase()
        .replace(/\.$/, "");
    if (bare === "localhost" || bare.endsWith(".localhost")) return true;
    if (bare === "::1" || bare === "::" || bare === "0.0.0.0" || bare === "0") return true;
    if (/^::ffff:(7f[0-9a-f]{2}:|0:0)/.test(bare)) return true;
    if (/^169\.254\./.test(bare)) return true;
    return /^127\./.test(bare);
}

export function safeUrl(raw: unknown): string | null {
    try {
        const url = new URL(String(raw));
        if (url.protocol !== "http:" && url.protocol !== "https:") return null;
        if (isLoopbackHost(url.hostname)) return null;
        if (url.href.length > MAX_URL) return null;
        return url.href;
    } catch {
        return null;
    }
}

export function remoteIp(req: IncomingMessage): string {
    return (req.socket.remoteAddress ?? "").replace(/^::ffff:/, "");
}

export function isLoopbackIp(ip: string): boolean {
    return ip === "127.0.0.1" || ip === "::1";
}
