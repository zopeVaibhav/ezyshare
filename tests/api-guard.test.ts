import { afterEach, describe, expect, test } from "bun:test";
import {
    API_HEADERS,
    EXTENSION_ORIGIN,
    OTHER_ORIGIN,
    readConfig,
    startDaemon,
    waitForConfig,
} from "./helpers/daemon.harness.ts";
import type { Harness } from "./helpers/daemon.harness.ts";

const running: Harness[] = [];

async function box(extra: string[] = []): Promise<Harness> {
    const harness = await startDaemon(extra);
    running.push(harness);
    return harness;
}

afterEach(async () => {
    await Promise.all(running.splice(0).map((harness) => harness.stop()));
});

describe("/api gates", () => {
    test("rejects a request with no x-ezyshare header", async () => {
        const harness = await box();
        const res = await fetch(harness.url("/api/peers"));
        expect(res.status).toBe(403);
    });

    test("rejects a web origin", async () => {
        const harness = await box();
        const res = await harness.api("/api/peers", {
            headers: { Origin: "https://evil.example" },
        });
        expect(res.status).toBe(403);
    });

    test("rejects a malformed extension id", async () => {
        const harness = await box();
        const res = await harness.api("/api/peers", {
            headers: { Origin: "chrome-extension://short" },
        });
        expect(res.status).toBe(403);
    });

    /*
        Pinning used to happen before the header check, so one rejected request from any
        local process locked the real extension out until --reset-pairing.
    */
    test("a rejected request does not burn the pairing slot", async () => {
        const harness = await box();

        const rejected = await fetch(harness.url("/api/peers"), {
            headers: { Origin: EXTENSION_ORIGIN },
        });
        expect(rejected.status).toBe(403);
        expect(readConfig(harness.dir).extensionOrigin).toBeUndefined();

        /* Still unpaired, so a different extension is free to claim the slot. */
        const other = await harness.api("/api/peers", { headers: { Origin: OTHER_ORIGIN } });
        expect(other.status).toBe(200);

        const config = await waitForConfig(
            harness.dir,
            (saved) => saved.extensionOrigin !== undefined,
        );
        expect(config.extensionOrigin).toBe(OTHER_ORIGIN);
    });

    test("a second extension is refused once one is paired", async () => {
        const harness = await box();
        await harness.api("/api/peers", { headers: { Origin: EXTENSION_ORIGIN } });

        const res = await harness.api("/api/peers", { headers: { Origin: OTHER_ORIGIN } });
        expect(res.status).toBe(403);
        expect(((await res.json()) as { error: string }).error).toContain("already paired");
    });

    test("answers a preflight for the paired extension", async () => {
        const harness = await box();
        const res = await fetch(harness.url("/api/peers"), {
            method: "OPTIONS",
            headers: { Origin: EXTENSION_ORIGIN, ...API_HEADERS },
        });
        expect(res.status).toBe(204);
        expect(res.headers.get("access-control-allow-origin")).toBe(EXTENSION_ORIGIN);
    });

    test("routes outside /api and the LAN surface are not found", async () => {
        const harness = await box();
        for (const path of ["/", "/Api/me", "/API/peers", "/admin"]) {
            const res = await harness.api(path);
            expect(res.status).toBe(404);
        }
    });
});

describe("sharing toggle", () => {
    test("off makes the daemon invisible and refuse deliveries", async () => {
        const harness = await box();
        await harness.api("/api/state", {
            method: "POST",
            body: JSON.stringify({ enabled: false }),
        });

        expect((await fetch(harness.url("/whoami"))).status).toBe(503);
        expect(
            (
                await harness.peer("/inbox", {
                    method: "POST",
                    body: JSON.stringify({ url: "https://a.com" }),
                })
            ).status,
        ).toBe(503);
        expect(
            (
                await harness.api("/api/send", {
                    method: "POST",
                    body: JSON.stringify({ peerId: "x", url: "https://a.com" }),
                })
            ).status,
        ).toBe(409);

        const peers = (await (await harness.api("/api/peers")).json()) as {
            enabled: boolean;
            peers: unknown[];
        };
        expect(peers.enabled).toBe(false);
        expect(peers.peers).toHaveLength(0);
    });

    test("comes back on", async () => {
        const harness = await box();
        await harness.api("/api/state", {
            method: "POST",
            body: JSON.stringify({ enabled: false }),
        });
        await harness.api("/api/state", {
            method: "POST",
            body: JSON.stringify({ enabled: true }),
        });

        const state = (await (await harness.api("/api/state")).json()) as { enabled: boolean };
        expect(state.enabled).toBe(true);
        expect((await fetch(harness.url("/whoami"))).status).toBe(200);
    });

    test("a malformed state body does not crash the daemon", async () => {
        const harness = await box();
        for (const payload of ["null", "[]", '"x"']) {
            const res = await harness.api("/api/state", { method: "POST", body: payload });
            expect(res.status).toBe(200);
        }
        expect((await harness.api("/api/me")).status).toBe(200);
    });
});
