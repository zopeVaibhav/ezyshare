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

// ---------------------------------------------------------------- args

function parseArgs(argv) {
  const out = { name: null, port: HTTP_PORT_DEFAULT, dport: DISCOVERY_PORT_DEFAULT, peers: [], dir: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = () => argv[++i];
    if (a === '--name' || a === '-n') out.name = next();
    else if (a === '--port' || a === '-p') out.port = Number(next());
    else if (a === '--discovery-port') out.dport = Number(next());
    else if (a === '--peer') out.peers.push(next());
    else if (a === '--dir') out.dir = next();
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
  const msg = Buffer.from(JSON.stringify({
    t: 'hi', id: SELF_ID, name: SELF_NAME, port: HTTP_PORT,
  }));
  const targets = target ? [target] : broadcastAddresses().map((a) => ({ address: a, port: args.dport }));
  for (const t of targets) {
    sock.send(msg, t.port, t.address, (err) => {
      if (err && process.env.EZYSHARE_DEBUG) console.error('announce failed', t.address, err.message);
    });
  }
}

sock.on('message', (buf, rinfo) => {
  let msg;
  try { msg = JSON.parse(buf.toString()); } catch { return; }
  if (msg.t !== 'hi' || !msg.id || msg.id === SELF_ID) return;
  const known = peers.has(msg.id);
  peers.set(msg.id, {
    id: msg.id,
    name: String(msg.name || 'unknown').slice(0, 64),
    addr: rinfo.address,
    port: Number(msg.port) || HTTP_PORT_DEFAULT,
    lastSeen: Date.now(),
    manual: false,
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

// Manual peers: for networks where UDP broadcast is blocked (some office / guest wifi).
async function probeManualPeers() {
  for (const spec of args.peers) {
    const [host, portStr] = spec.split(':');
    const port = Number(portStr) || HTTP_PORT_DEFAULT;
    try {
      const res = await fetch(`http://${host}:${port}/whoami`, { signal: AbortSignal.timeout(2000) });
      const who = await res.json();
      if (who.id === SELF_ID) continue;
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
      try { resolve(chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) : {}); }
      catch (e) { reject(e); }
    });
    req.on('error', reject);
  });
}

function isLoopback(req) {
  const ip = (req.socket.remoteAddress || '').replace(/^::ffff:/, '');
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

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  const route = url.pathname;

  // ---- LAN surface -------------------------------------------------
  if (route === '/whoami' && req.method === 'GET') {
    return json(res, 200, { id: SELF_ID, name: SELF_NAME, port: HTTP_PORT });
  }

  if (route === '/inbox' && req.method === 'POST') {
    let body;
    try { body = await readBody(req); } catch { return json(res, 400, { error: 'bad body' }); }
    const link = safeUrl(body.url);
    if (!link) return json(res, 400, { error: 'url must be http or https' });
    const sender = peers.get(body.fromId);
    const item = addItem({
      fromId: String(body.fromId || 'unknown').slice(0, 64),
      fromName: (sender?.name || String(body.fromName || 'someone')).slice(0, 64),
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
    try { body = await readBody(req); } catch { return json(res, 400, { error: 'bad body' }); }
    const peer = peers.get(body.peerId);
    if (!peer) return json(res, 404, { error: 'peer not found' });
    const link = safeUrl(body.url);
    if (!link) return json(res, 400, { error: 'url must be http or https' });
    try {
      const r = await fetch(`http://${peer.addr}:${peer.port}/inbox`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ fromId: SELF_ID, fromName: SELF_NAME, url: link, title: body.title || '' }),
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
    try { body = await readBody(req); } catch { return json(res, 400, { error: 'bad body' }); }
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
  console.log('waiting for peers...');
});

for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => { console.log('\nbye'); process.exit(0); });
}
