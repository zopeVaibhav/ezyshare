import { LIMITER_KEYS } from "./constants.ts";

export type Limiter = (key: string) => boolean;

export function createLimiter(limit: number, windowMs: number): Limiter {
    const seen = new Map<string, { start: number; count: number }>();

    return (key) => {
        const now = Date.now();
        const entry = seen.get(key);
        if (entry && now - entry.start <= windowMs) {
            entry.count += 1;
            return entry.count <= limit;
        }
        if (!entry && seen.size >= LIMITER_KEYS) {
            /*
                Never drop a live bucket to make room. Clearing the map, or evicting the oldest key,
                both let a flood of fresh keys reset the counter of an address already over its
                limit. Reclaim expired buckets only, then deny the flooder rather than the victim.
            */
            for (const [k, v] of seen) {
                if (now - v.start > windowMs) seen.delete(k);
                if (seen.size < LIMITER_KEYS) break;
            }
            if (seen.size >= LIMITER_KEYS) return false;
        }
        seen.set(key, { start: now, count: 1 });
        return true;
    };
}
