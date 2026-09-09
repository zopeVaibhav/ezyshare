import { api, errorText, sendLink } from "./shared.ts";
import type { InboxItem, InboxResponse, PeerCard, PeersResponse } from "./ezyshare.type.ts";

function el<T extends HTMLElement>(id: string): T {
    const node = document.getElementById(id);
    if (!node) throw new Error(`missing element: ${id}`);
    return node as T;
}

function initials(name: string): string {
    return (
        name
            .split(/[\s\-_.]+/)
            .filter(Boolean)
            .slice(0, 2)
            .map((word) => word.charAt(0).toUpperCase())
            .join("") || "?"
    );
}

function ago(ts: number): string {
    const seconds = Math.round((Date.now() - ts) / 1000);
    if (seconds < 60) return "just now";
    if (seconds < 3600) return `${Math.round(seconds / 60)}m ago`;
    if (seconds < 86400) return `${Math.round(seconds / 3600)}h ago`;
    return `${Math.round(seconds / 86400)}d ago`;
}

/* Screen readers get told what happened; the card colour alone does not reach them. */
function announce(text: string): void {
    el("live").textContent = text;
}

function flash(card: HTMLLIElement, cls: string, text: string): void {
    const sub = card.querySelector<HTMLElement>(".sub");
    if (!sub) return;

    const original = card.dataset.sub ?? sub.textContent ?? "";
    card.dataset.flashing = "1";
    card.classList.add(cls);
    sub.textContent = text;

    clearTimeout(Number(card.dataset.flashTimer));
    card.dataset.flashTimer = String(
        setTimeout(() => {
            card.classList.remove(cls);
            sub.textContent = original;
            delete card.dataset.flashing;
        }, 1600),
    );
}

async function deliver(
    card: HTMLLIElement,
    peer: PeerCard,
    url: string | null,
    title: string,
): Promise<void> {
    if (!url) {
        flash(card, "failed", "no link in that drop");
        announce("No link in that drop");
        return;
    }
    try {
        await sendLink(peer.id, url, title);
        flash(card, "sent", "sent");
        announce(`Sent to ${peer.name}`);
    } catch (err) {
        const reason = errorText(err);
        flash(card, "failed", reason.slice(0, 40));
        announce(`Could not send to ${peer.name}: ${reason}`);
    }
}

function urlFromDrop(dt: DataTransfer): string | null {
    const uriList = dt.getData("text/uri-list");
    if (uriList) {
        const first = uriList
            .split("\n")
            .map((line) => line.trim())
            .find((line) => line && !line.startsWith("#"));
        if (first) return first;
    }

    const text = dt.getData("text/plain").trim();
    if (/^https?:\/\//i.test(text)) return text;

    const match = dt.getData("text/html").match(/href\s*=\s*["'](https?:\/\/[^"']+)["']/i);
    return match?.[1] ?? null;
}

async function sendCurrentTab(card: HTMLLIElement, peer: PeerCard): Promise<void> {
    const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
    if (!tab?.url) return;
    await deliver(card, peer, tab.url, tab.title ?? "");
}

function peerCard(peer: PeerCard): HTMLLIElement {
    const li = document.createElement("li");
    li.className = "peer";
    /*
        A card is an activatable control, so it has to be reachable and operable from the
        keyboard, not only by mouse and drag.
    */
    li.tabIndex = 0;
    li.setAttribute("role", "button");
    li.dataset.id = peer.id;
    li.innerHTML = `
    <span class="avatar" aria-hidden="true"></span>
    <span class="col"><span class="name"></span><span class="sub"></span></span>`;

    const set = (selector: string, text: string) => {
        const node = li.querySelector<HTMLElement>(selector);
        if (node) node.textContent = text;
    };
    set(".avatar", initials(peer.name));
    set(".name", peer.name);
    set(".sub", peer.addr);
    li.dataset.sub = peer.addr;
    li.setAttribute("aria-label", `Send current tab to ${peer.name} at ${peer.addr}`);

    li.addEventListener("dragenter", (event) => {
        event.preventDefault();
        li.classList.add("over");
    });
    li.addEventListener("dragover", (event) => {
        event.preventDefault();
        if (event.dataTransfer) event.dataTransfer.dropEffect = "copy";
        li.classList.add("over");
    });
    li.addEventListener("dragleave", () => li.classList.remove("over"));
    li.addEventListener("drop", (event) => {
        event.preventDefault();
        li.classList.remove("over");
        if (!event.dataTransfer) return;
        void deliver(
            li,
            peer,
            urlFromDrop(event.dataTransfer),
            event.dataTransfer.getData("text/plain"),
        );
    });

    li.addEventListener("click", () => void sendCurrentTab(li, peer));
    li.addEventListener("keydown", (event) => {
        if (event.key !== "Enter" && event.key !== " ") return;
        event.preventDefault();
        void sendCurrentTab(li, peer);
    });

    return li;
}

/*
    Rebuilding every card on each poll would throw away the sent flash mid-animation and
    drop the drag state under the cursor, so only rebuild when the list actually changes.
*/
function peerSignature(list: PeerCard[]): string {
    return list.map((peer) => `${peer.id}:${peer.name}:${peer.addr}:${peer.port}`).join("|");
}

let renderedSignature: string | null = null;

function renderPeers(list: PeerCard[]): void {
    const signature = peerSignature(list);
    if (signature !== renderedSignature) {
        renderedSignature = signature;
        el("peers").replaceChildren(...list.map(peerCard));
    }
    el("nopeers").hidden = list.length > 0;
}

function inboxRow(item: InboxItem): HTMLLIElement {
    const li = document.createElement("li");
    const unverified = !item.verified;
    li.className = `item${item.read ? "" : " unread"}${unverified ? " unverified" : ""}`;

    const link = document.createElement("a");
    link.href = item.url;
    link.target = "_blank";
    link.rel = "noopener noreferrer";
    link.textContent = item.title || item.url;
    link.title = item.url;
    link.addEventListener("click", () => {
        void api("/api/inbox/read", {
            method: "POST",
            body: JSON.stringify({ ids: [item.id] }),
        }).catch(() => undefined);
        void chrome.runtime.sendMessage({ type: "ezyshare:refresh" });
    });

    const sub = document.createElement("span");
    sub.className = "sub";
    sub.textContent = unverified
        ? `${item.fromName} · not a known peer · ${ago(item.ts)}`
        : `${item.fromName} · ${ago(item.ts)}`;

    li.append(link, sub);
    return li;
}

function renderInbox(items: InboxItem[]): void {
    const recent = [...items].reverse().slice(0, 25);
    el("inbox").replaceChildren(...recent.map(inboxRow));
    el("noinbox").hidden = recent.length > 0;

    const unread = recent.filter((item) => !item.read).length;
    const badge = el("unread");
    badge.hidden = unread === 0;
    badge.textContent = String(unread);
    badge.setAttribute("aria-label", `${unread} unread`);
}

function renderLock(secured: boolean): void {
    const chip = el("lock");
    chip.hidden = false;
    chip.classList.toggle("locked", secured);
    chip.textContent = secured ? "locked" : "open";
    chip.title = secured
        ? "A shared secret is set. Only daemons with the same secret can see you or send to you."
        : "No shared secret. Any ezyshare on this network can send you a link. Start the daemon with --secret to lock it down.";
}

let toggleBusy = false;

async function tick(): Promise<void> {
    const toggle = el<HTMLInputElement>("toggle");
    try {
        const [peerData, inboxData] = await Promise.all([
            api<PeersResponse>("/api/peers"),
            api<InboxResponse>("/api/inbox?since=0&wait=0"),
        ]);

        el("offline").hidden = true;
        el("paused").hidden = peerData.enabled;
        el("main").hidden = !peerData.enabled;
        toggle.disabled = false;
        if (!toggleBusy) toggle.checked = peerData.enabled;
        el("dot").classList.toggle("on", peerData.enabled);
        el("myname").textContent = peerData.enabled
            ? peerData.me.name
            : `${peerData.me.name} · hidden`;

        renderLock(peerData.secured);
        renderPeers(peerData.peers);
        renderInbox(inboxData.items);
    } catch (err) {
        el("offline").hidden = false;
        el("main").hidden = true;
        el("paused").hidden = true;
        el("lock").hidden = true;
        toggle.checked = false;
        toggle.disabled = true;
        el("dot").classList.remove("on");
        el("myname").textContent = "offline";
        el("errline").textContent = errorText(err);
        renderedSignature = null;
    }
}

el<HTMLInputElement>("toggle").addEventListener("change", (event) => {
    const wanted = (event.target as HTMLInputElement).checked;
    toggleBusy = true;
    void api("/api/state", { method: "POST", body: JSON.stringify({ enabled: wanted }) })
        .then(() => {
            void chrome.runtime.sendMessage({ type: "ezyshare:refresh" });
            announce(wanted ? "Sharing on" : "Sharing off");
        })
        .catch(() => {
            (event.target as HTMLInputElement).checked = !wanted;
            announce("Could not change sharing");
        })
        .finally(() => {
            toggleBusy = false;
            void tick();
        });
});

el("refresh").addEventListener("click", () => {
    void chrome.runtime.sendMessage({ type: "ezyshare:refresh" });
    void tick();
});

el("clear").addEventListener("click", () => {
    void api("/api/inbox/clear", { method: "POST" })
        .catch(() => undefined)
        .then(() => {
            void chrome.runtime.sendMessage({ type: "ezyshare:refresh" });
            announce("Received list cleared");
            void tick();
        });
});

/* The whole panel accepts a drop too, so a sloppy aim still lands somewhere useful. */
document.addEventListener("dragover", (event) => event.preventDefault());
document.addEventListener("drop", (event) => event.preventDefault());

void tick();
setInterval(() => void tick(), 2000);
