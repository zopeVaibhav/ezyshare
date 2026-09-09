import path from "node:path";
import os from "node:os";
import { DISCOVERY_PORT_DEFAULT, HTTP_PORT_DEFAULT } from "./constants.ts";
import type { CliArgs } from "./ezyshare.type.ts";

export function usage(): string {
    return `ezyshare daemon

  --name <str>            override the display name (default: this machine's name)
  --port <n>              http port (default ${HTTP_PORT_DEFAULT})
  --discovery-port <n>    udp broadcast port (default ${DISCOVERY_PORT_DEFAULT})
  --peer <host:port>      add a peer manually (repeatable, for when broadcast is blocked)
  --dir <path>            state directory (default ~/.ezyshare)
  --reset-pairing         forget the paired extension, so a new one can pair
  --secret <str>          shared secret; only daemons with the same one can see you or
                          send to you. Also EZYSHARE_SECRET or <dir>/secret. Off by default.
`;
}

export class ArgsError extends Error {}

export function parseArgs(argv: string[]): CliArgs {
    const out: CliArgs = {
        name: null,
        port: HTTP_PORT_DEFAULT,
        dport: DISCOVERY_PORT_DEFAULT,
        peers: [],
        dir: null,
        resetPairing: false,
        secret: null,
    };

    for (let i = 0; i < argv.length; i++) {
        const flag = argv[i];
        const next = (): string => {
            const value = argv[++i];
            if (value === undefined) throw new ArgsError(`${flag} needs a value`);
            return value;
        };

        if (flag === "--name" || flag === "-n") out.name = next();
        else if (flag === "--port" || flag === "-p") out.port = Number(next());
        else if (flag === "--discovery-port") out.dport = Number(next());
        else if (flag === "--peer") out.peers.push(next());
        else if (flag === "--dir") out.dir = next();
        else if (flag === "--reset-pairing") out.resetPairing = true;
        else if (flag === "--secret") out.secret = next();
        else throw new ArgsError(`unknown flag: ${flag}`);
    }

    for (const [label, value] of [
        ["--port", out.port],
        ["--discovery-port", out.dport],
    ] as const) {
        if (!Number.isInteger(value) || value < 1 || value > 65535) {
            throw new ArgsError(`bad ${label}`);
        }
    }

    return out;
}

export function stateDirFor(dir: string | null): string {
    return dir ?? path.join(os.homedir(), ".ezyshare");
}
