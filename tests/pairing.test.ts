import { afterEach, describe, expect, test } from "bun:test";
import { createPairing } from "../daemon/src/pairing.ts";
import { EXTENSION_ORIGIN, OTHER_ORIGIN, startDaemon } from "./helpers/daemon.harness.ts";
import type { Harness } from "./helpers/daemon.harness.ts";

const running: Harness[] = [];

afterEach(async () => {
    await Promise.all(running.splice(0).map((harness) => harness.stop()));
});

describe("createPairing", () => {
    test("announces a six digit code once and reuses it until claimed", () => {
        const announced: string[] = [];
        const pairing = createPairing((code) => announced.push(code));

        const first = pairing.challenge();
        const second = pairing.challenge();

        expect(first).toMatch(/^[0-9]{6}$/);
        expect(second).toBe(first);
        expect(announced).toHaveLength(1);
    });

    test("rejects a wrong code, a non-string, and a code before any challenge", () => {
        const pairing = createPairing(() => undefined);
        expect(pairing.claim("123456")).toBe(false);

        const code = pairing.challenge();
        expect(pairing.claim(undefined)).toBe(false);
        expect(pairing.claim(123456)).toBe(false);
        expect(pairing.claim("000000")).toBe(false);
        expect(pairing.claim(code)).toBe(true);
    });

    test("a code works exactly once", () => {
        const pairing = createPairing(() => undefined);
        const code = pairing.challenge();
        expect(pairing.claim(code)).toBe(true);
        expect(pairing.claim(code)).toBe(false);
    });

    test("clear invalidates an outstanding code", () => {
        const pairing = createPairing(() => undefined);
        const code = pairing.challenge();
        pairing.clear();
        expect(pairing.claim(code)).toBe(false);
    });
});

describe("re-pairing over HTTP", () => {
    async function lockedOut(): Promise<{ box: Harness; code: string }> {
        const box = await startDaemon();
        running.push(box);

        await box.api("/api/me", { headers: { Origin: EXTENSION_ORIGIN } });
        await box.api("/api/me", { headers: { Origin: OTHER_ORIGIN } });

        return { box, code: box.daemon.pairingCode() };
    }

    /*
        The panel has to tell this apart from an unreachable daemon, so the refusal carries
        a machine-readable code rather than only prose.
    */
    test("a second extension is refused with a machine-readable code", async () => {
        const box = await startDaemon();
        running.push(box);
        await box.api("/api/me", { headers: { Origin: EXTENSION_ORIGIN } });

        const res = await box.api("/api/me", { headers: { Origin: OTHER_ORIGIN } });
        expect(res.status).toBe(403);
        expect(((await res.json()) as { code: string }).code).toBe("paired_elsewhere");
    });

    test("the right code hands the pairing over", async () => {
        const { box, code } = await lockedOut();

        const claim = await box.api("/api/pairing/claim", {
            method: "POST",
            headers: { Origin: OTHER_ORIGIN },
            body: JSON.stringify({ code }),
        });
        expect(claim.status).toBe(200);

        expect((await box.api("/api/me", { headers: { Origin: OTHER_ORIGIN } })).status).toBe(200);
        expect((await box.api("/api/me", { headers: { Origin: EXTENSION_ORIGIN } })).status).toBe(
            403,
        );
    });

    test("a wrong code changes nothing", async () => {
        const { box } = await lockedOut();

        const claim = await box.api("/api/pairing/claim", {
            method: "POST",
            headers: { Origin: OTHER_ORIGIN },
            body: JSON.stringify({ code: "000000" }),
        });
        expect(claim.status).toBe(403);
        expect(((await claim.json()) as { code: string }).code).toBe("bad_code");
        expect((await box.api("/api/me", { headers: { Origin: EXTENSION_ORIGIN } })).status).toBe(
            200,
        );
    });

    test("the claim route still refuses a non-extension origin", async () => {
        const { box, code } = await lockedOut();
        const claim = await box.api("/api/pairing/claim", {
            method: "POST",
            headers: { Origin: "https://evil.example" },
            body: JSON.stringify({ code }),
        });
        expect(claim.status).toBe(403);
        expect(((await claim.json()) as { code: string }).code).toBe("bad_origin");
    });

    test("guessing is rate limited", async () => {
        const { box } = await lockedOut();
        const codes: number[] = [];

        for (let attempt = 0; attempt < 8; attempt++) {
            const res = await box.api("/api/pairing/claim", {
                method: "POST",
                headers: { Origin: OTHER_ORIGIN },
                body: JSON.stringify({ code: "000000" }),
            });
            codes.push(res.status);
        }

        expect(codes).toContain(429);
    });
});
