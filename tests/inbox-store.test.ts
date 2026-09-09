import { describe, expect, test } from "bun:test";
import { createInboxStore, sanitizeItem } from "../daemon/src/inbox.store.ts";
import { MAX_ITEMS } from "../daemon/src/constants.ts";
import { tempDir, writeInbox } from "./helpers/daemon.harness.ts";

const ESC = String.fromCharCode(27);
const RTL_OVERRIDE = String.fromCharCode(0x202e);

describe("sanitizeItem", () => {
    test("drops anything whose url would not survive the filter", () => {
        for (const url of ["javascript:alert(1)", "file:///etc/passwd", "http://127.0.0.1/x"]) {
            expect(sanitizeItem({ url, fromName: "Alice" })).toBeNull();
        }
        expect(sanitizeItem(null)).toBeNull();
        expect(sanitizeItem("string")).toBeNull();
    });

    test("strips control characters from a tampered name", () => {
        const item = sanitizeItem({
            url: "https://example.com",
            fromName: `${ESC}[31mred${RTL_OVERRIDE}gnp.exe`,
        });
        expect(item?.fromName).toBe("[31mredgnp.exe");
    });

    /*
        A restored item whose flag did not survive must read as unverified, never be
        promoted to looking like it came from a known peer.
    */
    test("treats a missing verified flag as unverified", () => {
        expect(sanitizeItem({ url: "https://example.com" })?.verified).toBe(false);
        expect(sanitizeItem({ url: "https://example.com", verified: "yes" })?.verified).toBe(false);
        expect(sanitizeItem({ url: "https://example.com", verified: true })?.verified).toBe(true);
    });
});

describe("createInboxStore", () => {
    test("drops poisoned items and keeps the good one", () => {
        const dir = tempDir();
        writeInbox(dir, {
            seq: 4,
            items: [
                { seq: 1, url: "javascript:alert(1)", fromName: "Alice" },
                { seq: 2, url: "file:///Users/victim/.ssh/id_rsa", fromName: "Alice" },
                { seq: 3, url: "http://localhost:5000/admin", fromName: "Alice" },
                { seq: 4, url: "https://good.example/ok", fromName: "Alice", verified: true },
            ],
        });

        const store = createInboxStore(dir);
        expect(store.all()).toHaveLength(1);
        expect(store.all()[0]?.url).toBe("https://good.example/ok");
    });

    test("clamps a tampered sequence number", () => {
        const dir = tempDir();
        writeInbox(dir, {
            seq: 1e15,
            items: [{ seq: 3, url: "https://example.com/a", fromName: "Alice" }],
        });
        expect(createInboxStore(dir).seq()).toBe(3);
    });

    /*
        An item restored without a usable seq would sit below every `since` value and stay
        invisible while still occupying a slot.
    */
    test("renumbers an item that arrives with no usable seq", () => {
        const dir = tempDir();
        writeInbox(dir, { seq: 0, items: [{ url: "https://example.com/a", fromName: "Alice" }] });

        const store = createInboxStore(dir);
        expect(store.all()[0]?.seq).toBeGreaterThan(0);
        expect(store.since(0)).toHaveLength(1);
    });

    test("caps the number of stored items", () => {
        const store = createInboxStore(tempDir());
        for (let i = 0; i < MAX_ITEMS + 20; i++) {
            store.add({
                fromId: "",
                fromName: "Alice",
                url: `https://example.com/${i}`,
                title: "",
                verified: false,
            });
        }
        expect(store.all()).toHaveLength(MAX_ITEMS);
    });

    test("since only returns newer items", () => {
        const store = createInboxStore(tempDir());
        const first = store.add({
            fromId: "",
            fromName: "A",
            url: "https://a.com",
            title: "",
            verified: false,
        });
        const second = store.add({
            fromId: "",
            fromName: "A",
            url: "https://b.com",
            title: "",
            verified: false,
        });

        expect(store.since(first.seq)).toHaveLength(1);
        expect(store.since(first.seq)[0]?.seq).toBe(second.seq);
        expect(store.since(second.seq)).toHaveLength(0);
    });

    test("waiters wake when an item lands and can be cancelled", () => {
        const store = createInboxStore(tempDir());
        let woke = 0;

        const cancel = store.wait(() => (woke += 1));
        store.add({ fromId: "", fromName: "A", url: "https://a.com", title: "", verified: false });
        expect(woke).toBe(1);

        const cancelled = store.wait(() => (woke += 1));
        cancelled();
        store.add({ fromId: "", fromName: "A", url: "https://b.com", title: "", verified: false });
        expect(woke).toBe(1);

        cancel();
    });
});
