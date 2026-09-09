import type { IncomingMessage, ServerResponse } from "node:http";
import { json } from "../http.ts";
import type { Identity } from "../ezyshare.type.ts";
import type { Signer } from "../secret.ts";

export function handleWhoami(
    _req: IncomingMessage,
    res: ServerResponse,
    url: URL,
    self: Identity,
    signer: Signer | null,
): void {
    const body: Record<string, unknown> = { id: self.id, name: self.name, port: self.port };
    const nonce = url.searchParams.get("nonce");
    /*
        The caller picks the nonce, so a reply recorded from another exchange cannot be
        played back at them.
    */
    if (signer && nonce) body.mac = signer.whoamiMac(self.id, self.name, self.port, nonce);
    json(res, 200, body);
}
