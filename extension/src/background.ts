import { api, errorText, sendLink } from "./shared.ts";
import type { InboxItem, InboxResponse, MeResponse, PeersResponse } from "./ezyshare.type.ts";

const NOTIF_PREFIX = "ezyshare:";
const ALARM = "ezyshare-pump";
const MENU_ROOT = "ezyshare-root";
const MAX_TRACKED_LINKS = 50;
const BATCH_NOTIFY_LIMIT = 3;

let pumping = false;

async function pump(): Promise<void> {
    if (pumping) return;
    pumping = true;

    try {
        for (;;) {
            const stored = await chrome.storage.local.get("seq");
            const seq = typeof stored.seq === "number" ? stored.seq : 0;
            const data = await api<InboxResponse>(`/api/inbox?since=${seq}&wait=25000`);

            /*
                The daemon's counter only climbs. A lower one means its state was reset, and
                without this the extension would sit at the old high-water mark and silently
                stop delivering.
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
        await chrome.storage.local.set({ online: false, lastError: errorText(err) });
        await chrome.action.setBadgeText({ text: "!" });
        await chrome.action.setBadgeBackgroundColor({ color: "#b4392c" });
    } finally {
        pumping = false;
    }
}

async function deliver(newItems: InboxItem[]): Promise<void> {
    if (newItems.length === 0) return;

    /* A flood from one machine must not become a wall of notifications. */
    if (newItems.length > BATCH_NOTIFY_LIMIT) {
        const senders = [...new Set(newItems.map((item) => item.fromName))];
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
            /* one bad item must not stop the pump */
        }
    }
}

async function trackedLinks(): Promise<Record<string, string>> {
    const stored = await chrome.storage.session.get("links");
    return (stored.links ?? {}) as Record<string, string>;
}

async function notify(item: InboxItem): Promise<void> {
    const id = NOTIF_PREFIX + item.id;
    const entries = Object.entries(await trackedLinks()).slice(-(MAX_TRACKED_LINKS - 1));
    await chrome.storage.session.set({
        links: Object.fromEntries([...entries, [id, item.url]]),
    });

    let label = item.title;
    if (!label) {
        try {
            const url = new URL(item.url);
            label = url.hostname + url.pathname;
        } catch {
            label = item.url;
        }
    }

    chrome.notifications.create(id, {
        type: "basic",
        iconUrl: chrome.runtime.getURL("icons/icon128.png"),
        title: item.verified
            ? `${item.fromName} sent you a link`
            : `Unverified sender (${item.fromName})`,
        message: label,
        contextMessage: item.url.slice(0, 120),
        buttons: [{ title: "Open" }],
        priority: 2,
    });
}

async function markRead(payload: { ids: string[] } | { all: true }): Promise<void> {
    try {
        await api("/api/inbox/read", { method: "POST", body: JSON.stringify(payload) });
    } catch {
        /* offline */
    }
    void refreshBadge();
}

async function openFromNotification(notificationId: string): Promise<void> {
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
        await markRead({ all: true });
        return;
    }

    const links = await trackedLinks();
    const url = links[notificationId];
    if (url) {
        await chrome.tabs.create({ url });
        delete links[notificationId];
        await chrome.storage.session.set({ links });
    }

    chrome.notifications.clear(notificationId);
    await markRead({ ids: [notificationId.slice(NOTIF_PREFIX.length)] });
}

chrome.notifications.onClicked.addListener((id) => void openFromNotification(id));
chrome.notifications.onButtonClicked.addListener((id) => void openFromNotification(id));

async function refreshBadge(): Promise<void> {
    try {
        const data = await api<InboxResponse>("/api/inbox?since=0&wait=0");
        const unread = data.items.filter((item) => !item.read).length;
        await chrome.action.setBadgeText({ text: unread ? String(unread) : "" });
        await chrome.action.setBadgeBackgroundColor({ color: "#2f7d4f" });
    } catch {
        /* daemon down, pump already flagged it */
    }
}

/*
    null, not empty string: after a worker restart the menus may already exist in Chrome
    even though this variable is fresh, so the first refresh must always rebuild.
*/
let menuSignature: string | null = null;

async function refreshMenus(): Promise<void> {
    let peers: PeersResponse["peers"] = [];
    let enabled: boolean;

    try {
        const data = await api<PeersResponse>("/api/peers");
        peers = data.peers;
        enabled = data.enabled;
    } catch {
        enabled = false;
    }

    const signature = `${enabled}|${peers.map((peer) => `${peer.id}:${peer.name}`).join("|")}`;
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

    for (const peer of peers) {
        chrome.contextMenus.create({
            id: `${MENU_ROOT}:${peer.id}`,
            parentId: MENU_ROOT,
            title: peer.name,
            contexts: ["link", "page", "selection"],
        });
    }
}

chrome.contextMenus.onClicked.addListener((info, tab) => {
    const menuItemId = String(info.menuItemId);
    if (!menuItemId.startsWith(`${MENU_ROOT}:`)) return;

    const peerId = menuItemId.slice(MENU_ROOT.length + 1);
    const url = info.linkUrl ?? info.pageUrl ?? tab?.url;
    if (!url) return;
    const title = info.linkUrl ? (info.selectionText ?? "") : (tab?.title ?? "");

    void sendLink(peerId, url, title).then(
        (res) => toast(`Sent to ${res.to}`, url),
        (err: unknown) => toast("Send failed", errorText(err)),
    );
});

function toast(title: string, message: string): void {
    chrome.notifications.create(`ezyshare-status:${Date.now()}`, {
        type: "basic",
        iconUrl: chrome.runtime.getURL("icons/icon128.png"),
        title,
        message: message.slice(0, 200),
        priority: 0,
    });
}

async function boot(): Promise<void> {
    chrome.alarms.create(ALARM, { periodInMinutes: 0.5 });
    void chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(() => {});

    /*
        First run starts from the daemon's current position, so a backlog of old links does
        not arrive as a wall of notifications.
    */
    const stored = await chrome.storage.local.get("seq");
    if (stored.seq === undefined) {
        try {
            await chrome.storage.local.set({ seq: (await api<MeResponse>("/api/me")).seq });
        } catch {
            await chrome.storage.local.set({ seq: 0 });
        }
    }

    void pump();
    void refreshMenus();
}

chrome.runtime.onStartup.addListener(() => void boot());
chrome.runtime.onInstalled.addListener(() => void boot());
chrome.alarms.onAlarm.addListener((alarm) => {
    if (alarm.name !== ALARM) return;
    void pump();
    void refreshMenus();
});
chrome.runtime.onMessage.addListener((msg: unknown) => {
    if (
        typeof msg === "object" &&
        msg !== null &&
        (msg as { type?: string }).type === "ezyshare:refresh"
    ) {
        void pump();
        void refreshMenus();
        void refreshBadge();
    }
});

void boot();
