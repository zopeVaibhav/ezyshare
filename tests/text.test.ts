import { describe, expect, test } from "bun:test";
import { clean } from "../daemon/src/text.ts";

const ESC = String.fromCharCode(27);
const RTL_OVERRIDE = String.fromCharCode(0x202e);
const ZERO_WIDTH_JOINER = String.fromCharCode(0x200d);

describe("clean", () => {
    /*
        These are what smuggle ANSI escapes into the operator's terminal and bidi overrides
        into the panel, so a peer name from the network is stripped of them.
    */
    test("removes control and format characters", () => {
        expect(clean(`${ESC}[31mred`)).toBe("[31mred");
        expect(clean(`safe${RTL_OVERRIDE}gnp.exe`)).toBe("safegnp.exe");
        expect(clean(`a${ZERO_WIDTH_JOINER}b`)).toBe("ab");
        expect(clean("line\nbreak")).toBe("linebreak");
    });

    test("keeps ordinary Unicode, including a curly apostrophe", () => {
        expect(clean("Vaibhav’s MacBook Air")).toBe("Vaibhav’s MacBook Air");
    });

    test("clamps to the requested length", () => {
        expect(clean("x".repeat(500))).toHaveLength(64);
        expect(clean("x".repeat(500), 10)).toHaveLength(10);
    });

    test("turns anything that is not a string into a safe string", () => {
        expect(clean(null)).toBe("");
        expect(clean(undefined)).toBe("");
        expect(clean(42)).toBe("42");
        expect(clean({})).toBe("[object Object]");
    });
});
