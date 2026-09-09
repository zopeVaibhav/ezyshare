import { afterEach, describe, expect, test } from "bun:test";
import { startDaemon, startDaemonIn, startPair, tempDir } from "./helpers/daemon.harness.ts";
import type { Harness } from "./helpers/daemon.harness.ts";

const running: Harness[] = [];

async function pair(extra: string[] = []): Promise<[Harness, Harness]> {
    const boxes = await startPair(extra);
    running.push(...boxes);
    return boxes;
}

afterEach(async () => {
    await Promise.all(running.splice(0).map((harness) => harness.stop()));
});

describe("end to end", () => {
    test("a link sent from one daemon arrives at the other", async () => {
        const [receiver, sender] = await pair();

        const peers = (await (await sender.api("/api/peers")).json()) as {
            peers: Array<{ id: string }>;
        };
        expect(peers.peers.length).toBeGreaterThan(0);
        const peerId = peers.peers[0]?.id ?? "";

        const send = await sender.api("/api/send", {
            method: "POST",
            body: JSON.stringify({ peerId, url: "https://example.com/shared", title: "a link" }),
        });
        expect(send.status).toBe(200);

        const inbox = (await (await receiver.api("/api/inbox?since=0&wait=0")).json()) as {
            items: Array<{ url: string; verified: boolean; title: string }>;
        };
        expect(inbox.items).toHaveLength(1);
        expect(inbox.items[0]?.url).toBe("https://example.com/shared");
        expect(inbox.items[0]?.title).toBe("a link");
        /* Resolved to an IP by the probe, so the source address matches and it verifies. */
        expect(inbox.items[0]?.verified).toBe(true);
    });

    test("sending to an unknown peer is a 404", async () => {
        const [, sender] = await pair();
        const res = await sender.api("/api/send", {
            method: "POST",
            body: JSON.stringify({ peerId: "ffffffffffffffff", url: "https://example.com" }),
        });
        expect(res.status).toBe(404);
    });

    test("a loopback link is refused before it is ever sent", async () => {
        const [, sender] = await pair();
        const peers = (await (await sender.api("/api/peers")).json()) as {
            peers: Array<{ id: string }>;
        };
        const res = await sender.api("/api/send", {
            method: "POST",
            body: JSON.stringify({
                peerId: peers.peers[0]?.id,
                url: "http://127.0.0.1:5000/admin",
            }),
        });
        expect(res.status).toBe(400);
    });

    test("with a shared secret set, an unsigned delivery is refused", async () => {
        const locked = await startDaemon(["--secret", "hunter2"]);
        running.push(locked);

        const res = await locked.peer("/inbox", {
            method: "POST",
            body: JSON.stringify({ url: "https://example.com/x" }),
        });
        expect(res.status).toBe(401);
    });

    test("two daemons sharing a secret still deliver", async () => {
        const [receiver, sender] = await pair(["--secret", "hunter2"]);
        const peers = (await (await sender.api("/api/peers")).json()) as {
            peers: Array<{ id: string }>;
        };
        expect(peers.peers.length).toBeGreaterThan(0);

        const send = await sender.api("/api/send", {
            method: "POST",
            body: JSON.stringify({ peerId: peers.peers[0]?.id, url: "https://example.com/signed" }),
        });
        expect(send.status).toBe(200);

        const inbox = (await (await receiver.api("/api/inbox?since=0&wait=0")).json()) as {
            items: Array<{ url: string }>;
        };
        expect(inbox.items[0]?.url).toBe("https://example.com/signed");
    });
});

describe("long poll", () => {
    test("returns immediately when wait is zero", async () => {
        const box = await startDaemon();
        running.push(box);

        const started = Date.now();
        const res = await box.api("/api/inbox?since=0&wait=0");
        expect(res.status).toBe(200);
        expect(Date.now() - started).toBeLessThan(500);
    });

    test("wakes as soon as an item lands", async () => {
        const box = await startDaemon();
        running.push(box);

        const waiting = box.api("/api/inbox?since=0&wait=5000");
        await Bun.sleep(50);
        await box.peer("/inbox", {
            method: "POST",
            body: JSON.stringify({ url: "https://example.com/live" }),
        });

        const data = (await (await waiting).json()) as { items: unknown[] };
        expect(data.items).toHaveLength(1);
    });
});

describe("inbox state survives a restart", () => {
    test("items and the verified flag are still there", async () => {
        const dir = tempDir();
        const first = await startDaemonIn(dir);
        await first.peer("/inbox", {
            method: "POST",
            body: JSON.stringify({ url: "https://example.com/persisted" }),
        });
        await Bun.sleep(300);
        await first.stop();

        const second = await startDaemonIn(dir);
        running.push(second);
        const data = (await (await second.api("/api/inbox?since=0&wait=0")).json()) as {
            items: Array<{ url: string; verified: boolean }>;
        };
        expect(data.items).toHaveLength(1);
        expect(data.items[0]?.url).toBe("https://example.com/persisted");
        expect(data.items[0]?.verified).toBe(false);
    });
});
