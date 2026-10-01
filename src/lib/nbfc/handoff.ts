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
 *   - INBOUND: the result callback is verified with the same secret
 *     (inboundCallbackAllowed below). A wrong signature is always refused. An
 *     UNSIGNED callback is still accepted by ref — and logged — until
 *     WEBHOOK_AUTH_STRICT=1, because NBFCs integrated before signing existed.
 */
import { createHmac, randomBytes } from "node:crypto";

import { checkWebhook, checksumProof } from "@/lib/security/webhookAuth";

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
 * Check an NBFC's result callback (tracker ID 118). Returns true when the
 * callback may be applied.
 *
 *   signature present   it must match the rail's secret, or the call is refused;
 *   signature missing   accepted by ref and logged as UNVERIFIED — the ref
 *                       travels in the hand-off URL, so anyone who saw that URL
 *                       can post a result. Refused under WEBHOOK_AUTH_STRICT=1.
 *
 * The old helper accepted every unsigned call silently, which made the
 * signature optional for an attacker too; this one at least says so in the log
 * and gives a switch to close it once the NBFCs sign.
 */
export function inboundCallbackAllowed(args: {
  route: string;
  secret: string | null | undefined;
  rawBody: string;
  signatureHeader: string | null | undefined;
}): boolean {
  const verdict = checkWebhook({
    route: args.route,
    secret: args.secret,
    proof: checksumProof(args.secret, args.rawBody, args.signatureHeader),
    allowUnsigned: true,
    configure:
      "The NBFC must sign its callback with X-iTarang-Signature: sha256=<HMAC of the body> using the webhook secret shown in its Settings.",
  });
  return verdict !== "refuse";
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
