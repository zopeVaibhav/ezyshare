#!/usr/bin/env node
// ezyshare daemon - LAN peer discovery + link inbox for the ezyshare Chrome extension.
// Zero dependencies. Node >= 18.
//
// Two surfaces on one HTTP server:
//   /api/*   loopback-only, used by the browser extension
//   /inbox   LAN, used by other ezyshare daemons to deliver a link
//   /whoami  LAN, identity probe (used by manual --peer entries)

import http from 'node:http';
import dgram from 'node:dgram';
import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

const DISCOVERY_PORT_DEFAULT = 38477;
const HTTP_PORT_DEFAULT = 8787;
const ANNOUNCE_INTERVAL_MS = 3000;
const PEER_TTL_MS = 12000;
const MAX_ITEMS = 200;
const CLOCK_SKEW_MS = 30000;   // how far a signed announce or POST may drift before we drop it
const CONFLICT_LOG_MS = 30000; // throttle for "someone else is claiming this peer" warnings

// ---------------------------------------------------------------- args

function parseArgs(argv) {
  const out = { name: null, port: HTTP_PORT_DEFAULT, dport: DISCOVERY_PORT_DEFAULT, peers: [], dir: null, secret: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = () => argv[++i];
    if (a === '--name' || a === '-n') out.name = next();
    else if (a === '--port' || a === '-p') out.port = Number(next());
    else if (a === '--discovery-port') out.dport = Number(next());
    else if (a === '--peer') out.peers.push(next());
    else if (a === '--dir') out.dir = next();
    else if (a === '--secret') out.secret = next();
    else if (a === '--help' || a === '-h') { usage(); process.exit(0); }
    else { console.error(`unknown flag: ${a}`); usage(); process.exit(1); }
  }
  return out;
}

function usage() {
  console.log(`ezyshare daemon

  --name <str>            display name other people see (default: hostname)
  --port <n>              http port (default ${HTTP_PORT_DEFAULT})
  --discovery-port <n>    udp broadcast port (default ${DISCOVERY_PORT_DEFAULT})
  --peer <host:port>      add a peer manually (repeatable, for when broadcast is blocked)
  --dir <path>            state directory (default ~/.ezyshare)
  --secret <str>          shared secret; only daemons with the same one can be seen or
                          send to you. Also settable via EZYSHARE_SECRET or a file at
                          <dir>/secret. Off by default.
`);
}

const args = parseArgs(process.argv.slice(2));
const STATE_DIR = args.dir || path.join(os.homedir(), '.ezyshare');
fs.mkdirSync(STATE_DIR, { recursive: true });

// ---------------------------------------------------------------- identity

const idFile = path.join(STATE_DIR, 'id');
let SELF_ID;
try {
  SELF_ID = fs.readFileSync(idFile, 'utf8').trim();
  if (!SELF_ID) throw new Error('empty');
} catch {
  SELF_ID = crypto.randomBytes(8).toString('hex');
  fs.writeFileSync(idFile, SELF_ID);
}
const SELF_NAME = args.name || process.env.EZYSHARE_NAME || os.hostname().replace(/\.local$/, '');
const HTTP_PORT = args.port;

// Opt-in shared secret. Unset means the daemon behaves exactly as it always has:
// open to every ezyshare on the LAN. Set on every machine that should see each other.
function loadSecret() {
  if (args.secret) return args.secret;
  if (process.env.EZYSHARE_SECRET) return process.env.EZYSHARE_SECRET;
  try {
    const fromFile = fs.readFileSync(path.join(STATE_DIR, 'secret'), 'utf8').trim();
    if (fromFile) return fromFile;
  } catch { /* no secret file, stay open */ }
  return null;
}
const SECRET = loadSecret();

function hmac(canonical) {
  return crypto.createHmac('sha256', SECRET).update(canonical).digest('hex');
}

// Constant-time compare that tolerates a missing or wrong-length candidate.
function macEquals(expected, got) {
  if (typeof got !== 'string' || got.length !== expected.length) return false;
  return crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(got));
}

function fresh(ts) {
  return Number.isFinite(ts) && Math.abs(Date.now() - ts) <= CLOCK_SKEW_MS;
}

// A signed announce or POST is only good once, so a captured one cannot be replayed
// inside the skew window.
const usedNonces = new Map();
function nonceIsNew(nonce) {
  if (typeof nonce !== 'string' || nonce.length < 8 || nonce.length > 64) return false;
  if (usedNonces.has(nonce)) return false;
  usedNonces.set(nonce, Date.now() + CLOCK_SKEW_MS * 2);
  return true;
}
setInterval(() => {
  const now = Date.now();
  for (const [n, exp] of usedNonces) if (exp < now) usedNonces.delete(n);
}, CLOCK_SKEW_MS).unref();

const announceMac = (id, name, port, ts) => hmac(`hi|${id}|${name}|${port}|${ts}`);
const whoamiMac = (id, name, port, nonce) => hmac(`whoami|${id}|${name}|${port}|${nonce}`);
const inboxMac = (rawBody) => hmac(`inbox|${rawBody}`);

// ---------------------------------------------------------------- state

/** @type {Map<string, {id:string,name:string,addr:string,port:number,lastSeen:number,manual:boolean}>} */
const peers = new Map();

const inboxFile = path.join(STATE_DIR, 'inbox.json');
let items = [];
let seq = 0;
try {
  const saved = JSON.parse(fs.readFileSync(inboxFile, 'utf8'));
  if (Array.isArray(saved.items)) items = saved.items;
  seq = Number(saved.seq) || items.reduce((m, it) => Math.max(m, it.seq || 0), 0);
} catch { /* first run */ }

let waiters = [];

function wakeWaiters() {
  const w = waiters;
  waiters = [];
  for (const fn of w) fn();
}

let saveTimer = null;
function saveInbox() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    fs.writeFile(inboxFile, JSON.stringify({ seq, items }, null, 2), () => {});
  }, 200);
}

function addItem(item) {
  seq += 1;
  const full = { seq, id: crypto.randomBytes(6).toString('hex'), ts: Date.now(), read: false, ...item };
  full.seq = seq;
  items.push(full);
  if (items.length > MAX_ITEMS) items = items.slice(-MAX_ITEMS);
  saveInbox();
  wakeWaiters();
  return full;
}

// ---------------------------------------------------------------- discovery

function broadcastAddresses() {
  const out = new Set(['255.255.255.255']);
  for (const list of Object.values(os.networkInterfaces())) {
    for (const ni of list || []) {
      if (ni.family !== 'IPv4' || ni.internal || !ni.netmask) continue;
      const ip = ni.address.split('.').map(Number);
      const mask = ni.netmask.split('.').map(Number);
      out.add(ip.map((o, i) => (o | (~mask[i] & 255))).join('.'));
    }
  }
  return [...out];
}

const sock = dgram.createSocket({ type: 'udp4', reuseAddr: true });

function sendAnnounce(target) {
  const body = { t: 'hi', id: SELF_ID, name: SELF_NAME, port: HTTP_PORT };
  if (SECRET) {
    body.ts = Date.now();
    body.mac = announceMac(SELF_ID, SELF_NAME, HTTP_PORT, body.ts);
  }
  const msg = Buffer.from(JSON.stringify(body));
  const targets = target ? [target] : broadcastAddresses().map((a) => ({ address: a, port: args.dport }));
  for (const t of targets) {
    sock.send(msg, t.port, t.address, (err) => {
      if (err && process.env.EZYSHARE_DEBUG) console.error('announce failed', t.address, err.message);
    });
  }
}

const lastConflictLog = new Map();
function logConflict(name, pinned, seen) {
  const now = Date.now();
  if (now - (lastConflictLog.get(name) || 0) < CONFLICT_LOG_MS) return;
  lastConflictLog.set(name, now);
  console.error(`! ${name} is pinned to ${pinned} but ${seen} is claiming it - ignoring`);
}

// A peer that is still announcing from its pinned address cannot be moved by a packet
// arriving from anywhere else; that packet is how the link-theft hijack starts. When a
// secret is configured we can safely let a peer move sooner, but only after it answers a
// nonce challenge on the new address - a valid MAC alone would let a captured announce be
// replayed from the attacker's address.
const rebinding = new Set();

async function considerRebind(existing, msg, rinfo) {
  if (Date.now() - existing.lastSeen < PEER_TTL_MS) {
    logConflict(existing.name, `${existing.addr}:${existing.port}`, `${rinfo.address}:${Number(msg.port) || HTTP_PORT_DEFAULT}`);
    return;
  }
  if (!SECRET) return; // stale entry: the TTL sweeper drops it and normal discovery re-adds it
  const key = `${msg.id}@${rinfo.address}`;
  if (rebinding.has(key)) return;
  rebinding.add(key);
  try {
    const port = Number(msg.port) || HTTP_PORT_DEFAULT;
    const who = await probeWhoami(rinfo.address, port);
    if (!who || who.id !== msg.id) return;
    peers.set(msg.id, {
      id: msg.id,
      name: String(who.name || msg.name || 'unknown').slice(0, 64),
      addr: rinfo.address,
      port,
      lastSeen: Date.now(),
      manual: false,
    });
    console.log(`~ ${who.name} moved to ${rinfo.address}`);
  } catch { /* new address did not verify, keep the pin */ }
  finally { rebinding.delete(key); }
}

sock.on('message', (buf, rinfo) => {
  let msg;
  try { msg = JSON.parse(buf.toString()); } catch { return; }
  if (msg.t !== 'hi' || !msg.id || msg.id === SELF_ID) return;
  // With a secret set, an unsigned or stale announce is not a peer we know.
  if (SECRET) {
    if (!fresh(Number(msg.ts))) return;
    if (!macEquals(announceMac(msg.id, String(msg.name || ''), Number(msg.port) || HTTP_PORT_DEFAULT, msg.ts), msg.mac)) return;
    if (!nonceIsNew(`hi:${msg.id}:${msg.ts}:${msg.mac.slice(0, 16)}`)) return;
  }
  const port = Number(msg.port) || HTTP_PORT_DEFAULT;
  const existing = peers.get(msg.id);
  // Address AND port are pinned together: both pick where a link gets delivered, so
  // moving either one is a redirect and has to be treated the same way.
  if (existing && !existing.manual && (existing.addr !== rinfo.address || existing.port !== port)) {
    considerRebind(existing, msg, rinfo);
    return;
  }
  const known = peers.has(msg.id);
  peers.set(msg.id, {
    id: msg.id,
    name: String(msg.name || 'unknown').slice(0, 64),
    addr: rinfo.address,
    port,
    lastSeen: Date.now(),
    manual: existing ? existing.manual : false,
  });
  // Reply straight away so a machine that just joined shows up instantly on both sides.
  if (!known) {
    console.log(`+ ${msg.name} (${rinfo.address})`);
    sendAnnounce({ address: rinfo.address, port: args.dport });
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

// Ask a host to prove which daemon it is. The nonce is ours, so a recorded reply from
// some other exchange cannot be replayed back at us.
async function probeWhoami(host, port) {
  const nonce = crypto.randomBytes(16).toString('hex');
  const res = await fetch(`http://${host}:${port}/whoami?nonce=${nonce}`, { signal: AbortSignal.timeout(2000) });
  const who = await res.json();
  if (!who || typeof who.id !== 'string') return null;
  if (SECRET && !macEquals(whoamiMac(who.id, String(who.name || ''), Number(who.port) || port, nonce), who.mac)) return null;
  return who;
}

// Manual peers: for networks where UDP broadcast is blocked (some office / guest wifi).
async function probeManualPeers() {
  for (const spec of args.peers) {
    const [host, portStr] = spec.split(':');
    const port = Number(portStr) || HTTP_PORT_DEFAULT;
    try {
      const who = await probeWhoami(host, port);
      if (!who || who.id === SELF_ID) continue;
      peers.set(who.id, { id: who.id, name: who.name, addr: host, port, lastSeen: Date.now(), manual: true });
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

// Returns the raw text as well as the parsed object: /inbox has to authenticate the exact
// bytes it received, not a re-serialisation of them.
function readBody(req, limit = 64 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) { reject(new Error('body too large')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => {
      const raw = chunks.length ? Buffer.concat(chunks).toString() : '';
      try { resolve({ data: raw ? JSON.parse(raw) : {}, raw }); }
      catch (e) { reject(e); }
    });
    req.on('error', reject);
  });
}

function remoteIp(req) {
  return (req.socket.remoteAddress || '').replace(/^::ffff:/, '');
}

function isLoopback(req) {
  const ip = remoteIp(req);
  return ip === '127.0.0.1' || ip === '::1';
}

function safeUrl(raw) {
  try {
    const u = new URL(String(raw));
    return (u.protocol === 'http:' || u.protocol === 'https:') ? u.href : null;
  } catch { return null; }
}

function peerList() {
  return [...peers.values()]
    .map(({ id, name, addr, port, lastSeen }) => ({ id, name, addr, port, lastSeen }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

// The extension is the only thing allowed to touch /api/*. Two gates:
//   1. request must come from loopback
//   2. Origin must be a chrome-extension:// one, and a custom header is required,
//      which forces a CORS preflight so a random web page cannot forge the call.
function guardApi(req, res) {
  if (!isLoopback(req)) { json(res, 403, { error: 'loopback only' }); return false; }
  const origin = req.headers.origin;
  if (origin && !origin.startsWith('chrome-extension://')) { json(res, 403, { error: 'bad origin' }); return false; }
  if (origin) {
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

// Who really sent this link? Only the discovery table can answer that. The POST body says
// whatever the sender wants it to say, so its fromName is never used.
function senderFor(fromId, ip) {
  const byId = peers.get(fromId);
  if (byId && byId.addr === ip) return byId;
  return [...peers.values()].find((p) => p.addr === ip) || null;
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  const route = url.pathname;

  // ---- LAN surface -------------------------------------------------
  if (route === '/whoami' && req.method === 'GET') {
    const body = { id: SELF_ID, name: SELF_NAME, port: HTTP_PORT };
    const nonce = url.searchParams.get('nonce');
    if (SECRET && nonce) body.mac = whoamiMac(SELF_ID, SELF_NAME, HTTP_PORT, nonce);
    return json(res, 200, body);
  }

  if (route === '/inbox' && req.method === 'POST') {
    let body;
    let raw;
    try { ({ data: body, raw } = await readBody(req)); } catch { return json(res, 400, { error: 'bad body' }); }
    if (SECRET) {
      if (!fresh(Number(body.ts))) return json(res, 401, { error: 'stale or unsigned request' });
      if (!macEquals(inboxMac(raw), req.headers['x-ezyshare-mac'])) return json(res, 401, { error: 'bad signature' });
      if (!nonceIsNew(String(body.nonce || ''))) return json(res, 401, { error: 'replayed request' });
    }
    const link = safeUrl(body.url);
    if (!link) return json(res, 400, { error: 'url must be http or https' });
    const ip = remoteIp(req);
    const sender = senderFor(body.fromId, ip);
    const item = addItem({
      fromId: String(body.fromId || 'unknown').slice(0, 64),
      fromName: sender ? sender.name : `unknown (${ip})`,
      url: link,
      title: String(body.title || '').slice(0, 200),
    });
    console.log(`  in  ${item.fromName}: ${item.url}`);
    return json(res, 200, { ok: true });
  }

  // ---- extension surface -------------------------------------------
  if (!route.startsWith('/api/')) return json(res, 404, { error: 'not found' });
  if (!guardApi(req, res)) return;

  if (route === '/api/me') {
    return json(res, 200, { id: SELF_ID, name: SELF_NAME, port: HTTP_PORT, seq });
  }

  if (route === '/api/peers') {
    return json(res, 200, { me: { id: SELF_ID, name: SELF_NAME }, peers: peerList() });
  }

  if (route === '/api/send' && req.method === 'POST') {
    let body;
    try { ({ data: body } = await readBody(req)); } catch { return json(res, 400, { error: 'bad body' }); }
    const peer = peers.get(body.peerId);
    if (!peer) return json(res, 404, { error: 'peer not found' });
    const link = safeUrl(body.url);
    if (!link) return json(res, 400, { error: 'url must be http or https' });
    const payload = { fromId: SELF_ID, fromName: SELF_NAME, url: link, title: body.title || '' };
    if (SECRET) {
      payload.ts = Date.now();
      payload.nonce = crypto.randomBytes(16).toString('hex');
    }
    const rawOut = JSON.stringify(payload);
    const headers = { 'content-type': 'application/json' };
    if (SECRET) headers['x-ezyshare-mac'] = inboxMac(rawOut);
    try {
      const r = await fetch(`http://${peer.addr}:${peer.port}/inbox`, {
        method: 'POST',
        headers,
        body: rawOut,
        signal: AbortSignal.timeout(5000),
      });
      if (!r.ok) return json(res, 502, { error: `peer replied ${r.status}` });
    } catch (e) {
      return json(res, 502, { error: `could not reach ${peer.name}: ${e.message}` });
    }
    console.log(`  out ${peer.name}: ${link}`);
    return json(res, 200, { ok: true, to: peer.name });
  }

  // Long poll: returns as soon as something newer than `since` lands, or after `wait` ms.
  if (route === '/api/inbox') {
    const since = Number(url.searchParams.get('since') || 0);
    const wait = Math.min(Number(url.searchParams.get('wait') || 25000), 60000);
    const fresh = () => items.filter((it) => it.seq > since);

    const reply = () => json(res, 200, { seq, items: fresh() });
    if (fresh().length) return reply();

    let done = false;
    const finish = () => { if (done) return; done = true; clearTimeout(timer); reply(); };
    const timer = setTimeout(finish, wait);
    waiters.push(finish);
    req.on('close', () => { done = true; clearTimeout(timer); });
    return;
  }

  if (route === '/api/inbox/read' && req.method === 'POST') {
    let body;
    try { ({ data: body } = await readBody(req)); } catch { return json(res, 400, { error: 'bad body' }); }
    const ids = new Set(Array.isArray(body.ids) ? body.ids : []);
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
  const ips = Object.values(os.networkInterfaces()).flat()
    .filter((ni) => ni && ni.family === 'IPv4' && !ni.internal).map((ni) => ni.address);
  console.log(`ezyshare  "${SELF_NAME}"  id=${SELF_ID}`);
  console.log(`  http    ${ips.map((ip) => `http://${ip}:${HTTP_PORT}`).join('  ')}`);
  console.log(`  api     http://127.0.0.1:${HTTP_PORT}/api  (extension only)`);
  console.log(`  udp     broadcast on ${args.dport}`);
  if (SECRET) console.log('  secret  on - only daemons sharing this secret can see you or send to you');
  else console.log('  secret  off - anyone on this network can send you a link (--secret to lock it down)');
  console.log('waiting for peers...');
});

for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => { console.log('\nbye'); process.exit(0); });
}
