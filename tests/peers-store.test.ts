import { describe, expect, test } from "bun:test";
import { MAX_PEERS, PEER_TTL_MS } from "../daemon/src/constants.ts";
import { createPeerStore } from "../daemon/src/peers.store.ts";
import type { Peer } from "../daemon/src/ezyshare.type.ts";

function peer(overrides: Partial<Peer> = {}): Peer {
    return {
        id: "aaaabbbbccccdddd",
        name: "Alice",
        addr: "192.168.1.10",
        port: 8787,
        lastSeen: Date.now(),
        manual: false,
        ...overrides,
    };
}

describe("createPeerStore", () => {
    /*
        Someone who overhears a broadcast learns the id in it. Without this rule they could
        re-announce that id from their own address and quietly receive that peer's links.
    */
    test("a live entry cannot be relocated to another address", () => {
        const store = createPeerStore();
        store.set(peer());

        expect(store.heldByAnother("aaaabbbbccccdddd", "192.168.1.99", 8787)).not.toBeNull();
        expect(store.heldByAnother("aaaabbbbccccdddd", "192.168.1.10", 9999)).not.toBeNull();
        expect(store.heldByAnother("aaaabbbbccccdddd", "192.168.1.10", 8787)).toBeNull();
    });

    test("a stale entry may be replaced, so a peer that changes IP recovers", () => {
        const store = createPeerStore();
        store.set(peer({ lastSeen: Date.now() - PEER_TTL_MS - 1 }));
        expect(store.heldByAnother("aaaabbbbccccdddd", "192.168.1.99", 8787)).toBeNull();
    });

    test("an unknown id is not held by anyone", () => {
        expect(createPeerStore().heldByAnother("ffffffffffffffff", "10.0.0.1", 8787)).toBeNull();
    });

    /*
        Refusing new peers at the cap turned unbounded growth into a lockout, so the store
        evicts the stalest entry instead.
    */
    test("a full store evicts the stalest entry rather than refusing the newcomer", () => {
        const store = createPeerStore();
        for (let i = 0; i < MAX_PEERS; i++) {
            store.set(peer({ id: `id${String(i).padStart(13, "0")}`, lastSeen: Date.now() + i }));
        }
        expect(store.size()).toBe(MAX_PEERS);

        expect(store.evictStalest()).toBe(true);
        expect(store.size()).toBe(MAX_PEERS - 1);
        expect(store.get("id0000000000000")).toBeUndefined();
    });

    test("reap drops entries past the TTL and reports them", () => {
        const store = createPeerStore();
        store.set(peer({ id: "1111111111111111", lastSeen: Date.now() - PEER_TTL_MS - 1 }));
        store.set(peer({ id: "2222222222222222" }));

        const dropped: string[] = [];
        store.reap((gone) => dropped.push(gone.id));

        expect(dropped).toEqual(["1111111111111111"]);
        expect(store.size()).toBe(1);
    });

    test("list hides internal fields and sorts by name", () => {
        const store = createPeerStore();
        store.set(peer({ id: "1111111111111111", name: "Zoe" }));
        store.set(peer({ id: "2222222222222222", name: "Adam" }));

        const list = store.list();
        expect(list.map((entry) => entry.name)).toEqual(["Adam", "Zoe"]);
        expect(list[0]).not.toHaveProperty("manual");
    });
});
