#!/usr/bin/env bun

import { ArgsError, parseArgs, usage } from "./src/args.ts";
import { createDaemon } from "./src/daemon.ts";
import { ipv4Interfaces } from "./src/net.ts";

const argv = process.argv.slice(2);

if (argv.includes("--help") || argv.includes("-h")) {
    console.log(usage());
    process.exit(0);
}

let daemon;
try {
    daemon = createDaemon(parseArgs(argv));
} catch (err) {
    if (err instanceof ArgsError) {
        console.error(err.message);
        console.log(usage());
        process.exit(1);
    }
    throw err;
}

/* No single malformed request should be able to take the daemon down. */
process.on("unhandledRejection", (err) =>
    console.error("unhandled rejection:", err instanceof Error ? err.message : err),
);
process.on("uncaughtException", (err) => console.error("uncaught exception:", err.message));

daemon.server.on("error", (err: NodeJS.ErrnoException) => {
    if (err.code === "EADDRINUSE")
        console.error(`port ${daemon.self.port} is busy. try --port 8788`);
    else console.error(err.message);
    process.exit(1);
});

await daemon.listen();

const addresses = ipv4Interfaces().map((ni) => `http://${ni.address}:${daemon.self.port}`);
console.log(`ezyshare  "${daemon.self.name}"  id=${daemon.self.id}`);
console.log(`  http    ${addresses.join("  ")}`);
console.log(`  api     http://127.0.0.1:${daemon.self.port}/api  (paired extension only)`);
console.log(`  udp     broadcast on ${parseArgs(argv).dport}`);
console.log(
    daemon.secured
        ? "  secret  on - only daemons sharing this secret can see you or send to you"
        : "  secret  off - any ezyshare on this network can send you a link (--secret to lock it down)",
);
console.log("sharing state follows ~/.ezyshare/config.json; toggle it from the extension.");

for (const signal of ["SIGINT", "SIGTERM"] as const) {
    process.on(signal, () => {
        console.log("\nbye");
        process.exit(0);
    });
}
