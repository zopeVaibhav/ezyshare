import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { parseArgs } from "../../daemon/src/args.ts";
import { createDaemon } from "../../daemon/src/daemon.ts";
import type { Daemon } from "../../daemon/src/daemon.ts";

export const API_HEADERS = { "x-ezyshare": "1", "content-type": "application/json" };
export const PEER_HEADERS = { "x-ezyshare-peer": "1", "content-type": "application/json" };
export const EXTENSION_ORIGIN = "chrome-extension://abcdefghijklmnopabcdefghijklmnop";
export const OTHER_ORIGIN = "chrome-extension://ponmlkjihgfedcbaponmlkjihgfedcba";

let nextPort = 19000;

export function freePort(): number {
    nextPort += 1;
    return nextPort;
}

export type Harness = {
    daemon: Daemon;
    port: number;
    dir: string;
    url: (path: string) => string;
    api: (path: string, init?: RequestInit) => Promise<Response>;
    peer: (path: string, init?: RequestInit) => Promise<Response>;
    stop: () => Promise<void>;
};

export async function startDaemon(extra: string[] = []): Promise<Harness> {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ezyshare-test-"));
    return startDaemonIn(dir, extra);
}

export async function startDaemonIn(
    dir: string,
    extra: string[] = [],
    fixedPort?: number,
): Promise<Harness> {
    const port = fixedPort ?? freePort();
    const dport = freePort();

    const daemon = createDaemon(
        parseArgs([
            "--name",
            "TestBox",
            "--port",
            String(port),
            "--discovery-port",
            String(dport),
            "--dir",
            dir,
            ...extra,
        ]),
    );
    await daemon.listen();

    const url = (target: string) => `http://127.0.0.1:${port}${target}`;

    return {
        daemon,
        port,
        dir,
        url,
        api: (target, init = {}) =>
            fetch(url(target), { ...init, headers: { ...API_HEADERS, ...(init.headers ?? {}) } }),
        peer: (target, init = {}) =>
            fetch(url(target), { ...init, headers: { ...PEER_HEADERS, ...(init.headers ?? {}) } }),
        async stop() {
            await daemon.close();
        },
    };
}

export function tempDir(): string {
    return fs.mkdtempSync(path.join(os.tmpdir(), "ezyshare-test-"));
}

export function writeInbox(dir: string, contents: unknown): void {
    fs.writeFileSync(path.join(dir, "inbox.json"), JSON.stringify(contents));
}

/*
    Config is written with an async fs.writeFile, so a test that reads the file straight
    after the request that triggered it is racing the disk.
*/
export async function waitForConfig(
    dir: string,
    predicate: (config: Record<string, unknown>) => boolean,
    timeoutMs = 2000,
): Promise<Record<string, unknown>> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
        const config = readConfig(dir);
        if (predicate(config)) return config;
        if (Date.now() > deadline) return config;
        await Bun.sleep(20);
    }
}

export function readConfig(dir: string): Record<string, unknown> {
    try {
        return JSON.parse(fs.readFileSync(path.join(dir, "config.json"), "utf8")) as Record<
            string,
            unknown
        >;
    } catch {
        return {};
    }
}

/*
    On a real LAN both machines announce over UDP, so each knows the other and can verify
    the other's deliveries. Loopback announces are refused by the subnet check, so tests
    point the two daemons at each other with --peer instead.
*/
export async function startPair(extra: string[] = []): Promise<[Harness, Harness]> {
    const portA = freePort();
    const portB = freePort();

    const a = await startDaemonIn(tempDir(), [...extra, "--peer", `127.0.0.1:${portB}`], portA);
    const b = await startDaemonIn(tempDir(), [...extra, "--peer", `127.0.0.1:${portA}`], portB);

    for (let attempt = 0; attempt < 20; attempt++) {
        await Promise.all([a, b].map((box) => box.daemon.discovery.probeManualPeers()));
        const seen = await Promise.all(
            [a, b].map(async (box) => {
                const data = (await (await box.api("/api/peers")).json()) as { peers: unknown[] };
                return data.peers.length > 0;
            }),
        );
        if (seen.every(Boolean)) break;
        await Bun.sleep(50);
    }

    return [a, b];
}
