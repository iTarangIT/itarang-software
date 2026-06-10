/**
 * NBFC "bring-your-own-provider" handoff helpers (E-165).
 *
 * The handoff / B2-B model: for a rail in "own" mode (Video KYC own, e-Sign
 * own_esign — and the existing E-NACH redirect/webhook), iTarang TRIGGERS the
 * step and hands it off to the NBFC's OWN provider endpoint, then records only
 * the canonical result the NBFC posts back to our callback. The NBFC's provider
 * credentials never reach iTarang.
 *
 * Authenticity is established with a per-rail iTarang-minted HMAC secret
 * (`nbfc_service_config.{vkyc,enach,esign}_webhook_secret`):
 *   - OUTBOUND: every handoff POST is signed with `X-iTarang-Signature: sha256=…`
 *     so the NBFC can verify the request really came from iTarang.
 *   - INBOUND: the result callback can be verified with the same secret. To stay
 *     backward-compatible with the existing match-by-ref callbacks (E-NACH ships
 *     ref-only today), verification is ENFORCED only when a secret is configured
 *     AND a signature header is present; otherwise the callback is accepted by
 *     ref as before.
 */
import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";

const SIGNATURE_HEADER = "x-itarang-signature";

/** Mint a new HMAC secret to show the NBFC (read-only) and store on the config. */
export function generateWebhookSecret(): string {
  return `whsec_${randomBytes(24).toString("hex")}`;
}

/** Hex HMAC-SHA256 of `body` under `secret`, formatted as `sha256=<hex>`. */
export function signBody(secret: string, body: string): string {
  const mac = createHmac("sha256", secret).update(body, "utf8").digest("hex");
  return `sha256=${mac}`;
}

/**
 * Constant-time check of an inbound `X-iTarang-Signature` against the raw body.
 * Returns true when no secret is configured (ref-only mode) OR no signature was
 * sent (legacy caller) — callers should still match by their opaque ref.
 */
export function verifyInboundSignature(
  secret: string | null | undefined,
  rawBody: string,
  signatureHeader: string | null | undefined,
): boolean {
  if (!secret) return true; // ref-only rail (no secret configured) — accept
  if (!signatureHeader) return true; // legacy/unsigned caller — accept by ref
  const expected = signBody(secret, rawBody);
  const a = Buffer.from(expected);
  const b = Buffer.from(signatureHeader);
  return a.length === b.length && timingSafeEqual(a, b);
}

export interface HandoffResult {
  ok: boolean;
  status: number | null;
  error?: string;
}

/**
 * Server-to-server handoff: POST a signed JSON payload to the NBFC's own
 * provider endpoint. Best-effort — a delivery failure is returned (not thrown)
 * so the caller can still surface the deep-link / callback URL to the operator.
 */
export async function postHandoff(args: {
  url: string;
  payload: Record<string, unknown>;
  secret?: string | null;
  timeoutMs?: number;
}): Promise<HandoffResult> {
  const body = JSON.stringify(args.payload);
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (args.secret) headers[SIGNATURE_HEADER] = signBody(args.secret, body);

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), args.timeoutMs ?? 8000);
  try {
    const res = await fetch(args.url, {
      method: "POST",
      headers,
      body,
      signal: controller.signal,
    });
    return { ok: res.ok, status: res.status };
  } catch (e) {
    return { ok: false, status: null, error: e instanceof Error ? e.message : String(e) };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Build a deep-link the operator/customer can be sent to the NBFC's own app at,
 * carrying our opaque ref + the result callback URL as query params.
 */
export function buildHandoffUrl(
  endpoint: string,
  params: { ref: string; callback: string; extra?: Record<string, string> },
): string {
  const u = new URL(endpoint);
  u.searchParams.set("ref", params.ref);
  u.searchParams.set("callback", params.callback);
  for (const [k, v] of Object.entries(params.extra ?? {})) u.searchParams.set(k, v);
  return u.toString();
}
