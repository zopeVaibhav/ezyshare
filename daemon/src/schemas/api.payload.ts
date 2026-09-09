import { z } from "zod";
import { MAX_ITEMS } from "../constants.ts";
import { cleanTitle, shareableUrl } from "./shared.schema.ts";

export const sendPayload = z.object({
    peerId: z.string().min(1),
    url: shareableUrl,
    title: cleanTitle.optional(),
});

export const statePayload = z.object({
    enabled: z.boolean().optional(),
});

export const readPayload = z.object({
    ids: z.array(z.string()).max(MAX_ITEMS).optional(),
    all: z.boolean().optional(),
});

export type SendPayload = z.infer<typeof sendPayload>;
