// Meta webhook authentication for the Sales Assistant route.
//
// POST: x-hub-signature-256 = "sha256=" + hex(HMAC-SHA256(app secret, raw body)).
// Compared in constant time over the RAW bytes, before any parsing. Fails closed
// on a missing header, a malformed header, or an empty secret. There is no
// "insecure" escape hatch here, unlike the dealer webhook.

import crypto from "node:crypto";

const HEADER_RE = /^sha256=([0-9a-f]{64})$/i;

export function verifySignature(
    rawBody: string,
    header: string | null | undefined,
    appSecret: string,
): boolean {
    if (!appSecret || !header) return false;
    const m = HEADER_RE.exec(header.trim());
    if (!m) return false;
    const given = Buffer.from(m[1].toLowerCase(), "hex");
    const expected = crypto
        .createHmac("sha256", appSecret)
        .update(Buffer.from(rawBody, "utf8"))
        .digest();
    // Both are 32 bytes by construction (the regex pins 64 hex chars).
    return crypto.timingSafeEqual(given, expected);
}

/**
 * GET subscription handshake: echo hub.challenge when mode=subscribe and the
 * verify token matches (constant-time). Returns null to refuse.
 */
export function verifyHandshake(url: URL, verifyToken: string): string | null {
    const p = url.searchParams;
    const token = p.get("hub.verify_token") ?? "";
    const challenge = p.get("hub.challenge");
    if (p.get("hub.mode") !== "subscribe" || !challenge || !verifyToken) return null;
    const a = crypto.createHash("sha256").update(token).digest();
    const b = crypto.createHash("sha256").update(verifyToken).digest();
    return crypto.timingSafeEqual(a, b) ? challenge : null;
}
