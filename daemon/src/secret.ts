import crypto from "node:crypto";
import { CLOCK_SKEW_MS } from "./constants.ts";

export type Signer = {
    announceMac: (id: string, name: string, port: number, ts: number) => string;
    whoamiMac: (id: string, name: string, port: number, nonce: string) => string;
    inboxMac: (rawBody: string) => string;
    matches: (expected: string, got: unknown) => boolean;
    withinSkew: (ts: number) => boolean;
    nonceIsNew: (nonce: string) => boolean;
    stop: () => void;
};

export function createSigner(secret: string): Signer {
    const hmac = (canonical: string) =>
        crypto.createHmac("sha256", secret).update(canonical).digest("hex");

    /*
        A signed message is good exactly once, so one captured off the wire cannot be
        replayed inside the skew window, which a MAC on its own would still allow.
    */
    const usedNonces = new Map<string, number>();
    const sweep = setInterval(() => {
        const now = Date.now();
        for (const [nonce, expires] of usedNonces) if (expires < now) usedNonces.delete(nonce);
    }, CLOCK_SKEW_MS);
    sweep.unref();

    return {
        announceMac: (id, name, port, ts) => hmac(`hi|${id}|${name}|${port}|${ts}`),
        whoamiMac: (id, name, port, nonce) => hmac(`whoami|${id}|${name}|${port}|${nonce}`),
        inboxMac: (rawBody) => hmac(`inbox|${rawBody}`),

        matches(expected, got) {
            if (typeof got !== "string" || got.length !== expected.length) return false;
            return crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(got));
        },

        withinSkew(ts) {
            return Number.isFinite(ts) && Math.abs(Date.now() - ts) <= CLOCK_SKEW_MS;
        },

        nonceIsNew(nonce) {
            if (typeof nonce !== "string" || nonce.length < 8 || nonce.length > 160) return false;
            if (usedNonces.has(nonce)) return false;
            usedNonces.set(nonce, Date.now() + CLOCK_SKEW_MS * 2);
            return true;
        },

        stop() {
            clearInterval(sweep);
        },
    };
}
