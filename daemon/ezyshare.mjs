#!/usr/bin/env node
// ezyshare daemon - LAN peer discovery + link inbox for the ezyshare Chrome extension.
// Zero dependencies. Node >= 18.
//
// Three surfaces on one HTTP server:
//   /api/*            loopback only, one pinned chrome-extension:// origin, custom header required
//   /inbox            LAN, peer-to-peer link delivery, custom header + JSON content type required
//   /whoami           LAN, identity probe (used by manual --peer entries)

import http from 'node:http';
import dgram from 'node:dgram';
import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';

const DISCOVERY_PORT_DEFAULT = 38477;
const HTTP_PORT_DEFAULT = 8787;
const ANNOUNCE_INTERVAL_MS = 3000;
const PEER_TTL_MS = 12000;
const MAX_ITEMS = 200;
const MAX_PEERS = 256;
const MAX_NAME = 64;
const PEER_HEADER = 'x-ezyshare-peer';

// ---------------------------------------------------------------- args

function parseArgs(argv) {
  const out = { name: null, port: HTTP_PORT_DEFAULT, dport: DISCOVERY_PORT_DEFAULT, peers: [], dir: null, resetPairing: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = () => argv[++i];
    if (a === '--name' || a === '-n') out.name = next();
    else if (a === '--port' || a === '-p') out.port = Number(next());
    else if (a === '--discovery-port') out.dport = Number(next());
    else if (a === '--peer') out.peers.push(next());
    else if (a === '--dir') out.dir = next();
    else if (a === '--reset-pairing') out.resetPairing = true;
    else if (a === '--help' || a === '-h') { usage(); process.exit(0); }
    else { console.error(`unknown flag: ${a}`); usage(); process.exit(1); }
  }
  if (!Number.isInteger(out.port) || out.port < 1 || out.port > 65535) { console.error('bad --port'); process.exit(1); }
  if (!Number.isInteger(out.dport) || out.dport < 1 || out.dport > 65535) { console.error('bad --discovery-port'); process.exit(1); }
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
`);
}

const args = parseArgs(process.argv.slice(2));
const STATE_DIR = args.dir || path.join(os.homedir(), '.ezyshare');
fs.mkdirSync(STATE_DIR, { recursive: true, mode: 0o700 });

// Peer names, titles and log lines all come from the network. Keep them short, and strip
// every control and format character: those are what smuggle ANSI escapes into the
// operator's terminal and bidi overrides into the panel. Ordinary Unicode survives, so
// "Vaibhav's MacBook Air" keeps its curly apostrophe.
function clean(value, max = MAX_NAME) {
  return String(value ?? '').replace(/\p{C}/gu, '').slice(0, max).trim();
}

// ---------------------------------------------------------------- identity + config

const idFile = path.join(STATE_DIR, 'id');
let SELF_ID;
try {
  SELF_ID = fs.readFileSync(idFile, 'utf8').trim();
  if (!/^[0-9a-f]{16}$/.test(SELF_ID)) throw new Error('bad id');
} catch {
  SELF_ID = crypto.randomBytes(8).toString('hex');
  fs.writeFileSync(idFile, SELF_ID, { mode: 0o600 });
}
// The name people see. Prefer whatever the OS calls this machine in its own settings
// ("Vaibhav's MacBook Air") over the network hostname ("Vaibhavs-MacBook-Air.local").
function machineName() {
  if (process.platform === 'darwin') {
    try {
      const pretty = execFileSync('scutil', ['--get', 'ComputerName'], { encoding: 'utf8', timeout: 2000 }).trim();
      if (pretty) return pretty;
    } catch { /* fall through to hostname */ }
  }
  if (process.platform === 'win32' && process.env.COMPUTERNAME) return process.env.COMPUTERNAME;
  return os.hostname().replace(/\.local$/, '');
}

const SELF_NAME = clean(args.name || process.env.EZYSHARE_NAME || machineName()) || 'unnamed';
const HTTP_PORT = args.port;

const configFile = path.join(STATE_DIR, 'config.json');
let config = { enabled: true, extensionOrigin: null };
try {
  const saved = JSON.parse(fs.readFileSync(configFile, 'utf8'));
  config.enabled = saved.enabled !== false;
  if (typeof saved.extensionOrigin === 'string' && saved.extensionOrigin.startsWith('chrome-extension://')) {
    config.extensionOrigin = saved.extensionOrigin;
  }
} catch { /* first run */ }
if (args.resetPairing) config.extensionOrigin = null;

function saveConfig() {
  fs.writeFile(configFile, JSON.stringify(config, null, 2), { mode: 0o600 }, () => {});
}

// ---------------------------------------------------------------- state

/** @type {Map<string, {id:string,name:string,addr:string,port:number,lastSeen:number,manual:boolean}>} */
const peers = new Map();

const inboxFile = path.join(STATE_DIR, 'inbox.json');
let items = [];
let seq = 0;

function sanitizeItem(raw) {
  // Anything on disk is untrusted: a stale backup, a synced home dir, another local user.
  if (!raw || typeof raw !== 'object') return null;
  const url = safeUrl(raw.url);
  if (!url) return null;
  return {
    seq: Number.isSafeInteger(raw.seq) && raw.seq > 0 ? raw.seq : 0,
    id: /^[0-9a-f]{6,32}$/.test(raw.id) ? raw.id : crypto.randomBytes(6).toString('hex'),
    fromId: /^[0-9a-f]{0,32}$/.test(raw.fromId) ? raw.fromId : '',
    fromName: clean(raw.fromName || 'unknown'),
    url,
    title: clean(raw.title, 200),
    ts: Number.isSafeInteger(raw.ts) ? raw.ts : Date.now(),
    read: raw.read === true,
  };
}

try {
  const saved = JSON.parse(fs.readFileSync(inboxFile, 'utf8'));
  items = (Array.isArray(saved.items) ? saved.items : []).map(sanitizeItem).filter(Boolean).slice(-MAX_ITEMS);
  const highest = items.reduce((m, it) => Math.max(m, it.seq), 0);
  // Keep the counter monotonic across restarts, but never let a tampered file push it
  // somewhere absurd: the extension tracks this number and would go quiet.
  const claimed = Number.isSafeInteger(saved.seq) ? saved.seq : 0;
  seq = claimed >= highest && claimed <= highest + 1_000_000 ? claimed : highest;
} catch { /* first run */ }

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
  const full = { ...item, seq, id: crypto.randomBytes(6).toString('hex'), ts: Date.now(), read: false };
  items.push(full);
  if (items.length > MAX_ITEMS) items = items.slice(-MAX_ITEMS);
  saveInbox();
  wakeWaiters();
  return full;
}

// ---------------------------------------------------------------- rate limiting

function makeLimiter(limit, windowMs) {
  const seen = new Map();
  return (key) => {
    const now = Date.now();
    const entry = seen.get(key);
    if (!entry || now - entry.start > windowMs) { seen.set(key, { start: now, count: 1 }); return true; }
    if (seen.size > 4096) seen.clear();
    entry.count += 1;
    return entry.count <= limit;
  };
}

const inboxLimit = makeLimiter(12, 60_000);   // links accepted per source address per minute
const replyLimit = makeLimiter(1, 10_000);    // unsolicited announce replies per source address

// ---------------------------------------------------------------- addressing

function ipv4Interfaces() {
  return Object.values(os.networkInterfaces()).flat()
    .filter((ni) => ni && ni.family === 'IPv4' && !ni.internal && ni.netmask);
}

function toInt(ip) {
  const parts = ip.split('.').map(Number);
  if (parts.length !== 4 || parts.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return null;
  return ((parts[0] << 24) | (parts[1] << 16) | (parts[2] << 8) | parts[3]) >>> 0;
}

// Only trust announces coming from an address on one of our own IPv4 subnets. This blocks
// the spoofed loopback / link-local / metadata-endpoint peer that would turn /api/send
// into a port scanner for the victim's own machine.
function onLocalSubnet(ip) {
  const value = toInt(ip);
  if (value === null) return false;
  for (const ni of ipv4Interfaces()) {
    const net = toInt(ni.address);
    const mask = toInt(ni.netmask);
    if (net === null || mask === null) continue;
    if ((value & mask) >>> 0 === (net & mask) >>> 0) return true;
  }
  return false;
}

function isLoopbackHost(host) {
  const bare = host.replace(/^\[|\]$/g, '').toLowerCase();
  if (bare === 'localhost' || bare.endsWith('.localhost') || bare === '::1') return true;
  return /^127\./.test(bare);
}

function remoteIp(req) {
  return (req.socket.remoteAddress || '').replace(/^::ffff:/, '');
}

function safeUrl(raw) {
  try {
    const url = new URL(String(raw));
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
    // A link pointing at the recipient's own loopback is a CSRF payload against
    // whatever they happen to be running locally, not something worth sharing.
    if (isLoopbackHost(url.hostname)) return null;
    if (url.href.length > 2048) return null;
    return url.href;
  } catch { return null; }
}

// ---------------------------------------------------------------- discovery

function broadcastAddresses() {
  const out = new Set(['255.255.255.255']);
  for (const ni of ipv4Interfaces()) {
    const ip = ni.address.split('.').map(Number);
    const mask = ni.netmask.split('.').map(Number);
    out.add(ip.map((o, i) => (o | (~mask[i] & 255))).join('.'));
  }
  return [...out];
}

const sock = dgram.createSocket({ type: 'udp4', reuseAddr: true });

function sendAnnounce(target) {
  if (!config.enabled) return;
  const msg = Buffer.from(JSON.stringify({ t: 'hi', id: SELF_ID, name: SELF_NAME, port: HTTP_PORT }));
  const targets = target ? [target] : broadcastAddresses().map((a) => ({ address: a, port: args.dport }));
  for (const t of targets) {
    sock.send(msg, t.port, t.address, (err) => {
      if (err && process.env.EZYSHARE_DEBUG) console.error('announce failed', t.address, err.message);
    });
  }
}

sock.on('message', (buf, rinfo) => {
  if (!config.enabled || buf.length > 512) return;
  let msg;
  try { msg = JSON.parse(buf.toString()); } catch { return; }
  if (msg.t !== 'hi' || msg.id === SELF_ID) return;
  if (typeof msg.id !== 'string' || !/^[0-9a-f]{16}$/.test(msg.id)) return;
  const port = Number(msg.port);
  if (!Number.isInteger(port) || port < 1 || port > 65535) return;
  if (!onLocalSubnet(rinfo.address)) return;

  const existing = peers.get(msg.id);
  // First address wins for the lifetime of the entry: otherwise anyone who overhears a
  // broadcast can re-announce that id from their own address and quietly become that peer.
  if (existing && existing.addr !== rinfo.address) {
    if (Date.now() - existing.lastSeen < PEER_TTL_MS) {
      if (!existing.warned) {
        existing.warned = true;
        console.warn(`! ignoring second claim on id ${msg.id} from ${rinfo.address} (held by ${existing.addr})`);
      }
      return;
    }
  }
  if (!existing && peers.size >= MAX_PEERS) return;

  peers.set(msg.id, {
    id: msg.id,
    name: clean(msg.name || 'unknown'),
    addr: rinfo.address,
    port,
    lastSeen: Date.now(),
    manual: false,
  });

  // Reply straight away so a machine that just joined shows up instantly on both sides.
  if (!existing) {
    console.log(`+ ${clean(msg.name)} (${rinfo.address})`);
    if (replyLimit(rinfo.address)) sendAnnounce({ address: rinfo.address, port: args.dport });
  }
});

sock.on('error', (err) => {
  console.error(`discovery socket error: ${err.message}`);
  if (err.code === 'EADDRINUSE') {
    console.error('another ezyshare daemon is already running on this machine.');
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
    if (!p.manual && now - p.lastSeen > PEER_TTL_MS) {
      peers.delete(id);
      console.log(`- ${p.name}`);
    }
  }
}, 3000);

// Manual peers: for networks where UDP broadcast is blocked (some office / guest wifi).
async function probeManualPeers() {
  if (!config.enabled) return;
  for (const spec of args.peers) {
    const at = spec.lastIndexOf(':');
    const host = at > 0 ? spec.slice(0, at) : spec;
    const port = at > 0 ? Number(spec.slice(at + 1)) : HTTP_PORT_DEFAULT;
    if (!Number.isInteger(port) || port < 1 || port > 65535) continue;
    try {
      const res = await fetch(`http://${host}:${port}/whoami`, { signal: AbortSignal.timeout(2000) });
      const who = await res.json();
      if (typeof who.id !== 'string' || !/^[0-9a-f]{16}$/.test(who.id) || who.id === SELF_ID) continue;
      const existing = peers.get(who.id);
      // A hostile --peer must not be able to take over a peer discovered over UDP.
      if (existing && !existing.manual) continue;
      peers.set(who.id, { id: who.id, name: clean(who.name), addr: host, port, lastSeen: Date.now(), manual: true });
    } catch { /* peer offline */ }
  }
}
if (args.peers.length) { probeManualPeers(); setInterval(probeManualPeers, 5000); }

// ---------------------------------------------------------------- http

function json(res, code, body) {
  const payload = JSON.stringify(body);
  res.writeHead(code, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) });
  res.end(payload);
}

function readBody(req, limit = 16 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) { reject(new Error('body too large')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => {
      try { resolve(chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) : {}); }
      catch (e) { reject(e); }
    });
    req.on('error', reject);
  });
}

// Only another ezyshare daemon may deliver a link. A web page in the victim's browser
// cannot set a custom header without a preflight, and this route answers no preflight,
// so the browser blocks the request before it is sent.
function guardPeer(req, res) {
  if (req.headers.origin) { json(res, 403, { error: 'browser requests not accepted here' }); return false; }
  if (req.headers[PEER_HEADER] !== '1') { json(res, 403, { error: 'not an ezyshare peer' }); return false; }
  if (!/^application\/json\b/i.test(req.headers['content-type'] || '')) {
    json(res, 415, { error: 'expected application/json' });
    return false;
  }
  return true;
}

// The extension is the only thing allowed to touch /api/*. Three gates: loopback source,
// the one chrome-extension:// origin this daemon is paired with, and a custom header that
// forces a CORS preflight so a web page cannot forge a call.
function guardApi(req, res) {
  if (!['127.0.0.1', '::1'].includes(remoteIp(req))) { json(res, 403, { error: 'loopback only' }); return false; }
  const origin = req.headers.origin;
  if (origin) {
    if (!origin.startsWith('chrome-extension://')) { json(res, 403, { error: 'bad origin' }); return false; }
    if (!config.extensionOrigin) {
      config.extensionOrigin = origin;
      saveConfig();
      console.log(`paired with extension ${origin}`);
    } else if (config.extensionOrigin !== origin) {
      json(res, 403, { error: 'another extension is already paired; run with --reset-pairing to change it' });
      return false;
    }
    res.setHeader('access-control-allow-origin', origin);
    res.setHeader('access-control-allow-headers', 'content-type, x-ezyshare');
    res.setHeader('access-control-allow-methods', 'GET, POST, OPTIONS');
    res.setHeader('access-control-max-age', '600');
    res.setHeader('vary', 'origin');
  }
  if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return false; }
  if (!req.headers['x-ezyshare']) { json(res, 403, { error: 'missing x-ezyshare header' }); return false; }
  return true;
}

function peerList() {
  return [...peers.values()]
    .map(({ id, name, addr, port, lastSeen }) => ({ id, name, addr, port, lastSeen }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  const route = url.pathname;

  // ---- LAN surface -------------------------------------------------
  if (route === '/whoami' && req.method === 'GET') {
    if (!config.enabled) return json(res, 503, { error: 'sharing is off' });
    return json(res, 200, { id: SELF_ID, name: SELF_NAME, port: HTTP_PORT });
  }

  if (route === '/inbox' && req.method === 'POST') {
    if (!config.enabled) return json(res, 503, { error: 'sharing is off' });
    if (!guardPeer(req, res)) return;
    const ip = remoteIp(req);
    if (!inboxLimit(ip)) return json(res, 429, { error: 'slow down' });

    let body;
    try { body = await readBody(req); } catch { return json(res, 400, { error: 'bad body' }); }
    const link = safeUrl(body.url);
    if (!link) return json(res, 400, { error: 'url must be a non-loopback http or https link' });

    // The sender names itself, so believe it only when the claimed id is a peer we
    // already know at exactly this address. Otherwise the item is labelled as unknown.
    const claimed = typeof body.fromId === 'string' ? peers.get(body.fromId) : null;
    const verified = claimed && claimed.addr === ip;

    const item = addItem({
      fromId: verified ? claimed.id : '',
      fromName: verified ? claimed.name : `unknown (${clean(ip, 45)})`,
      url: link,
      title: clean(body.title, 200),
      verified: Boolean(verified),
    });
    console.log(`  in  ${item.fromName}: ${item.url}`);
    return json(res, 200, { ok: true });
  }

  // ---- extension surface -------------------------------------------
  if (!route.startsWith('/api/')) return json(res, 404, { error: 'not found' });
  if (!guardApi(req, res)) return;

  if (route === '/api/me') {
    return json(res, 200, { id: SELF_ID, name: SELF_NAME, port: HTTP_PORT, seq, enabled: config.enabled });
  }

  if (route === '/api/state') {
    if (req.method === 'POST') {
      let body;
      try { body = await readBody(req); } catch { return json(res, 400, { error: 'bad body' }); }
      const next = body.enabled === true;
      if (next !== config.enabled) {
        config.enabled = next;
        saveConfig();
        peers.clear();
        if (next) sendAnnounce();
        console.log(next ? 'sharing on' : 'sharing off (invisible to peers)');
      }
    }
    return json(res, 200, { enabled: config.enabled });
  }

  if (route === '/api/peers') {
    return json(res, 200, { me: { id: SELF_ID, name: SELF_NAME }, enabled: config.enabled, peers: config.enabled ? peerList() : [] });
  }

  if (route === '/api/send' && req.method === 'POST') {
    if (!config.enabled) return json(res, 409, { error: 'sharing is off' });
    let body;
    try { body = await readBody(req); } catch { return json(res, 400, { error: 'bad body' }); }
    const peer = peers.get(body.peerId);
    if (!peer) return json(res, 404, { error: 'peer not found' });
    const link = safeUrl(body.url);
    if (!link) return json(res, 400, { error: 'url must be a non-loopback http or https link' });
    try {
      const r = await fetch(`http://${peer.addr}:${peer.port}/inbox`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', [PEER_HEADER]: '1' },
        body: JSON.stringify({ fromId: SELF_ID, url: link, title: clean(body.title, 200) }),
        signal: AbortSignal.timeout(5000),
      });
      // Deliberately vague: relaying the peer's status or the socket error would turn
      // a click into a port scanner for whatever address that peer record points at.
      if (!r.ok) return json(res, 502, { error: `${peer.name} refused it` });
    } catch {
      return json(res, 502, { error: `could not reach ${peer.name}` });
    }
    console.log(`  out ${peer.name}: ${link}`);
    return json(res, 200, { ok: true, to: peer.name });
  }

  // Long poll: returns as soon as something newer than `since` lands, or after `wait` ms.
  if (route === '/api/inbox') {
    const since = Number(url.searchParams.get('since') || 0);
    const wait = Math.min(Math.max(Number(url.searchParams.get('wait')) || 0, 0), 60000);
    const fresh = () => items.filter((it) => it.seq > since);

    const reply = () => json(res, 200, { seq, items: fresh() });
    if (fresh().length || wait === 0) return reply();

    let done = false;
    const finish = () => { if (done) return; done = true; clearTimeout(timer); reply(); };
    const timer = setTimeout(finish, wait);
    waiters.push(finish);
    req.on('close', () => {
      done = true;
      clearTimeout(timer);
      waiters = waiters.filter((fn) => fn !== finish);
    });
    return;
  }

  if (route === '/api/inbox/read' && req.method === 'POST') {
    let body;
    try { body = await readBody(req); } catch { return json(res, 400, { error: 'bad body' }); }
    const ids = new Set(Array.isArray(body.ids) ? body.ids.slice(0, MAX_ITEMS) : []);
    const all = body.all === true;
    for (const it of items) if (all || ids.has(it.id)) it.read = true;
    saveInbox();
    return json(res, 200, { ok: true, unread: items.filter((it) => !it.read).length });
  }

  if (route === '/api/inbox/clear' && req.method === 'POST') {
    items = [];
    saveInbox();
    return json(res, 200, { ok: true });
  }

  return json(res, 404, { error: 'not found' });
});

server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') console.error(`port ${HTTP_PORT} is busy. try --port 8788`);
  else console.error(err.message);
  process.exit(1);
});

server.listen(HTTP_PORT, '0.0.0.0', () => {
  const ips = ipv4Interfaces().map((ni) => ni.address);
  console.log(`ezyshare  "${SELF_NAME}"  id=${SELF_ID}`);
  console.log(`  http    ${ips.map((ip) => `http://${ip}:${HTTP_PORT}`).join('  ')}`);
  console.log(`  api     http://127.0.0.1:${HTTP_PORT}/api  (paired extension only)`);
  console.log(`  udp     broadcast on ${args.dport}`);
  console.log(config.enabled ? 'sharing on. waiting for peers...' : 'sharing off. turn it on from the extension.');
});

for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => { console.log('\nbye'); process.exit(0); });
}
