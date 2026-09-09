import type { Server } from "node:http";
import { createConfigStore } from "./config.store.ts";
import { createDiscovery } from "./discovery.ts";
import { createInboxStore } from "./inbox.store.ts";
import { createPairing } from "./pairing.ts";
import { createPeerStore } from "./peers.store.ts";
import { createSigner } from "./secret.ts";
import { createServer } from "./server.ts";
import { loadSecret, loadSelfId, prepareStateDir, resolveName } from "./identity.ts";
import { stateDirFor } from "./args.ts";
import type { CliArgs, Identity } from "./ezyshare.type.ts";
import type { Discovery } from "./discovery.ts";

export type Daemon = {
    self: Identity;
    stateDir: string;
    secured: boolean;
    server: Server;
    discovery: Discovery;
    pairingCode: () => string;
    listen: () => Promise<void>;
    close: () => Promise<void>;
};

export function createDaemon(args: CliArgs): Daemon {
    const stateDir = prepareStateDir(stateDirFor(args.dir));
    const self: Identity = {
        id: loadSelfId(stateDir),
        name: resolveName(args.name),
        port: args.port,
    };

    const secret = loadSecret(stateDir, args.secret);
    const signer = secret ? createSigner(secret) : null;
    const config = createConfigStore(stateDir, args.resetPairing);
    const peers = createPeerStore();
    const inbox = createInboxStore(stateDir);

    const discovery = createDiscovery({
        self,
        dport: args.dport,
        manualPeers: args.peers,
        peers,
        config,
        signer,
    });

    const pairing = createPairing((code) => {
        console.log("");
        console.log(`  A different extension is asking to pair with this daemon.`);
        console.log(`  If that was you, enter this code in its side panel:  ${code}`);
        console.log(`  It expires in five minutes.`);
        console.log("");
    });

    const server = createServer({ self, config, peers, inbox, signer, discovery, pairing });

    return {
        self,
        stateDir,
        secured: signer !== null,
        server,
        discovery,
        pairingCode: () => pairing.challenge(),

        listen() {
            return new Promise((resolve, reject) => {
                server.once("error", reject);
                server.listen(self.port, "0.0.0.0", () => {
                    server.removeListener("error", reject);
                    discovery.start();
                    resolve();
                });
            });
        },

        close() {
            discovery.stop();
            signer?.stop();
            return new Promise((resolve) => server.close(() => resolve()));
        },
    };
}
