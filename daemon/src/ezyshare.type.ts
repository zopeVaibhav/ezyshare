export type Peer = {
    id: string;
    name: string;
    addr: string;
    port: number;
    lastSeen: number;
    manual: boolean;
    warned?: boolean;
};

export type PublicPeer = Omit<Peer, "manual" | "warned">;

export type InboxItem = {
    seq: number;
    id: string;
    fromId: string;
    fromName: string;
    url: string;
    title: string;
    ts: number;
    read: boolean;
    verified: boolean;
};

export type NewInboxItem = Omit<InboxItem, "seq" | "id" | "ts" | "read">;

export type DaemonConfig = {
    enabled: boolean;
    extensionOrigin: string | null;
};

export type Identity = {
    id: string;
    name: string;
    port: number;
};

export type CliArgs = {
    name: string | null;
    port: number;
    dport: number;
    peers: string[];
    dir: string | null;
    resetPairing: boolean;
    secret: string | null;
};
