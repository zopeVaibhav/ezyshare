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

function flash(card, cls, text) {
  const sub = card.querySelector('.sub');
  const original = sub.textContent;
  card.classList.add(cls);
  sub.textContent = text;
  setTimeout(() => { card.classList.remove(cls); sub.textContent = original; }, 1600);
}

async function deliver(card, peer, url, title) {
  if (!url) { flash(card, 'failed', 'no link in that drop'); return; }
  try {
    await sendLink(peer.id, url, title || '');
    flash(card, 'sent', 'sent');
  } catch (err) {
    flash(card, 'failed', String(err.message || err).slice(0, 40));
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

function peerCard(peer) {
  const li = document.createElement('li');
  li.className = 'peer';
  li.innerHTML = `
    <span class="avatar"></span>
    <span class="col"><span class="name"></span><span class="sub"></span></span>`;
  li.querySelector('.avatar').textContent = initials(peer.name);
  li.querySelector('.name').textContent = peer.name;
  li.querySelector('.sub').textContent = peer.addr;

  li.addEventListener('dragenter', (e) => { e.preventDefault(); li.classList.add('over'); });
  li.addEventListener('dragover', (e) => { e.preventDefault(); e.dataTransfer.dropEffect = 'copy'; li.classList.add('over'); });
  li.addEventListener('dragleave', () => li.classList.remove('over'));
  li.addEventListener('drop', (e) => {
    e.preventDefault();
    li.classList.remove('over');
    deliver(li, peer, urlFromDrop(e.dataTransfer), e.dataTransfer.getData('text/plain'));
  });

  li.addEventListener('click', async () => {
    const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
    if (!tab?.url) return;
    deliver(li, peer, tab.url, tab.title);
  });

  return li;
}

function renderPeers(list) {
  peers = list;
  el('peers').replaceChildren(...list.map(peerCard));
  el('nopeers').hidden = list.length > 0;
}

function renderInbox(items) {
  const recent = [...items].reverse().slice(0, 25);
  el('inbox').replaceChildren(...recent.map((it) => {
    const li = document.createElement('li');
    const unverified = it.verified === false;
    li.className = `item${it.read ? '' : ' unread'}${unverified ? ' unverified' : ''}`;
    const a = document.createElement('a');
    a.href = it.url;
    a.target = '_blank';
    a.textContent = it.title || it.url;
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
    renderPeers(peerData.peers);
    renderInbox(inboxData.items);
  } catch (err) {
    el('offline').hidden = false;
    el('main').hidden = true;
    el('paused').hidden = true;
    el('toggle').checked = false;
    el('toggle').disabled = true;
    el('dot').classList.remove('on');
    el('myname').textContent = 'offline';
    el('errline').textContent = String(err.message || err);
  }
}

el('toggle').addEventListener('change', async (e) => {
  const wanted = e.target.checked;
  toggleBusy = true;
  try {
    await api('/api/state', { method: 'POST', body: JSON.stringify({ enabled: wanted }) });
    chrome.runtime.sendMessage({ type: 'ezyshare:refresh' });
  } catch {
    e.target.checked = !wanted;
  } finally {
    toggleBusy = false;
    tick();
  }
});

el('refresh').addEventListener('click', () => { chrome.runtime.sendMessage({ type: 'ezyshare:refresh' }); tick(); });
el('clear').addEventListener('click', async () => {
  await api('/api/inbox/clear', { method: 'POST' }).catch(() => {});
  chrome.runtime.sendMessage({ type: 'ezyshare:refresh' });
  tick();
});

// The whole panel accepts a drop too, so a sloppy aim still lands somewhere useful.
document.addEventListener('dragover', (e) => e.preventDefault());
document.addEventListener('drop', (e) => e.preventDefault());

tick();
setInterval(tick, 2000);
