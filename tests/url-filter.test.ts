import { describe, expect, test } from "bun:test";
import { isLoopbackHost, safeUrl } from "../daemon/src/net.ts";

describe("safeUrl", () => {
    test("accepts ordinary http and https links", () => {
        expect(safeUrl("https://example.com/a?b=c")).toBe("https://example.com/a?b=c");
        expect(safeUrl("http://192.168.1.20:3000/dev")).toBe("http://192.168.1.20:3000/dev");
    });

    test("rejects non-http schemes", () => {
        for (const url of [
            "javascript:alert(1)",
            "file:///etc/passwd",
            "data:text/html,x",
            "ftp://x.com",
        ]) {
            expect(safeUrl(url)).toBeNull();
        }
    });

    /*
        Every one of these reaches the recipient's own machine. The first four were
        accepted by an earlier version of this filter.
    */
    test("rejects loopback in the spellings the URL parser does not collapse", () => {
        for (const url of [
            "http://0.0.0.0:9200/x",
            "http://0/x",
            "http://[::]/x",
            "http://[::ffff:127.0.0.1]/x",
            "http://localhost./x",
        ]) {
            expect(safeUrl(url)).toBeNull();
        }
    });

    test("rejects loopback in the spellings the URL parser does collapse", () => {
        for (const url of [
            "http://127.0.0.1/x",
            "http://127.1/x",
            "http://2130706433/x",
            "http://0x7f000001/x",
            "http://localhost/x",
            "http://foo.localhost/x",
            "http://[::1]/x",
        ]) {
            expect(safeUrl(url)).toBeNull();
        }
    });

    test("rejects link-local, which covers the cloud metadata endpoint", () => {
        expect(safeUrl("http://169.254.169.254/latest/meta-data")).toBeNull();
    });

    test("rejects a url longer than the cap", () => {
        expect(safeUrl(`https://example.com/${"a".repeat(3000)}`)).toBeNull();
    });

    test("rejects values that are not urls at all", () => {
        for (const value of [null, undefined, 42, {}, [], ""]) {
            expect(safeUrl(value)).toBeNull();
        }
    });
});

describe("isLoopbackHost", () => {
    test("leaves routable hosts alone", () => {
        for (const host of ["example.com", "192.168.1.5", "10.0.0.1", "128.0.0.1"]) {
            expect(isLoopbackHost(host)).toBe(false);
        }
    });
});
