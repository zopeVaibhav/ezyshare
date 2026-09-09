export type PeerCard = {
    id: string;
    name: string;
    addr: string;
    port: number;
    lastSeen: number;
};

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

export type PeersResponse = {
    me: { id: string; name: string };
    enabled: boolean;
    secured: boolean;
    peers: PeerCard[];
};

export type InboxResponse = {
    seq: number;
    items: InboxItem[];
};

export type MeResponse = {
    id: string;
    name: string;
    port: number;
    seq: number;
    enabled: boolean;
};

export type SendResponse = {
    ok: true;
    to: string;
};

export type StateResponse = {
    enabled: boolean;
};
