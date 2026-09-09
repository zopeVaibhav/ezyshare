import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { startDaemon } from "./helpers/daemon.harness.ts";
import type { Harness } from "./helpers/daemon.harness.ts";

let box: Harness;

beforeAll(async () => {
    box = await startDaemon();
});

afterAll(async () => {
    await box.stop();
});

const body = JSON.stringify({ url: "https://example.com/x" });

describe("/inbox rejects anything that is not a peer daemon", () => {
    /*
        A body that parses to something other than an object used to reach the handler,
        throw inside an async listener, and kill the process.
    */
    test("survives a JSON body that is not an object", async () => {
        for (const payload of ["null", "[]", '"str"', "42", "true"]) {
            const res = await box.peer("/inbox", { method: "POST", body: payload });
            expect(res.status).toBe(400);
        }
        const alive = await box.api("/api/me");
        expect(alive.status).toBe(200);
    });

    test("rejects a request carrying an Origin, which is how a web page would arrive", async () => {
        const res = await box.peer("/inbox", {
            method: "POST",
            body,
            headers: { Origin: "https://evil.example" },
        });
        expect(res.status).toBe(403);
    });

    test("rejects a missing peer header", async () => {
        const res = await fetch(box.url("/inbox"), {
            method: "POST",
            body,
            headers: { "content-type": "application/json" },
        });
        expect(res.status).toBe(403);
    });

    test("rejects a non-JSON content type", async () => {
        const res = await fetch(box.url("/inbox"), {
            method: "POST",
            body,
            headers: { "x-ezyshare-peer": "1", "content-type": "text/plain" },
        });
        expect(res.status).toBe(415);
    });

    test("accepts application/json with a charset", async () => {
        const res = await fetch(box.url("/inbox"), {
            method: "POST",
            body,
            headers: { "x-ezyshare-peer": "1", "content-type": "application/json;charset=utf-8" },
        });
        expect(res.status).toBe(200);
    });

    test("rejects a loopback link", async () => {
        const res = await box.peer("/inbox", {
            method: "POST",
            body: JSON.stringify({ url: "http://0.0.0.0:9200/x" }),
        });
        expect(res.status).toBe(400);
    });

    test("rate limits one source address", async () => {
        const fresh = await startDaemon();
        const codes: number[] = [];
        for (let i = 0; i < 15; i++) {
            const res = await fresh.peer("/inbox", {
                method: "POST",
                body: JSON.stringify({ url: `https://example.com/${i}` }),
            });
            codes.push(res.status);
        }
        expect(codes.filter((code) => code === 200)).toHaveLength(12);
        expect(codes.filter((code) => code === 429)).toHaveLength(3);
        await fresh.stop();
    });
});

describe("sender identity", () => {
    test("labels an unknown sender as unverified rather than trusting the claim", async () => {
        const fresh = await startDaemon();
        await fresh.peer("/inbox", {
            method: "POST",
            body: JSON.stringify({
                fromId: "deadbeefdeadbeef",
                url: "https://phish.example/login",
                title: "Q3 doc",
            }),
        });

        const res = await fresh.api("/api/inbox?since=0&wait=0");
        const data = (await res.json()) as {
            items: Array<{ verified: boolean; fromName: string }>;
        };

        expect(data.items).toHaveLength(1);
        expect(data.items[0]?.verified).toBe(false);
        expect(data.items[0]?.fromName).toStartWith("unknown (");
        await fresh.stop();
    });
});
