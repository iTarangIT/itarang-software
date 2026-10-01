// Ecofy ⇄ CRM request signing — docs/ECOFY_INTEGRATION.md §2.
//
//   X-Itarang-Signature: t=<unix seconds>,v1=<hex HMAC-SHA256(secret, "<t>.<payload>")>
//
// The payload is the raw request body for events (§3/§4) and the signing
// string "<METHOD>\n<path?query>\n<raw body>" for API calls (§5). Both sides
// use the same shared secret (ECOFY_SYNC_SECRET here, ITARANG_CRM_SECRET in
// Ecofy). Pure: no env, no I/O, so it is unit-tested directly.

import { createHmac, timingSafeEqual } from "node:crypto";

export const ECOFY_SIGNATURE_HEADER = "x-itarang-signature";
/** Requests whose `t` is further than this from our clock are rejected. */
export const ECOFY_MAX_SKEW_SECONDS = 300;

const HEADER_RE = /^t=(\d+),v1=([0-9a-f]{64})$/;

function mac(secret: string, t: string, payload: string | Buffer): string {
    return createHmac("sha256", secret).update(`${t}.`).update(payload).digest("hex");
}

export type EcofyVerifyResult =
    | { ok: true }
    | { ok: false; reason: "malformed" | "stale" | "mismatch" };

/**
 * Verify a signature header against the RAW body bytes (before JSON parsing).
 * Pass a Buffer where possible: hashing the bytes as received avoids any
 * decode/re-encode difference.
 */
export function verifyEcofySignature(
    secret: string,
    header: string | null,
    raw: string | Buffer,
    nowSeconds: number = Date.now() / 1000,
): EcofyVerifyResult {
    const m = HEADER_RE.exec((header ?? "").trim());
    if (!m) return { ok: false, reason: "malformed" };
    if (Math.abs(nowSeconds - Number(m[1])) > ECOFY_MAX_SKEW_SECONDS) {
        return { ok: false, reason: "stale" };
    }
    // Both sides are 32 bytes (the regex pins 64 hex chars), so
    // timingSafeEqual cannot throw on a length mismatch.
    const expected = Buffer.from(mac(secret, m[1], raw), "hex");
    const given = Buffer.from(m[2], "hex");
    return timingSafeEqual(given, expected) ? { ok: true } : { ok: false, reason: "mismatch" };
}

/** Build the X-Itarang-Signature header value for an outbound payload. */
export function signEcofyPayload(
    secret: string,
    payload: string,
    t: number = Math.floor(Date.now() / 1000),
): string {
    return `t=${t},v1=${mac(secret, String(t), payload)}`;
}

/** §5 signing string: binds the signature to one method + path + body. */
export function ecofyApiSigningString(method: string, pathAndQuery: string, rawBody: string): string {
    return `${method.toUpperCase()}\n${pathAndQuery}\n${rawBody}`;
}
