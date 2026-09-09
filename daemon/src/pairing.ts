import crypto from "node:crypto";

const CODE_TTL_MS = 5 * 60_000;

export type Pairing = {
    challenge: () => string;
    claim: (code: unknown) => boolean;
    clear: () => void;
};

/*
    Re-pairing has to be authorised by someone who can see the daemon's own output, or a
    hostile extension could simply take the pin whenever it liked. The code is printed
    where only the person at the machine can read it.
*/
export function createPairing(announce: (code: string) => void): Pairing {
    let code: string | null = null;
    let expires = 0;

    return {
        challenge() {
            if (!code || Date.now() > expires) {
                code = String(crypto.randomInt(100_000, 1_000_000));
                announce(code);
            }
            expires = Date.now() + CODE_TTL_MS;
            return code;
        },

        claim(candidate) {
            if (typeof candidate !== "string" || !code || Date.now() > expires) return false;
            const expected = Buffer.from(code);
            const got = Buffer.from(candidate);
            if (expected.length !== got.length) return false;
            if (!crypto.timingSafeEqual(expected, got)) return false;
            code = null;
            expires = 0;
            return true;
        },

        clear() {
            code = null;
            expires = 0;
        },
    };
}
