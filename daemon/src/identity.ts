import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { PEER_ID } from "./constants.ts";
import { clean } from "./text.ts";

/*
    The name people see. Prefer whatever the OS calls this machine in its own settings
    ("Vaibhav's MacBook Air") over the network hostname ("Vaibhavs-MacBook-Air.local").
*/
export function machineName(): string {
    if (process.platform === "darwin") {
        try {
            const pretty = execFileSync("scutil", ["--get", "ComputerName"], {
                encoding: "utf8",
                timeout: 2000,
            }).trim();
            if (pretty) return pretty;
        } catch {
            /* fall through to hostname */
        }
    }
    if (process.platform === "win32" && process.env.COMPUTERNAME) return process.env.COMPUTERNAME;
    return os.hostname().replace(/\.local$/, "");
}

export function loadSelfId(stateDir: string): string {
    const idFile = path.join(stateDir, "id");
    try {
        const saved = fs.readFileSync(idFile, "utf8").trim();
        if (PEER_ID.test(saved)) return saved;
    } catch {
        /* first run */
    }
    const fresh = crypto.randomBytes(8).toString("hex");
    fs.writeFileSync(idFile, fresh, { mode: 0o600 });
    return fresh;
}

export function resolveName(override: string | null): string {
    return clean(override ?? process.env.EZYSHARE_NAME ?? machineName()) || "unnamed";
}

export function prepareStateDir(dir: string): string {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    try {
        /*
            mkdirSync only applies the mode when it creates the directory, and an installer
            may have made it first under the login umask.
        */
        fs.chmodSync(dir, 0o700);
    } catch {
        /* not ours to fix */
    }
    return dir;
}

export function loadSecret(stateDir: string, override: string | null): string | null {
    if (override) return override;
    if (process.env.EZYSHARE_SECRET) return process.env.EZYSHARE_SECRET;
    try {
        const fromFile = fs.readFileSync(path.join(stateDir, "secret"), "utf8").trim();
        if (fromFile) return fromFile;
    } catch {
        /* no secret file, stay open */
    }
    return null;
}
