import { describe, expect, test } from "bun:test";
import { LIMITER_KEYS } from "../daemon/src/constants.ts";
import { createLimiter } from "../daemon/src/rate-limit.ts";

describe("createLimiter", () => {
    test("allows exactly the limit inside a window", () => {
        const limit = createLimiter(3, 60_000);
        expect([1, 2, 3, 4].map(() => limit("a"))).toEqual([true, true, true, false]);
    });

    test("keys are independent", () => {
        const limit = createLimiter(1, 60_000);
        expect(limit("a")).toBe(true);
        expect(limit("a")).toBe(false);
        expect(limit("b")).toBe(true);
    });

    test("a new window resets the count", async () => {
        const limit = createLimiter(1, 20);
        expect(limit("a")).toBe(true);
        expect(limit("a")).toBe(false);
        await Bun.sleep(30);
        expect(limit("a")).toBe(true);
    });

    /*
        The table used to be cleared wholesale when it filled, which let a flood of fresh
        keys reset the counter of an address that was already over its limit.
    */
    test("a flood of fresh keys cannot clear a victim's bucket", () => {
        const limit = createLimiter(2, 60_000);
        limit("victim");
        limit("victim");
        expect(limit("victim")).toBe(false);

        for (let i = 0; i < LIMITER_KEYS + 500; i++) limit(`flood-${i}`);

        expect(limit("victim")).toBe(false);
    });

    test("the flooder is the one denied once the table is full", () => {
        const limit = createLimiter(10, 60_000);
        let denied = 0;
        for (let i = 0; i < LIMITER_KEYS + 200; i++) if (!limit(`flood-${i}`)) denied += 1;
        expect(denied).toBeGreaterThan(0);
    });
});
