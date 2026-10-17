import { createAvatar } from "@dicebear/core";
import * as bigSmile from "@dicebear/big-smile";

/*
    Generated in the panel, never fetched. The hosted DiceBear API would send every peer
    name to a third party on each render, which is the one thing this tool promises not to
    do, and it would leave the panel blank offline. Same avatars, no request.
*/
const cache = new Map<string, string>();

export function avatarFor(seed: string): string {
    const hit = cache.get(seed);
    if (hit) return hit;

    const svg = createAvatar(bigSmile, {
        seed,
        size: 56,
        radius: 50,
        backgroundColor: ["transparent"],
    }).toString();

    const uri = `data:image/svg+xml;base64,${btoa(unescape(encodeURIComponent(svg)))}`;
    if (cache.size > 64) cache.clear();
    cache.set(seed, uri);
    return uri;
}
