import { z } from "zod";

import { cleanTitle, networkPort, peerId, shareableUrl } from "./shared.schema.ts";

export const inboxPayload = z.object({
    fromId: z
        .string()
        .regex(/^[0-9a-f]{0,32}$/)
        .optional(),
    url: shareableUrl,
    title: cleanTitle.optional(),
    ts: z.number().optional(),
    nonce: z.string().optional(),
});

export const announcePayload = z.object({
    t: z.literal("hi"),
    id: peerId,
    name: z.unknown().optional(),
    port: networkPort,
    ts: z.number().optional(),
    mac: z.string().optional(),
});

export const whoamiResponse = z.object({
    id: peerId,
    name: z.unknown().optional(),
    port: networkPort.optional(),
    mac: z.string().optional(),
});

export type InboxPayload = z.infer<typeof inboxPayload>;
export type AnnouncePayload = z.infer<typeof announcePayload>;
