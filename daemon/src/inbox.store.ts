import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { MAX_ITEMS, MAX_TITLE } from "./constants.ts";
import { safeUrl } from "./net.ts";
import { clean } from "./text.ts";
import type { InboxItem, NewInboxItem } from "./ezyshare.type.ts";

export type InboxStore = {
    seq: () => number;
    since: (seq: number) => InboxItem[];
    all: () => InboxItem[];
    add: (item: NewInboxItem) => InboxItem;
    markRead: (ids: Set<string>, all: boolean) => number;
    clear: () => void;
    wait: (onWake: () => void) => () => void;
};

/*
    Everything on disk is untrusted: a stale backup, a synced home directory, another
    local user. An item whose verified flag did not survive is treated as unverified
    rather than promoted to looking like it came from a known peer.
*/
export function sanitizeItem(
    raw: unknown,
): (Omit<InboxItem, "seq"> & { seq: number | null }) | null {
    if (!raw || typeof raw !== "object") return null;
    const record = raw as Record<string, unknown>;
    const url = safeUrl(record.url);
    if (!url) return null;

    const id = typeof record.id === "string" && /^[0-9a-f]{6,32}$/.test(record.id);
    const fromId = typeof record.fromId === "string" && /^[0-9a-f]{0,32}$/.test(record.fromId);

    return {
        seq:
            Number.isSafeInteger(record.seq) && (record.seq as number) > 0
                ? (record.seq as number)
                : null,
        id: id ? (record.id as string) : crypto.randomBytes(6).toString("hex"),
        fromId: fromId ? (record.fromId as string) : "",
        fromName: clean(record.fromName ?? "unknown"),
        url,
        title: clean(record.title, MAX_TITLE),
        ts: Number.isSafeInteger(record.ts) ? (record.ts as number) : Date.now(),
        read: record.read === true,
        verified: record.verified === true,
    };
}

export function createInboxStore(stateDir: string): InboxStore {
    const file = path.join(stateDir, "inbox.json");
    let items: InboxItem[] = [];
    let seq = 0;
    let waiters: Array<() => void> = [];
    let saveTimer: NodeJS.Timeout | null = null;

    try {
        const saved = JSON.parse(fs.readFileSync(file, "utf8")) as Record<string, unknown>;
        const restored = (Array.isArray(saved.items) ? saved.items : [])
            .map(sanitizeItem)
            .filter((item) => item !== null)
            .slice(-MAX_ITEMS);

        /*
            An item with no usable seq would sit below every `since` value and stay invisible
            forever while still occupying a slot.
        */
        let next = restored.reduce((max, item) => Math.max(max, item.seq ?? 0), 0);
        items = restored.map((item) => ({ ...item, seq: item.seq ?? ++next }));

        const highest = items.reduce((max, item) => Math.max(max, item.seq), 0);
        const claimed = Number.isSafeInteger(saved.seq) ? (saved.seq as number) : 0;
        seq = claimed >= highest && claimed <= highest + 1_000_000 ? claimed : highest;
    } catch {
        /* first run */
    }

    function persist(): void {
        if (saveTimer) clearTimeout(saveTimer);
        saveTimer = setTimeout(() => {
            fs.writeFile(file, JSON.stringify({ seq, items }, null, 2), { mode: 0o600 }, () => {});
        }, 200);
        saveTimer.unref();
    }

    function wake(): void {
        const pending = waiters;
        waiters = [];
        for (const fn of pending) fn();
    }

    return {
        seq: () => seq,
        since: (from) => items.filter((item) => item.seq > from),
        all: () => items,

        add(item) {
            seq += 1;
            const full: InboxItem = {
                ...item,
                seq,
                id: crypto.randomBytes(6).toString("hex"),
                ts: Date.now(),
                read: false,
            };
            items.push(full);
            if (items.length > MAX_ITEMS) items = items.slice(-MAX_ITEMS);
            persist();
            wake();
            return full;
        },

        markRead(ids, all) {
            for (const item of items) if (all || ids.has(item.id)) item.read = true;
            persist();
            return items.filter((item) => !item.read).length;
        },

        clear() {
            items = [];
            persist();
        },

        wait(onWake) {
            waiters.push(onWake);
            return () => {
                waiters = waiters.filter((fn) => fn !== onWake);
            };
        },
    };
}
