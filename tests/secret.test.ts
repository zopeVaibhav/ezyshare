import { describe, expect, test } from "bun:test";
import { createSigner } from "../daemon/src/secret.ts";

describe("createSigner", () => {
    test("a different secret produces a different mac", () => {
        const mine = createSigner("hunter2");
        const theirs = createSigner("hunter3");

        const canonical = ["aaaabbbbccccdddd", "Alice", 8787, 1_700_000_000_000] as const;
        expect(mine.announceMac(...canonical)).not.toBe(theirs.announceMac(...canonical));

        mine.stop();
        theirs.stop();
    });

    test("matches rejects a missing, short or wrong mac without throwing", () => {
        const signer = createSigner("hunter2");
        const expected = signer.inboxMac("{}");

        expect(signer.matches(expected, expected)).toBe(true);
        expect(signer.matches(expected, undefined)).toBe(false);
        expect(signer.matches(expected, "")).toBe(false);
        expect(signer.matches(expected, "abc")).toBe(false);
        expect(signer.matches(expected, expected.replace(/.$/, "0"))).toBe(false);
        signer.stop();
    });

    test("the mac covers the exact bytes, so a re-serialised body fails", () => {
        const signer = createSigner("hunter2");
        const raw = '{"url":"https://a.com","ts":1}';
        expect(
            signer.matches(signer.inboxMac(raw), signer.inboxMac(JSON.stringify(JSON.parse(raw)))),
        ).toBe(true);
        expect(signer.matches(signer.inboxMac(raw), signer.inboxMac(`${raw} `))).toBe(false);
        signer.stop();
    });

    test("timestamps outside the skew window are refused", () => {
        const signer = createSigner("hunter2");
        expect(signer.withinSkew(Date.now())).toBe(true);
        expect(signer.withinSkew(Date.now() - 120_000)).toBe(false);
        expect(signer.withinSkew(Date.now() + 120_000)).toBe(false);
        expect(signer.withinSkew(Number.NaN)).toBe(false);
        signer.stop();
    });

    /* A message captured off the wire must not be usable a second time. */
    test("a nonce is good exactly once", () => {
        const signer = createSigner("hunter2");
        expect(signer.nonceIsNew("abcdef123456")).toBe(true);
        expect(signer.nonceIsNew("abcdef123456")).toBe(false);
        signer.stop();
    });

    test("nonces outside the length bounds are refused", () => {
        const signer = createSigner("hunter2");
        expect(signer.nonceIsNew("short")).toBe(false);
        expect(signer.nonceIsNew("a".repeat(200))).toBe(false);
        signer.stop();
    });
});
