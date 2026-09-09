import { describe, expect, test } from "bun:test";
import { ArgsError, parseArgs } from "../daemon/src/args.ts";
import { DISCOVERY_PORT_DEFAULT, HTTP_PORT_DEFAULT } from "../daemon/src/constants.ts";

describe("parseArgs", () => {
    test("falls back to the defaults", () => {
        const args = parseArgs([]);
        expect(args.port).toBe(HTTP_PORT_DEFAULT);
        expect(args.dport).toBe(DISCOVERY_PORT_DEFAULT);
        expect(args.name).toBeNull();
        expect(args.secret).toBeNull();
        expect(args.peers).toEqual([]);
    });

    test("reads every flag", () => {
        const args = parseArgs([
            "--name",
            "Box",
            "--port",
            "9000",
            "--discovery-port",
            "9001",
            "--peer",
            "10.0.0.2:8787",
            "--peer",
            "10.0.0.3:8787",
            "--dir",
            "/tmp/x",
            "--reset-pairing",
            "--secret",
            "hunter2",
        ]);
        expect(args).toEqual({
            name: "Box",
            port: 9000,
            dport: 9001,
            peers: ["10.0.0.2:8787", "10.0.0.3:8787"],
            dir: "/tmp/x",
            resetPairing: true,
            secret: "hunter2",
        });
    });

    test("rejects an unknown flag", () => {
        expect(() => parseArgs(["--nope"])).toThrow(ArgsError);
    });

    test("rejects a flag with no value", () => {
        expect(() => parseArgs(["--name"])).toThrow(ArgsError);
    });

    test("rejects a port outside the valid range", () => {
        for (const port of ["0", "65536", "-1", "abc"]) {
            expect(() => parseArgs(["--port", port])).toThrow(ArgsError);
        }
    });
});
