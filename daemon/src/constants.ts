export const DISCOVERY_PORT_DEFAULT = 38477;
export const HTTP_PORT_DEFAULT = 8787;
export const ANNOUNCE_INTERVAL_MS = 3000;
export const PEER_TTL_MS = 12000;
export const REAP_INTERVAL_MS = 3000;
export const MANUAL_PROBE_INTERVAL_MS = 5000;
export const CLOCK_SKEW_MS = 30_000;

export const MAX_ITEMS = 200;
export const MAX_PEERS = 256;
export const MAX_NAME = 64;
export const MAX_TITLE = 200;
export const MAX_URL = 2048;
export const MAX_BODY_BYTES = 16 * 1024;
export const MAX_ANNOUNCE_BYTES = 512;
export const LIMITER_KEYS = 4096;

export const PEER_HEADER = "x-ezyshare-peer";
export const MAC_HEADER = "x-ezyshare-mac";
export const API_HEADER = "x-ezyshare";

export const EXTENSION_ORIGIN = /^chrome-extension:\/\/[a-p]{32}$/;
export const PEER_ID = /^[0-9a-f]{16}$/;
