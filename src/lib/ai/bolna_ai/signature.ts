// Bolna webhook authentication. Bolna's webhook config supports adding
// arbitrary headers; the simplest robust scheme is a shared-secret Bearer
// token. Configure Bolna to send `Authorization: Bearer ${BOLNA_WEBHOOK_SECRET}`
// to /api/bolna/webhook, and this module verifies it.
//
// If Bolna later adds native HMAC signing, extend verifyBolnaWebhook to
// check the new header in addition to the bearer token.
import { timingSafeEqual } from "node:crypto";

export class WebhookSecretMissingError extends Error {
  constructor() {
    super("BOLNA_WEBHOOK_SECRET is not set");
    this.name = "WebhookSecretMissingError";
  }
}

export class WebhookSignatureInvalidError extends Error {
  constructor(reason: string) {
    super(`Bolna webhook signature invalid: ${reason}`);
    this.name = "WebhookSignatureInvalidError";
  }
}

// Throws on misconfiguration or invalid signature. Caller (route) maps to 401.
export function verifyBolnaWebhook(req: Request): void {
  const secret = process.env.BOLNA_WEBHOOK_SECRET;
  if (!secret) throw new WebhookSecretMissingError();

  const auth = req.headers.get("authorization");
  if (!auth) {
    throw new WebhookSignatureInvalidError("missing Authorization header");
  }

  const match = /^Bearer\s+(.+)$/.exec(auth);
  if (!match) {
    throw new WebhookSignatureInvalidError("malformed Authorization header");
  }
  const provided = match[1];

  // Constant-time compare so timing-based extraction isn't possible.
  const a = Buffer.from(provided, "utf8");
  const b = Buffer.from(secret, "utf8");
  if (a.length !== b.length) {
    throw new WebhookSignatureInvalidError("token mismatch");
  }
  if (!timingSafeEqual(a, b)) {
    throw new WebhookSignatureInvalidError("token mismatch");
  }
}
