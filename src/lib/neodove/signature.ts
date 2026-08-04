// NeoDove webhook authentication (E-224).
//
// NeoDove has NO native webhook signing — no HMAC, no signature header, nothing
// in their documentation. What Workflows → Send Webhook does give us is
// arbitrary CUSTOM HEADERS, so the scheme is a shared-secret bearer token, the
// same approach src/lib/ai/bolna_ai/signature.ts takes for Bolna and for the
// same reason.
//
// Configure in NeoDove: Workflows → Send Webhook → Headers →
//   Authorization: Bearer <NEODOVE_WEBHOOK_SECRET>
//
// LIMITATION, STATED PLAINLY. A static bearer token authenticates the SENDER
// but not the MESSAGE: anyone who learns the token can forge any payload, and
// there is no replay protection in the token itself. Replay is covered
// separately and independently — by the partial unique index on
// neodove_sync_events.external_event_id and by E-113's
// lead_touchpoints_external_uniq. Body integrity is not covered and cannot be
// until NeoDove ships real signing; if they do, extend this function to check
// the new header IN ADDITION to the bearer token rather than replacing it.

import { timingSafeEqual } from "node:crypto";
import { getNeodoveConfig } from "./config";

export class NeodoveWebhookSecretMissingError extends Error {
    constructor() {
        super("NEODOVE_WEBHOOK_SECRET is not set");
        this.name = "NeodoveWebhookSecretMissingError";
    }
}

export class NeodoveWebhookInvalidError extends Error {
    constructor(reason: string) {
        super(`NeoDove webhook rejected: ${reason}`);
        this.name = "NeodoveWebhookInvalidError";
    }
}

/**
 * Throws on misconfiguration or a bad token; the route maps that to 401.
 *
 * `rawBody` is unused today but is part of the signature deliberately: when
 * NeoDove adds body signing, every call site already passes the exact bytes
 * needed to verify it, and none of them have to change.
 */
export function verifyNeodoveWebhook(
    headers: Headers,
    // Part of the signature deliberately, so that when NeoDove ships body
    // signing every call site already passes the exact bytes needed and none
    // of them have to change.
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    _rawBody: string,
): void {
    const { webhookSecret, webhookInsecure } = getNeodoveConfig();

    if (!webhookSecret) {
        // Dev convenience only. getNeodoveConfig() already forces
        // webhookInsecure to false when NODE_ENV === 'production', so this
        // branch cannot open a hole in prod even if the env var is set there.
        if (webhookInsecure) {
            console.warn(
                "[NeoDove/webhook] NEODOVE_WEBHOOK_SECRET unset and NEODOVE_WEBHOOK_INSECURE is on — accepting unverified webhook (dev only)",
            );
            return;
        }
        throw new NeodoveWebhookSecretMissingError();
    }

    const auth = headers.get("authorization");
    if (!auth) throw new NeodoveWebhookInvalidError("missing Authorization header");

    const match = /^Bearer\s+(.+)$/.exec(auth.trim());
    if (!match) throw new NeodoveWebhookInvalidError("malformed Authorization header");

    const a = Buffer.from(match[1], "utf8");
    const b = Buffer.from(webhookSecret, "utf8");
    // Length is checked first because timingSafeEqual throws on a mismatch —
    // and the length itself is not a secret worth protecting.
    if (a.length !== b.length || !timingSafeEqual(a, b)) {
        throw new NeodoveWebhookInvalidError("token mismatch");
    }
}
