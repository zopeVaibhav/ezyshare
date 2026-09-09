#!/usr/bin/env node

import http from "node:http";
import dgram from "node:dgram";
import os from "node:os";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { execFileSync } from "node:child_process";
import dns from "node:dns";

/*
  Three surfaces share one HTTP server, each with its own trust level:
  /api/*   loopback only, one pinned chrome-extension:// origin, X-Ezyshare header
  /inbox   LAN peers only, X-Ezyshare-Peer header, JSON body, no Origin
  /whoami  anyone on the LAN, identity only
*/
const DISCOVERY_PORT_DEFAULT = 38477;
const HTTP_PORT_DEFAULT = 8787;
const ANNOUNCE_INTERVAL_MS = 3000;
const PEER_TTL_MS = 12000;
const MAX_ITEMS = 200;
const MAX_PEERS = 256;
const MAX_NAME = 64;
const PEER_HEADER = "x-ezyshare-peer";

function parseArgs(argv) {
    const out = {
        name: null,
        port: HTTP_PORT_DEFAULT,
        dport: DISCOVERY_PORT_DEFAULT,
        peers: [],
        dir: null,
        resetPairing: false,
        secret: null,
    };
    for (let i = 0; i < argv.length; i++) {
        const a = argv[i];
        const next = () => argv[++i];
        if (a === "--name" || a === "-n") out.name = next();
        else if (a === "--port" || a === "-p") out.port = Number(next());
        else if (a === "--discovery-port") out.dport = Number(next());
        else if (a === "--peer") out.peers.push(next());
        else if (a === "--dir") out.dir = next();
        else if (a === "--reset-pairing") out.resetPairing = true;
        else if (a === "--secret") out.secret = next();
        else if (a === "--help" || a === "-h") {
            usage();
            process.exit(0);
        } else {
            console.error(`unknown flag: ${a}`);
            usage();
            process.exit(1);
        }
    }
    if (!Number.isInteger(out.port) || out.port < 1 || out.port > 65535) {
        console.error("bad --port");
        process.exit(1);
    }
    if (!Number.isInteger(out.dport) || out.dport < 1 || out.dport > 65535) {
        console.error("bad --discovery-port");
        process.exit(1);
    }
    return out;
}

function usage() {
    console.log(`ezyshare daemon

  --name <str>            override the display name (default: this machine's name)
  --port <n>              http port (default ${HTTP_PORT_DEFAULT})
  --discovery-port <n>    udp broadcast port (default ${DISCOVERY_PORT_DEFAULT})
  --peer <host:port>      add a peer manually (repeatable, for when broadcast is blocked)
  --dir <path>            state directory (default ~/.ezyshare)
  --reset-pairing         forget the paired extension, so a new one can pair
  --secret <str>          shared secret; only daemons with the same one can see you or
                          send to you. Also EZYSHARE_SECRET or <dir>/secret. Off by default.
`);
}

const args = parseArgs(process.argv.slice(2));
const STATE_DIR = args.dir || path.join(os.homedir(), ".ezyshare");
fs.mkdirSync(STATE_DIR, { recursive: true, mode: 0o700 });
try {
    /*
      mkdirSync only applies the mode when it creates the directory, and an installer
      may have made it first under the login umask.
    */
    fs.chmodSync(STATE_DIR, 0o700);
} catch {
    /* not ours to fix */
}

/*
  Strips control and format characters, which is what smuggles ANSI escapes into the
  operator's terminal and bidi overrides into the panel. Ordinary Unicode survives.
*/
function clean(value, max = MAX_NAME) {
    return String(value ?? "")
        .replace(/\p{C}/gu, "")
        .slice(0, max)
        .trim();
}

const idFile = path.join(STATE_DIR, "id");
let SELF_ID;
try {
    SELF_ID = fs.readFileSync(idFile, "utf8").trim();
    if (!/^[0-9a-f]{16}$/.test(SELF_ID)) throw new Error("bad id");
} catch {
    SELF_ID = crypto.randomBytes(8).toString("hex");
    fs.writeFileSync(idFile, SELF_ID, { mode: 0o600 });
}
function machineName() {
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

const SELF_NAME = clean(args.name || process.env.EZYSHARE_NAME || machineName()) || "unnamed";
const HTTP_PORT = args.port;

const configFile = path.join(STATE_DIR, "config.json");
const config = { enabled: true, extensionOrigin: null };
try {
    const saved = JSON.parse(fs.readFileSync(configFile, "utf8"));
    config.enabled = saved.enabled !== false;
    if (
        typeof saved.extensionOrigin === "string" &&
        saved.extensionOrigin.startsWith("chrome-extension://")
    ) {
        config.extensionOrigin = saved.extensionOrigin;
    }
} catch {
    /* first run */
}
if (args.resetPairing) config.extensionOrigin = null;

function saveConfig() {
    fs.writeFile(configFile, JSON.stringify(config, null, 2), { mode: 0o600 }, () => {});
}

function loadSecret() {
    if (args.secret) return args.secret;
    if (process.env.EZYSHARE_SECRET) return process.env.EZYSHARE_SECRET;
    try {
        const fromFile = fs.readFileSync(path.join(STATE_DIR, "secret"), "utf8").trim();
        if (fromFile) return fromFile;
    } catch {
        /* no secret file, stay open */
    }
    return null;
}
const SECRET = loadSecret();

const CLOCK_SKEW_MS = 30_000;

function hmac(canonical) {
    return crypto.createHmac("sha256", SECRET).update(canonical).digest("hex");
}

function macEquals(expected, got) {
    if (typeof got !== "string" || got.length !== expected.length) return false;
    return crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(got));
}

function withinSkew(ts) {
    return Number.isFinite(ts) && Math.abs(Date.now() - ts) <= CLOCK_SKEW_MS;
}

/*
  A signed message is good exactly once, so one captured off the wire cannot be
  replayed inside the skew window, which a MAC on its own would still allow.
*/
const usedNonces = new Map();
function nonceIsNew(nonce) {
    if (typeof nonce !== "string" || nonce.length < 8 || nonce.length > 160) return false;
    if (usedNonces.has(nonce)) return false;
    usedNonces.set(nonce, Date.now() + CLOCK_SKEW_MS * 2);
    return true;
}
if (SECRET) {
    setInterval(() => {
        const now = Date.now();
        for (const [n, exp] of usedNonces) if (exp < now) usedNonces.delete(n);
    }, CLOCK_SKEW_MS).unref();
}

const announceMac = (id, name, port, ts) => hmac(`hi|${id}|${name}|${port}|${ts}`);
const whoamiMac = (id, name, port, nonce) => hmac(`whoami|${id}|${name}|${port}|${nonce}`);
const inboxMac = (rawBody) => hmac(`inbox|${rawBody}`);

/** @type {Map<string, {id:string,name:string,addr:string,port:number,lastSeen:number,manual:boolean}>} */
const peers = new Map();

const inboxFile = path.join(STATE_DIR, "inbox.json");
let items = [];
let seq = 0;

/*
  Everything on disk is untrusted: a stale backup, a synced home directory, another
  local user. An item whose verified flag did not survive is treated as unverified
  rather than promoted to looking like it came from a known peer.
*/
function sanitizeItem(raw) {
    if (!raw || typeof raw !== "object") return null;
    const url = safeUrl(raw.url);
    if (!url) return null;
    return {
        seq: Number.isSafeInteger(raw.seq) && raw.seq > 0 ? raw.seq : null,
        id: /^[0-9a-f]{6,32}$/.test(raw.id) ? raw.id : crypto.randomBytes(6).toString("hex"),
        fromId: /^[0-9a-f]{0,32}$/.test(raw.fromId) ? raw.fromId : "",
        fromName: clean(raw.fromName || "unknown"),
        url,
        title: clean(raw.title, 200),
        ts: Number.isSafeInteger(raw.ts) ? raw.ts : Date.now(),
        read: raw.read === true,
        verified: raw.verified === true,
    };
}

try {
    const saved = JSON.parse(fs.readFileSync(inboxFile, "utf8"));
    items = (Array.isArray(saved.items) ? saved.items : [])
        .map(sanitizeItem)
        .filter(Boolean)
        .slice(-MAX_ITEMS);
    /*
      An item with no usable seq would sit below every `since` value and stay invisible
      forever while still occupying a slot.
    */
    let next = items.reduce((m, it) => Math.max(m, it.seq || 0), 0);
    for (const it of items) if (it.seq === null) it.seq = ++next;
    const highest = items.reduce((m, it) => Math.max(m, it.seq), 0);
    const claimed = Number.isSafeInteger(saved.seq) ? saved.seq : 0;
    seq = claimed >= highest && claimed <= highest + 1_000_000 ? claimed : highest;
} catch {
    /* first run */
}

let waiters = [];

function wakeWaiters() {
    const pending = waiters;
    waiters = [];
    for (const fn of pending) fn();
}

let saveTimer = null;
function saveInbox() {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => {
        fs.writeFile(inboxFile, JSON.stringify({ seq, items }, null, 2), { mode: 0o600 }, () => {});
    }, 200);
}

function addItem(item) {
    seq += 1;
    const full = {
        ...item,
        seq,
        id: crypto.randomBytes(6).toString("hex"),
        ts: Date.now(),
        read: false,
    };
    items.push(full);
    if (items.length > MAX_ITEMS) items = items.slice(-MAX_ITEMS);
    saveInbox();
    wakeWaiters();
    return full;
}

const LIMITER_KEYS = 4096;

function makeLimiter(limit, windowMs) {
    const seen = new Map();
    return (key) => {
        const now = Date.now();
        const entry = seen.get(key);
        if (entry && now - entry.start <= windowMs) {
            entry.count += 1;
            return entry.count <= limit;
        }
        if (!entry && seen.size >= LIMITER_KEYS) {
            /*
              Never drop a live bucket to make room. Clearing the map, or evicting the oldest key,
              both let a flood of fresh keys reset the counter of an address already over its
              limit. Reclaim expired buckets only, then deny the flooder rather than the victim.
            */
            for (const [k, v] of seen) {
                if (now - v.start > windowMs) seen.delete(k);
                if (seen.size < LIMITER_KEYS) break;
            }
            if (seen.size >= LIMITER_KEYS) return false;
        }
        seen.set(key, { start: now, count: 1 });
        return true;
    };
}

const inboxLimit = makeLimiter(12, 60_000); // links accepted per source address per minute
const replyLimit = makeLimiter(1, 10_000); // unsolicited announce replies per source address
const announceLimit = makeLimiter(4, 60_000); // *new* peer ids accepted per source address per minute

function ipv4Interfaces() {
    return Object.values(os.networkInterfaces())
        .flat()
        .filter((ni) => ni && ni.family === "IPv4" && !ni.internal && ni.netmask);
}

function toInt(ip) {
    const parts = ip.split(".").map(Number);
    if (parts.length !== 4 || parts.some((n) => !Number.isInteger(n) || n < 0 || n > 255))
        return null;
    return ((parts[0] << 24) | (parts[1] << 16) | (parts[2] << 8) | parts[3]) >>> 0;
}

let subnetCache = { at: 0, list: [] };
function localSubnets() {
    if (Date.now() - subnetCache.at > 30_000)
        subnetCache = { at: Date.now(), list: ipv4Interfaces() };
    return subnetCache.list;
}

/*
  Announces are trusted only from our own IPv4 subnets. This is what stops a spoofed
  loopback or metadata-endpoint peer turning /api/send into a port scanner.
*/
function onLocalSubnet(ip) {
    const value = toInt(ip);
    if (value === null) return false;
    for (const ni of localSubnets()) {
        const net = toInt(ni.address);
        const mask = toInt(ni.netmask);
        if (net === null || mask === null) continue;
        if ((value & mask) >>> 0 === (net & mask) >>> 0) return true;
    }
    return false;
}

/*
  The URL parser already collapses 127.1, 2130706433 and 0x7f000001 to 127.0.0.1.
  These are the spellings it does not collapse, and each still reaches the
  recipient's own machine.
*/
function isLoopbackHost(host) {
    const bare = host
        .replace(/^\[|\]$/g, "")
        .toLowerCase()
        .replace(/\.$/, "");
    if (bare === "localhost" || bare.endsWith(".localhost")) return true;
    if (bare === "::1" || bare === "::" || bare === "0.0.0.0" || bare === "0") return true;
    if (/^::ffff:(7f[0-9a-f]{2}:|0:0)/.test(bare)) return true; // IPv4-mapped 127.x and 0.0.0.0
    if (/^169\.254\./.test(bare)) return true; // link-local, incl. cloud metadata
    return /^127\./.test(bare);
}

function remoteIp(req) {
    return (req.socket.remoteAddress || "").replace(/^::ffff:/, "");
}

function safeUrl(raw) {
    try {
        const url = new URL(String(raw));
        if (url.protocol !== "http:" && url.protocol !== "https:") return null;
        if (isLoopbackHost(url.hostname)) return null;
        if (url.href.length > 2048) return null;
        return url.href;
    } catch {
        return null;
    }
}

function broadcastAddresses() {
    const out = new Set(["255.255.255.255"]);
    for (const ni of ipv4Interfaces()) {
        const ip = ni.address.split(".").map(Number);
        const mask = ni.netmask.split(".").map(Number);
        out.add(ip.map((o, i) => o | (~mask[i] & 255)).join("."));
    }
    return [...out];
}

const sock = dgram.createSocket({ type: "udp4", reuseAddr: true });

function sendAnnounce(target) {
    if (!config.enabled) return;
    const body = { t: "hi", id: SELF_ID, name: SELF_NAME, port: HTTP_PORT };
    if (SECRET) {
        body.ts = Date.now();
        body.mac = announceMac(SELF_ID, SELF_NAME, HTTP_PORT, body.ts);
    }
    const msg = Buffer.from(JSON.stringify(body));
    const targets = target
        ? [target]
        : broadcastAddresses().map((a) => ({ address: a, port: args.dport }));
    for (const t of targets) {
        sock.send(msg, t.port, t.address, (err) => {
            if (err && process.env.EZYSHARE_DEBUG)
                console.error("announce failed", t.address, err.message);
        });
    }
}

sock.on("message", (buf, rinfo) => {
    if (!config.enabled || buf.length > 512) return;
    let msg;
    try {
        msg = JSON.parse(buf.toString());
    } catch {
        return;
    }
    if (msg.t !== "hi" || msg.id === SELF_ID) return;
    if (typeof msg.id !== "string" || !/^[0-9a-f]{16}$/.test(msg.id)) return;
    const port = Number(msg.port);
    if (!Number.isInteger(port) || port < 1 || port > 65535) return;
    if (!onLocalSubnet(rinfo.address)) return;
    if (SECRET) {
        if (!withinSkew(Number(msg.ts))) return;
        if (!macEquals(announceMac(msg.id, clean(msg.name || "unknown"), port, msg.ts), msg.mac))
            return;
        if (!nonceIsNew(`hi:${msg.id}:${msg.ts}:${msg.mac}`)) return;
    }

    const existing = peers.get(msg.id);
    /*
      First address and port win for the life of the entry, or anyone who overhears a
      broadcast can re-announce that id and quietly become that peer.
    */
    if (existing && (existing.addr !== rinfo.address || existing.port !== port)) {
        if (Date.now() - existing.lastSeen < PEER_TTL_MS) {
            if (!existing.warned) {
                existing.warned = true;
                console.warn(
                    `! ignoring second claim on id ${msg.id} from ${rinfo.address}:${port} (held by ${existing.addr}:${existing.port})`,
                );
            }
            return;
        }
    }
    if (!existing) {
        /*
          Rejecting at the cap turned unbounded growth into a lockout: 256 packets of random
          ids from one address hid every real peer. Rate limit new ids per source, and evict
          the stalest entry when the map is full instead of refusing the newcomer.
        */
        if (!announceLimit(rinfo.address)) return;
        if (peers.size >= MAX_PEERS) {
            const stalest = [...peers.values()].sort((a, b) => a.lastSeen - b.lastSeen)[0];
            if (!stalest) return;
            peers.delete(stalest.id);
        }
    }

    peers.set(msg.id, {
        id: msg.id,
        name: clean(msg.name || "unknown"),
        addr: rinfo.address,
        port,
        lastSeen: Date.now(),
        manual: false,
    });

    if (!existing) {
        console.log(`+ ${clean(msg.name)} (${rinfo.address})`);
        if (replyLimit(rinfo.address)) sendAnnounce({ address: rinfo.address, port: args.dport });
    }
});

sock.on("error", (err) => {
    console.error(`discovery socket error: ${err.message}`);
    if (err.code === "EADDRINUSE") {
        console.error("another ezyshare daemon is already running on this machine.");
        process.exit(1);
    }
});

sock.bind(args.dport, () => {
    sock.setBroadcast(true);
    sendAnnounce();
    setInterval(sendAnnounce, ANNOUNCE_INTERVAL_MS);
});

setInterval(() => {
    const now = Date.now();
    for (const [id, p] of peers) {
        if (now - p.lastSeen > PEER_TTL_MS) {
            peers.delete(id);
            console.log(`- ${p.name}`);
        }
    }
}, 3000);

async function probeManualPeers() {
    if (!config.enabled) return;
    for (const spec of args.peers) {
        const at = spec.lastIndexOf(":");
        const host = at > 0 ? spec.slice(0, at) : spec;
        const port = at > 0 ? Number(spec.slice(at + 1)) : HTTP_PORT_DEFAULT;
        if (!Number.isInteger(port) || port < 1 || port > 65535) continue;
        try {
            const nonce = crypto.randomBytes(16).toString("hex");
            const res = await fetch(`http://${host}:${port}/whoami?nonce=${nonce}`, {
                signal: AbortSignal.timeout(2000),
            });
            const who = await res.json();
            if (typeof who.id !== "string" || !/^[0-9a-f]{16}$/.test(who.id) || who.id === SELF_ID)
                continue;
            if (
                SECRET &&
                !macEquals(
                    whoamiMac(who.id, clean(who.name), Number(who.port) || port, nonce),
                    who.mac,
                )
            )
                continue;
            const existing = peers.get(who.id);
            if (existing && !existing.manual) continue;
            if (!existing && peers.size >= MAX_PEERS) continue;
            /*
              Store the resolved address, not the operator's string: sender verification compares
              against the socket's IP, which a hostname could never match.
            */
            const { address } = await dns.promises.lookup(host, { family: 4 });
            peers.set(who.id, {
                id: who.id,
                name: clean(who.name),
                addr: address,
                port,
                lastSeen: Date.now(),
                manual: true,
            });
        } catch {
            /* peer offline */
        }
    }
}
if (args.peers.length) {
    probeManualPeers();
    setInterval(probeManualPeers, 5000);
}

function json(res, code, body) {
    const payload = JSON.stringify(body);
    res.writeHead(code, {
        "content-type": "application/json",
        "content-length": Buffer.byteLength(payload),
    });
    res.end(payload);
}

function readBody(req, limit = 16 * 1024) {
    return new Promise((resolve, reject) => {
        let size = 0;
        const chunks = [];
        req.on("data", (c) => {
            size += c.length;
            if (size > limit) {
                reject(new Error("body too large"));
                req.destroy();
                return;
            }
            chunks.push(c);
        });
        req.on("end", () => {
            /*
              The raw text comes back too: /inbox authenticates the exact bytes it was sent, not a
              re-serialisation of them.
            */
            const raw = chunks.length ? Buffer.concat(chunks).toString() : "";
            try {
                const parsed = raw ? JSON.parse(raw) : {};
                resolve({
                    data:
                        /*
                          "null", "[]" and a bare string are all valid JSON. Handlers read properties off this
                          value, and a throw inside an async listener is an unhandled rejection, which kills
                          the process.
                        */
                        parsed && typeof parsed === "object" && !Array.isArray(parsed)
                            ? parsed
                            : {},
                    raw,
                });
            } catch (e) {
                reject(e);
            }
        });
        req.on("error", reject);
    });
}

/*
  Only another daemon may deliver a link. A page in the victim's browser cannot set a
  custom header without a preflight, and this route answers none, so the browser
  blocks the request before it is sent.
*/
function guardPeer(req, res) {
    if (req.headers.origin) {
        json(res, 403, { error: "browser requests not accepted here" });
        return false;
    }
    if (req.headers[PEER_HEADER] !== "1") {
        json(res, 403, { error: "not an ezyshare peer" });
        return false;
    }
    if (!/^application\/json\b/i.test(req.headers["content-type"] || "")) {
        json(res, 415, { error: "expected application/json" });
        return false;
    }
    return true;
}

/*
  Three gates on /api: a loopback source, the one chrome-extension origin this daemon
  is paired with, and a header that forces a preflight a web page cannot satisfy.
*/
function guardApi(req, res) {
    if (!["127.0.0.1", "::1"].includes(remoteIp(req))) {
        json(res, 403, { error: "loopback only" });
        return false;
    }
    const origin = req.headers.origin;
    if (origin) {
        if (!/^chrome-extension:\/\/[a-p]{32}$/.test(origin)) {
            json(res, 403, { error: "bad origin" });
            return false;
        }
        if (config.extensionOrigin && config.extensionOrigin !== origin) {
            json(res, 403, {
                error: "another extension is already paired; run with --reset-pairing to change it",
            });
            return false;
        }
        res.setHeader("access-control-allow-origin", origin);
        res.setHeader("access-control-allow-headers", "content-type, x-ezyshare");
        res.setHeader("access-control-allow-methods", "GET, POST, OPTIONS");
        res.setHeader("access-control-max-age", "600");
        res.setHeader("vary", "origin");
    }
    if (req.method === "OPTIONS") {
        res.writeHead(204);
        res.end();
        return false;
    }
    if (!req.headers["x-ezyshare"]) {
        json(res, 403, { error: "missing x-ezyshare header" });
        return false;
    }
    /*
      Pin only once the request has cleared every check. Doing it earlier let any local
      process burn the one-time pairing slot with a request that was then rejected.
    */
    if (origin && !config.extensionOrigin) {
        config.extensionOrigin = origin;
        saveConfig();
        console.log(`paired with extension ${clean(origin, 128)}`);
    }
    return true;
}

function peerList() {
    return [...peers.values()]
        .map(({ id, name, addr, port, lastSeen }) => ({ id, name, addr, port, lastSeen }))
        .sort((a, b) => a.name.localeCompare(b.name));
}

const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, "http://localhost");
    const route = url.pathname;

    if (route === "/whoami" && req.method === "GET") {
        if (!config.enabled) return json(res, 503, { error: "sharing is off" });
        const body = { id: SELF_ID, name: SELF_NAME, port: HTTP_PORT };
        const nonce = url.searchParams.get("nonce");
        if (SECRET && nonce) body.mac = whoamiMac(SELF_ID, SELF_NAME, HTTP_PORT, nonce);
        return json(res, 200, body);
    }

    if (route === "/inbox" && req.method === "POST") {
        if (!config.enabled) return json(res, 503, { error: "sharing is off" });
        if (!guardPeer(req, res)) return;
        const ip = remoteIp(req);
        if (!inboxLimit(ip)) return json(res, 429, { error: "slow down" });

        let body;
        let raw;
        try {
            ({ data: body, raw } = await readBody(req));
        } catch {
            return json(res, 400, { error: "bad body" });
        }
        if (SECRET) {
            if (!withinSkew(Number(body.ts)))
                return json(res, 401, { error: "stale or unsigned request" });
            if (!macEquals(inboxMac(raw), req.headers["x-ezyshare-mac"]))
                return json(res, 401, { error: "bad signature" });
            if (!nonceIsNew(String(body.nonce || "")))
                return json(res, 401, { error: "replayed request" });
        }
        const link = safeUrl(body.url);
        if (!link)
            return json(res, 400, { error: "url must be a non-loopback http or https link" });

        const claimed = typeof body.fromId === "string" ? peers.get(body.fromId) : null;
        const verified = claimed && claimed.addr === ip;

        const item = addItem({
            fromId: verified ? claimed.id : "",
            fromName: verified ? claimed.name : `unknown (${clean(ip, 45)})`,
            url: link,
            title: clean(body.title, 200),
            verified: Boolean(verified),
        });
        console.log(`  in  ${item.fromName}: ${new URL(item.url).hostname}`);
        return json(res, 200, { ok: true });
    }

    if (!route.startsWith("/api/")) return json(res, 404, { error: "not found" });
    if (!guardApi(req, res)) return;

    if (route === "/api/me") {
        return json(res, 200, {
            id: SELF_ID,
            name: SELF_NAME,
            port: HTTP_PORT,
            seq,
            enabled: config.enabled,
        });
    }

    if (route === "/api/state") {
        if (req.method === "POST") {
            let body;
            try {
                ({ data: body } = await readBody(req));
            } catch {
                return json(res, 400, { error: "bad body" });
            }
            const next = body.enabled === true;
            if (next !== config.enabled) {
                config.enabled = next;
                saveConfig();
                peers.clear();
                if (next) sendAnnounce();
                console.log(next ? "sharing on" : "sharing off (invisible to peers)");
            }
        }
        return json(res, 200, { enabled: config.enabled });
    }

    if (route === "/api/peers") {
        return json(res, 200, {
            me: { id: SELF_ID, name: SELF_NAME },
            enabled: config.enabled,
            secured: Boolean(SECRET),
            peers: config.enabled ? peerList() : [],
        });
    }

    if (route === "/api/send" && req.method === "POST") {
        if (!config.enabled) return json(res, 409, { error: "sharing is off" });
        let body;
        try {
            ({ data: body } = await readBody(req));
        } catch {
            return json(res, 400, { error: "bad body" });
        }
        const peer = peers.get(body.peerId);
        if (!peer) return json(res, 404, { error: "peer not found" });
        const link = safeUrl(body.url);
        if (!link)
            return json(res, 400, { error: "url must be a non-loopback http or https link" });
        const payload = { fromId: SELF_ID, url: link, title: clean(body.title, 200) };
        if (SECRET) {
            payload.ts = Date.now();
            payload.nonce = crypto.randomBytes(16).toString("hex");
        }
        const rawOut = JSON.stringify(payload);
        const headers = { "content-type": "application/json", [PEER_HEADER]: "1" };
        if (SECRET) headers["x-ezyshare-mac"] = inboxMac(rawOut);
        try {
            const r = await fetch(`http://${peer.addr}:${peer.port}/inbox`, {
                method: "POST",
                headers,
                body: rawOut,
                signal: AbortSignal.timeout(5000),
            });
            /*
              Deliberately vague. Relaying the peer's status or the socket error would turn one
              click into a port scanner for whatever address that peer record points at.
            */
            if (!r.ok) return json(res, 502, { error: `${peer.name} refused it` });
        } catch {
            return json(res, 502, { error: `could not reach ${peer.name}` });
        }
        console.log(`  out ${peer.name}: ${new URL(link).hostname}`);
        return json(res, 200, { ok: true, to: peer.name });
    }

    if (route === "/api/inbox") {
        const since = Number(url.searchParams.get("since") || 0);
        const wait = Math.min(Math.max(Number(url.searchParams.get("wait")) || 0, 0), 60000);
        const fresh = () => items.filter((it) => it.seq > since);

        const reply = () => json(res, 200, { seq, items: fresh() });
        if (fresh().length || wait === 0) return reply();

        let done = false;
        const finish = () => {
            if (done) return;
            done = true;
            clearTimeout(timer);
            reply();
        };
        const timer = setTimeout(finish, wait);
        waiters.push(finish);
        req.on("close", () => {
            done = true;
            clearTimeout(timer);
            waiters = waiters.filter((fn) => fn !== finish);
        });
        return;
    }

    if (route === "/api/inbox/read" && req.method === "POST") {
        let body;
        try {
            ({ data: body } = await readBody(req));
        } catch {
            return json(res, 400, { error: "bad body" });
        }
        const ids = new Set(Array.isArray(body.ids) ? body.ids.slice(0, MAX_ITEMS) : []);
        const all = body.all === true;
        for (const it of items) if (all || ids.has(it.id)) it.read = true;
        saveInbox();
        return json(res, 200, { ok: true, unread: items.filter((it) => !it.read).length });
    }

    if (route === "/api/inbox/clear" && req.method === "POST") {
        items = [];
        saveInbox();
        return json(res, 200, { ok: true });
    }

    return json(res, 404, { error: "not found" });
});

server.on("error", (err) => {
    if (err.code === "EADDRINUSE") console.error(`port ${HTTP_PORT} is busy. try --port 8788`);
    else console.error(err.message);
    process.exit(1);
});

server.listen(HTTP_PORT, "0.0.0.0", () => {
    const ips = ipv4Interfaces().map((ni) => ni.address);
    console.log(`ezyshare  "${SELF_NAME}"  id=${SELF_ID}`);
    console.log(`  http    ${ips.map((ip) => `http://${ip}:${HTTP_PORT}`).join("  ")}`);
    console.log(`  api     http://127.0.0.1:${HTTP_PORT}/api  (paired extension only)`);
    console.log(`  udp     broadcast on ${args.dport}`);
    console.log(
        SECRET
            ? "  secret  on - only daemons sharing this secret can see you or send to you"
            : "  secret  off - any ezyshare on this network can send you a link (--secret to lock it down)",
    );
    console.log(
        config.enabled
            ? "sharing on. waiting for peers..."
            : "sharing off. turn it on from the extension.",
    );
});

process.on("unhandledRejection", (err) =>
    console.error("unhandled rejection:", err?.message || err),
);
process.on("uncaughtException", (err) => console.error("uncaught exception:", err?.message || err));
server.on("clientError", (err, socket) => {
    if (socket.writable) socket.end("HTTP/1.1 400 Bad Request\r\n\r\n");
});

for (const sig of ["SIGINT", "SIGTERM"]) {
    process.on(sig, () => {
        console.log("\nbye");
        process.exit(0);
    });
}
