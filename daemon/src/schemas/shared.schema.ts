import { z } from "zod";
import { MAX_TITLE, PEER_ID } from "../constants.ts";
import { safeUrl } from "../net.ts";
import { clean } from "../text.ts";

/*
    One source of truth for what counts as a shareable link. safeUrl holds the loopback
    and scheme rules; zod carries them into every boundary that parses a payload.
*/
export const shareableUrl = z.unknown().transform((value, ctx) => {
    const url = safeUrl(value);
    if (!url) {
        ctx.addIssue({
            code: "custom",
            message: "url must be a non-loopback http or https link",
        });
        return z.NEVER;
    }
    return url;
});

export const cleanTitle = z
    .unknown()
    .transform((value) => (value === undefined ? "" : clean(value, MAX_TITLE)));

export const peerId = z.string().regex(PEER_ID);
export const networkPort = z.number().int().min(1).max(65535);
