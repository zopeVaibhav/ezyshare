import { api, sendLink } from './shared.js';

const el = (id) => document.getElementById(id);
let peers = [];

function initials(name) {
  return name.split(/[\s\-_.]+/).filter(Boolean).slice(0, 2).map((w) => w[0].toUpperCase()).join('') || '?';
}

function ago(ts) {
  const s = Math.round((Date.now() - ts) / 1000);
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.round(s / 60)}m ago`;
  if (s < 86400) return `${Math.round(s / 3600)}h ago`;
  return `${Math.round(s / 86400)}d ago`;
}

// Screen readers get told what happened; the card colour alone does not reach them.
function announce(text) {
  el('live').textContent = text;
}

function flash(card, cls, text) {
  const sub = card.querySelector('.sub');
  const original = card.dataset.sub ?? sub.textContent;
  card.dataset.flashing = '1';
  card.classList.add(cls);
  sub.textContent = text;
  clearTimeout(Number(card.dataset.flashTimer));
  card.dataset.flashTimer = String(setTimeout(() => {
    card.classList.remove(cls);
    sub.textContent = original;
    delete card.dataset.flashing;
  }, 1600));
}

async function deliver(card, peer, url, title) {
  if (!url) { flash(card, 'failed', 'no link in that drop'); announce('No link in that drop'); return; }
  try {
    await sendLink(peer.id, url, title || '');
    flash(card, 'sent', 'sent');
    announce(`Sent to ${peer.name}`);
  } catch (err) {
    const reason = String(err.message || err);
    flash(card, 'failed', reason.slice(0, 40));
    announce(`Could not send to ${peer.name}: ${reason}`);
  }
}

function urlFromDrop(dt) {
  const uriList = dt.getData('text/uri-list');
  if (uriList) {
    const first = uriList.split('\n').map((l) => l.trim()).find((l) => l && !l.startsWith('#'));
    if (first) return first;
  }
  const text = (dt.getData('text/plain') || '').trim();
  if (/^https?:\/\//i.test(text)) return text;
  const html = dt.getData('text/html');
  const match = html && html.match(/href\s*=\s*["'](https?:\/\/[^"']+)["']/i);
  return match ? match[1] : null;
}

async function sendCurrentTab(card, peer) {
  const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  if (!tab?.url) return;
  deliver(card, peer, tab.url, tab.title);
}

function peerCard(peer) {
  const li = document.createElement('li');
  li.className = 'peer';
  // A card is an activatable control, so it has to be reachable and operable from the
  // keyboard, not only by mouse and drag.
  li.tabIndex = 0;
  li.setAttribute('role', 'button');
  li.dataset.id = peer.id;
  li.innerHTML = `
    <span class="avatar" aria-hidden="true"></span>
    <span class="col"><span class="name"></span><span class="sub"></span></span>`;
  li.querySelector('.avatar').textContent = initials(peer.name);
  li.querySelector('.name').textContent = peer.name;
  li.querySelector('.sub').textContent = peer.addr;
  li.dataset.sub = peer.addr;
  li.setAttribute('aria-label', `Send current tab to ${peer.name} at ${peer.addr}`);

  li.addEventListener('dragenter', (e) => { e.preventDefault(); li.classList.add('over'); });
  li.addEventListener('dragover', (e) => { e.preventDefault(); e.dataTransfer.dropEffect = 'copy'; li.classList.add('over'); });
  li.addEventListener('dragleave', () => li.classList.remove('over'));
  li.addEventListener('drop', (e) => {
    e.preventDefault();
    li.classList.remove('over');
    deliver(li, peer, urlFromDrop(e.dataTransfer), e.dataTransfer.getData('text/plain'));
  });

  li.addEventListener('click', () => sendCurrentTab(li, peer));
  li.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter' && e.key !== ' ') return;
    e.preventDefault(); // Space would otherwise scroll the panel
    sendCurrentTab(li, peer);
  });

  return li;
}

// Rebuilding every card on each poll would throw away the "sent" flash mid-animation and
// drop the drag state under the cursor, so only rebuild when the list actually changes.
function peerSignature(list) {
  return list.map((p) => `${p.id}:${p.name}:${p.addr}:${p.port}`).join('|');
}

let renderedSignature = null;

function renderPeers(list) {
  peers = list;
  const signature = peerSignature(list);
  if (signature !== renderedSignature) {
    renderedSignature = signature;
    el('peers').replaceChildren(...list.map(peerCard));
  }
  el('nopeers').hidden = list.length > 0;
}

function renderInbox(items) {
  const recent = [...items].reverse().slice(0, 25);
  el('inbox').replaceChildren(...recent.map((it) => {
    const li = document.createElement('li');
    const unverified = it.verified !== true;
    li.className = `item${it.read ? '' : ' unread'}${unverified ? ' unverified' : ''}`;
    const a = document.createElement('a');
    a.href = it.url;
    a.target = '_blank';
    a.rel = 'noopener noreferrer';
    a.textContent = it.title || it.url;
    a.title = it.url;
    a.addEventListener('click', () => {
      api('/api/inbox/read', { method: 'POST', body: JSON.stringify({ ids: [it.id] }) }).catch(() => {});
      chrome.runtime.sendMessage({ type: 'ezyshare:refresh' });
    });
    const sub = document.createElement('span');
    sub.className = 'sub';
    sub.textContent = unverified
      ? `${it.fromName} · not a known peer · ${ago(it.ts)}`
      : `${it.fromName} · ${ago(it.ts)}`;
    li.append(a, sub);
    return li;
  }));
  el('noinbox').hidden = recent.length > 0;

  const unread = recent.filter((it) => !it.read).length;
  const badge = el('unread');
  badge.hidden = unread === 0;
  badge.textContent = String(unread);
  badge.setAttribute('aria-label', `${unread} unread`);
}

// Whether a shared secret is in force is the difference between "anyone here can reach me"
// and "only my machines can", so it belongs on screen rather than only in the daemon log.
function renderLock(secured) {
  const chip = el('lock');
  chip.hidden = false;
  chip.classList.toggle('locked', secured);
  chip.textContent = secured ? 'locked' : 'open';
  chip.title = secured
    ? 'A shared secret is set. Only daemons with the same secret can see you or send to you.'
    : 'No shared secret. Any ezyshare on this network can send you a link. Start the daemon with --secret to lock it down.';
}

let toggleBusy = false;

async function tick() {
  try {
    const [peerData, inboxData] = await Promise.all([
      api('/api/peers'),
      api('/api/inbox?since=0&wait=0'),
    ]);
    const enabled = peerData.enabled !== false;
    el('offline').hidden = true;
    el('paused').hidden = enabled;
    el('main').hidden = !enabled;
    el('toggle').disabled = false;
    if (!toggleBusy) el('toggle').checked = enabled;
    el('dot').classList.toggle('on', enabled);
    el('myname').textContent = enabled ? peerData.me.name : `${peerData.me.name} · hidden`;
    renderLock(peerData.secured === true);
    renderPeers(peerData.peers);
    renderInbox(inboxData.items);
  } catch (err) {
    el('offline').hidden = false;
    el('main').hidden = true;
    el('paused').hidden = true;
    el('lock').hidden = true;
    el('toggle').checked = false;
    el('toggle').disabled = true;
    el('dot').classList.remove('on');
    el('myname').textContent = 'offline';
    el('errline').textContent = String(err.message || err);
    renderedSignature = null; // force a fresh list once the daemon is back
  }
}

el('toggle').addEventListener('change', async (e) => {
  const wanted = e.target.checked;
  toggleBusy = true;
  try {
    await api('/api/state', { method: 'POST', body: JSON.stringify({ enabled: wanted }) });
    chrome.runtime.sendMessage({ type: 'ezyshare:refresh' });
    announce(wanted ? 'Sharing on' : 'Sharing off');
  } catch {
    e.target.checked = !wanted;
    announce('Could not change sharing');
  } finally {
    toggleBusy = false;
    tick();
  }
});

el('refresh').addEventListener('click', () => { chrome.runtime.sendMessage({ type: 'ezyshare:refresh' }); tick(); });
el('clear').addEventListener('click', async () => {
  await api('/api/inbox/clear', { method: 'POST' }).catch(() => {});
  chrome.runtime.sendMessage({ type: 'ezyshare:refresh' });
  announce('Received list cleared');
  tick();
});

// The whole panel accepts a drop too, so a sloppy aim still lands somewhere useful.
document.addEventListener('dragover', (e) => e.preventDefault());
document.addEventListener('drop', (e) => e.preventDefault());

tick();
setInterval(tick, 2000);
