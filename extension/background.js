import { api, sendLink } from './shared.js';

const NOTIF_PREFIX = 'ezyshare:';
const ALARM = 'ezyshare-pump';
const MENU_ROOT = 'ezyshare-root';

// ---------------------------------------------------------------- inbox

let pumping = false;

async function pump() {
  if (pumping) return;
  pumping = true;
  try {
    // Long poll forever. Chrome eventually kills the worker; the alarm below revives it.
    for (;;) {
      const { seq = 0 } = await chrome.storage.local.get('seq');
      const data = await api(`/api/inbox?since=${seq}&wait=25000`);
      await chrome.storage.local.set({ seq: data.seq, online: true });
      for (const item of data.items) await notify(item);
      await refreshBadge();
      await refreshMenus();
    }
  } catch (err) {
    await chrome.storage.local.set({ online: false, lastError: String(err.message || err) });
    await chrome.action.setBadgeText({ text: '!' });
    await chrome.action.setBadgeBackgroundColor({ color: '#b4392c' });
  } finally {
    pumping = false;
  }
}

async function notify(item) {
  const id = NOTIF_PREFIX + item.id;
  const links = (await chrome.storage.session.get('links')).links || {};
  links[id] = item.url;
  await chrome.storage.session.set({ links });

  let label = item.title;
  if (!label) {
    try { label = new URL(item.url).hostname + new URL(item.url).pathname; } catch { label = item.url; }
  }

  chrome.notifications.create(id, {
    type: 'basic',
    iconUrl: chrome.runtime.getURL('icons/icon128.png'),
    title: `${item.fromName} sent you a link`,
    message: label,
    contextMessage: item.url.slice(0, 120),
    buttons: [{ title: 'Open' }],
    requireInteraction: true,
    priority: 2,
  });
}

async function openFromNotification(notificationId) {
  const links = (await chrome.storage.session.get('links')).links || {};
  const url = links[notificationId];
  if (url) {
    await chrome.tabs.create({ url });
    delete links[notificationId];
    await chrome.storage.session.set({ links });
  }
  chrome.notifications.clear(notificationId);
  const itemId = notificationId.slice(NOTIF_PREFIX.length);
  try { await api('/api/inbox/read', { method: 'POST', body: JSON.stringify({ ids: [itemId] }) }); } catch { /* offline */ }
  refreshBadge();
}

chrome.notifications.onClicked.addListener(openFromNotification);
chrome.notifications.onButtonClicked.addListener((id) => openFromNotification(id));

async function refreshBadge() {
  try {
    const data = await api('/api/inbox?since=0&wait=0');
    const unread = data.items.filter((it) => !it.read).length;
    await chrome.action.setBadgeText({ text: unread ? String(unread) : '' });
    await chrome.action.setBadgeBackgroundColor({ color: '#2f7d4f' });
  } catch { /* daemon down, pump() already flagged it */ }
}

// ---------------------------------------------------------------- right-click menu

let menuSignature = '';

async function refreshMenus() {
  let peers = [];
  try { peers = (await api('/api/peers')).peers; } catch { /* daemon down */ }
  const signature = peers.map((p) => `${p.id}:${p.name}`).join('|');
  if (signature === menuSignature) return;
  menuSignature = signature;

  await chrome.contextMenus.removeAll();
  chrome.contextMenus.create({
    id: MENU_ROOT,
    title: peers.length ? 'ezyshare to…' : 'ezyshare (no one online)',
    contexts: ['link', 'page', 'selection'],
    enabled: peers.length > 0,
  });
  for (const p of peers) {
    chrome.contextMenus.create({
      id: `${MENU_ROOT}:${p.id}`,
      parentId: MENU_ROOT,
      title: p.name,
      contexts: ['link', 'page', 'selection'],
    });
  }
}

chrome.contextMenus.onClicked.addListener(async (info, tab) => {
  if (!info.menuItemId.startsWith(`${MENU_ROOT}:`)) return;
  const peerId = info.menuItemId.slice(MENU_ROOT.length + 1);
  const url = info.linkUrl || info.pageUrl || tab?.url;
  const title = info.linkUrl ? (info.selectionText || '') : (tab?.title || '');
  try {
    const res = await sendLink(peerId, url, title);
    toast(`Sent to ${res.to}`, url);
  } catch (err) {
    toast('Send failed', String(err.message || err));
  }
});

function toast(title, message) {
  chrome.notifications.create(`ezyshare-status:${Date.now()}`, {
    type: 'basic',
    iconUrl: chrome.runtime.getURL('icons/icon128.png'),
    title,
    message: String(message).slice(0, 200),
    priority: 0,
  });
}

// ---------------------------------------------------------------- lifecycle

async function boot() {
  chrome.alarms.create(ALARM, { periodInMinutes: 0.5 });
  // First run: start from the daemon's current position so a backlog of old
  // links does not arrive as a wall of notifications.
  const stored = await chrome.storage.local.get('seq');
  if (stored.seq === undefined) {
    try { await chrome.storage.local.set({ seq: (await api('/api/me')).seq }); }
    catch { await chrome.storage.local.set({ seq: 0 }); }
  }
  chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(() => {});
  pump();
  refreshMenus();
}

chrome.runtime.onStartup.addListener(boot);
chrome.runtime.onInstalled.addListener(boot);
chrome.alarms.onAlarm.addListener((alarm) => { if (alarm.name === ALARM) { pump(); refreshMenus(); } });
chrome.runtime.onMessage.addListener((msg) => {
  if (msg?.type === 'ezyshare:refresh') { pump(); refreshMenus(); refreshBadge(); }
});

boot();
