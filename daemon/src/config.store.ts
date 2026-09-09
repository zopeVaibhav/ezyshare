import fs from "node:fs";
import path from "node:path";
import { EXTENSION_ORIGIN } from "./constants.ts";
import type { DaemonConfig } from "./ezyshare.type.ts";

export type ConfigStore = {
    current: DaemonConfig;
    save: () => void;
};

export function createConfigStore(stateDir: string, resetPairing: boolean): ConfigStore {
    const file = path.join(stateDir, "config.json");
    const current: DaemonConfig = { enabled: true, extensionOrigin: null };

    try {
        const saved: unknown = JSON.parse(fs.readFileSync(file, "utf8"));
        if (saved && typeof saved === "object") {
            const record = saved as Record<string, unknown>;
            current.enabled = record.enabled !== false;
            if (
                typeof record.extensionOrigin === "string" &&
                EXTENSION_ORIGIN.test(record.extensionOrigin)
            ) {
                current.extensionOrigin = record.extensionOrigin;
            }
        }
    } catch {
        /* first run */
    }

    if (resetPairing) current.extensionOrigin = null;

    return {
        current,
        save() {
            fs.writeFile(file, JSON.stringify(current, null, 2), { mode: 0o600 }, () => {});
        },
    };
}
