import { MAX_PEERS, PEER_TTL_MS } from "./constants.ts";
import type { Peer, PublicPeer } from "./ezyshare.type.ts";

export type PeerStore = {
    get: (id: string) => Peer | undefined;
    set: (peer: Peer) => void;
    delete: (id: string) => void;
    clear: () => void;
    size: () => number;
    list: () => PublicPeer[];
    /*
        First address and port win for the life of the entry, or anyone who overhears a
        broadcast can re-announce that id and quietly become that peer.
    */
    heldByAnother: (id: string, addr: string, port: number) => Peer | null;
    evictStalest: () => boolean;
    reap: (onDrop: (peer: Peer) => void) => void;
};

export function createPeerStore(): PeerStore {
    const peers = new Map<string, Peer>();

    return {
        get: (id) => peers.get(id),
        set: (peer) => void peers.set(peer.id, peer),
        delete: (id) => void peers.delete(id),
        clear: () => peers.clear(),
        size: () => peers.size,

        list() {
            return [...peers.values()]
                .map(({ id, name, addr, port, lastSeen }) => ({ id, name, addr, port, lastSeen }))
                .sort((a, b) => a.name.localeCompare(b.name));
        },

        heldByAnother(id, addr, port) {
            const existing = peers.get(id);
            if (!existing) return null;
            if (existing.addr === addr && existing.port === port) return null;
            if (Date.now() - existing.lastSeen >= PEER_TTL_MS) return null;
            return existing;
        },

        evictStalest() {
            if (peers.size < MAX_PEERS) return true;
            const stalest = [...peers.values()].sort((a, b) => a.lastSeen - b.lastSeen)[0];
            if (!stalest) return false;
            peers.delete(stalest.id);
            return true;
        },

        reap(onDrop) {
            const now = Date.now();
            for (const [id, peer] of peers) {
                if (now - peer.lastSeen <= PEER_TTL_MS) continue;
                peers.delete(id);
                onDrop(peer);
            }
        },
    };
}
