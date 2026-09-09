import { api, sendLink } from "./shared.js";

const NOTIF_PREFIX = "ezyshare:";
const ALARM = "ezyshare-pump";
const MENU_ROOT = "ezyshare-root";
const MAX_TRACKED_LINKS = 50;
const BATCH_NOTIFY_LIMIT = 3;

let pumping = false;

async function pump() {
    if (pumping) return;
    pumping = true;
    try {
        for (;;) {
            const { seq = 0 } = await chrome.storage.local.get("seq");
            const data = await api(`/api/inbox?since=${seq}&wait=25000`);

            /*
              The daemon's counter only climbs. A lower one means its state was reset, and without
              this the extension would sit at the old high-water mark and silently stop delivering.
            */
            if (data.seq < seq) {
                await chrome.storage.local.set({ seq: 0 });
                continue;
            }

            await chrome.storage.local.set({ seq: data.seq, online: true });
            await deliver(data.items);
            await refreshBadge();
            await refreshMenus();
        }
    } catch (err) {
        await chrome.storage.local.set({ online: false, lastError: String(err.message || err) });
        await chrome.action.setBadgeText({ text: "!" });
        await chrome.action.setBadgeBackgroundColor({ color: "#b4392c" });
    } finally {
        pumping = false;
    }
}

async function deliver(newItems) {
    if (!newItems.length) return;
    /*
      A flood from one machine must not become a wall of notifications.
    */
    if (newItems.length > BATCH_NOTIFY_LIMIT) {
        const senders = [...new Set(newItems.map((it) => it.fromName))];
        chrome.notifications.create(`${NOTIF_PREFIX}batch:${Date.now()}`, {
            type: "basic",
            iconUrl: chrome.runtime.getURL("icons/icon128.png"),
            title: `${newItems.length} links received`,
            message: `from ${senders.slice(0, 3).join(", ")}. Open the ezyshare panel to read them.`,
            priority: 1,
        });
        return;
    }
    for (const item of newItems) {
        try {
            await notify(item);
        } catch {
            /* keep going */
        }
    }
}

async function notify(item) {
    const id = NOTIF_PREFIX + item.id;
    const stored = (await chrome.storage.session.get("links")).links || {};
    const entries = Object.entries(stored).slice(-(MAX_TRACKED_LINKS - 1));
    const links = Object.fromEntries([...entries, [id, item.url]]);
    await chrome.storage.session.set({ links });

    let label = item.title;
    if (!label) {
        try {
            const u = new URL(item.url);
            label = u.hostname + u.pathname;
        } catch {
            label = item.url;
        }
    }

    chrome.notifications.create(id, {
        type: "basic",
        iconUrl: chrome.runtime.getURL("icons/icon128.png"),
        title:
            item.verified !== true
                ? `Unverified sender (${item.fromName})`
                : `${item.fromName} sent you a link`,
        message: label,
        contextMessage: item.url.slice(0, 120),
        buttons: [{ title: "Open" }],
        priority: 2,
    });
}

async function openFromNotification(notificationId) {
    /*
      Three id shapes reach this handler and only per-item ones carry a link. A batch
      summary or a send-status toast must not slice a bogus id and post it back.
    */
    if (!notificationId.startsWith(NOTIF_PREFIX)) {
        chrome.notifications.clear(notificationId);
        return;
    }
    if (notificationId.startsWith(`${NOTIF_PREFIX}batch:`)) {
        chrome.notifications.clear(notificationId);
        try {
            await api("/api/inbox/read", { method: "POST", body: JSON.stringify({ all: true }) });
        } catch {
            /* offline */
        }
        refreshBadge();
        return;
    }
    const links = (await chrome.storage.session.get("links")).links || {};
    const url = links[notificationId];
    if (url) {
        await chrome.tabs.create({ url });
        delete links[notificationId];
        await chrome.storage.session.set({ links });
    }
    chrome.notifications.clear(notificationId);
    const itemId = notificationId.slice(NOTIF_PREFIX.length);
    try {
        await api("/api/inbox/read", { method: "POST", body: JSON.stringify({ ids: [itemId] }) });
    } catch {
        /* offline */
    }
    refreshBadge();
}

chrome.notifications.onClicked.addListener(openFromNotification);
chrome.notifications.onButtonClicked.addListener((id) => openFromNotification(id));

async function refreshBadge() {
    try {
        const data = await api("/api/inbox?since=0&wait=0");
        const unread = data.items.filter((it) => !it.read).length;
        await chrome.action.setBadgeText({ text: unread ? String(unread) : "" });
        await chrome.action.setBadgeBackgroundColor({ color: "#2f7d4f" });
    } catch {
        /* daemon down, pump() already flagged it */
    }
}

/*
  null, not empty string: after a worker restart the menus may already exist in Chrome
  even though this variable is fresh, so the first refresh must always rebuild.
*/
let menuSignature = null;

async function refreshMenus() {
    let peers = [];
    let enabled;
    try {
        const data = await api("/api/peers");
        peers = data.peers;
        enabled = data.enabled !== false;
    } catch {
        enabled = false;
    }

    const signature = `${enabled}|${peers.map((p) => `${p.id}:${p.name}`).join("|")}`;
    if (signature === menuSignature) return;
    menuSignature = signature;

    await chrome.contextMenus.removeAll();
    chrome.contextMenus.create({
        id: MENU_ROOT,
        title: !enabled
            ? "ezyshare (sharing off)"
            : peers.length
              ? "ezyshare to…"
              : "ezyshare (no one online)",
        contexts: ["link", "page", "selection"],
        enabled: enabled && peers.length > 0,
    });
    for (const p of peers) {
        chrome.contextMenus.create({
            id: `${MENU_ROOT}:${p.id}`,
            parentId: MENU_ROOT,
            title: p.name,
            contexts: ["link", "page", "selection"],
        });
    }
}

chrome.contextMenus.onClicked.addListener(async (info, tab) => {
    if (!String(info.menuItemId).startsWith(`${MENU_ROOT}:`)) return;
    const peerId = String(info.menuItemId).slice(MENU_ROOT.length + 1);
    const url = info.linkUrl || info.pageUrl || tab?.url;
    const title = info.linkUrl ? info.selectionText || "" : tab?.title || "";
    try {
        const res = await sendLink(peerId, url, title);
        toast(`Sent to ${res.to}`, url);
    } catch (err) {
        toast("Send failed", String(err.message || err));
    }
});

function toast(title, message) {
    chrome.notifications.create(`ezyshare-status:${Date.now()}`, {
        type: "basic",
        iconUrl: chrome.runtime.getURL("icons/icon128.png"),
        title,
        message: String(message).slice(0, 200),
        priority: 0,
    });
}

async function boot() {
    chrome.alarms.create(ALARM, { periodInMinutes: 0.5 });
    chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(() => {});
    const stored = await chrome.storage.local.get("seq");
    if (stored.seq === undefined) {
        try {
            await chrome.storage.local.set({ seq: (await api("/api/me")).seq });
        } catch {
            await chrome.storage.local.set({ seq: 0 });
        }
    }
    pump();
    refreshMenus();
}

chrome.runtime.onStartup.addListener(boot);
chrome.runtime.onInstalled.addListener(boot);
chrome.alarms.onAlarm.addListener((alarm) => {
    if (alarm.name === ALARM) {
        pump();
        refreshMenus();
    }
});
chrome.runtime.onMessage.addListener((msg) => {
    if (msg?.type === "ezyshare:refresh") {
        pump();
        refreshMenus();
        refreshBadge();
    }
});

boot();
