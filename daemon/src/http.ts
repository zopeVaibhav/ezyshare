import type { IncomingMessage, ServerResponse } from "node:http";
import { MAX_BODY_BYTES } from "./constants.ts";

export type Body = { data: Record<string, unknown>; raw: string };

export function json(res: ServerResponse, code: number, body: unknown): void {
    const payload = JSON.stringify(body);
    res.writeHead(code, {
        "content-type": "application/json",
        "content-length": Buffer.byteLength(payload),
    });
    res.end(payload);
}

export function readBody(req: IncomingMessage, limit = MAX_BODY_BYTES): Promise<Body> {
    return new Promise((resolve, reject) => {
        let size = 0;
        const chunks: Buffer[] = [];

        req.on("data", (chunk: Buffer) => {
            size += chunk.length;
            if (size > limit) {
                reject(new Error("body too large"));
                req.destroy();
                return;
            }
            chunks.push(chunk);
        });

        req.on("end", () => {
            /*
                The raw text comes back too: /inbox authenticates the exact bytes it was sent,
                not a re-serialisation of them.
            */
            const raw = chunks.length ? Buffer.concat(chunks).toString() : "";
            try {
                const parsed: unknown = raw ? JSON.parse(raw) : {};
                /*
                    "null", "[]" and a bare string are all valid JSON. Handlers read properties off
                    this value, and a throw inside an async listener is an unhandled rejection,
                    which kills the process.
                */
                const usable =
                    parsed !== null && typeof parsed === "object" && !Array.isArray(parsed);
                resolve({ data: usable ? (parsed as Record<string, unknown>) : {}, raw });
            } catch (err) {
                reject(err instanceof Error ? err : new Error("bad json"));
            }
        });

        req.on("error", reject);
    });
}
