// Proof that a webhook or callback really came from the provider (tracker ID
// 118, gap 4).
//
// A webhook route is on the public list (publicApi.ts) because the provider
// cannot carry a login. That only says the caller needs no SESSION — it still
// has to prove who it is, or anyone who learns the URL can post "signed",
// "verified" or "registered" and the CRM will believe it.
//
// One rule for every provider, so a deploy never breaks a working webhook:
//
//   secret configured     the proof is REQUIRED. Missing or wrong → 401.
//   secret not configured the call is accepted as before and logged as
//                         UNVERIFIED, so the gap is visible in the log.
//   WEBHOOK_AUTH_STRICT=1 a call that cannot be verified is refused, secret or
//                         no secret. Turn this on once every provider below has
//                         its secret set and the UNVERIFIED lines have stopped.
//
// `allowUnsigned` is for the NBFC hand-off rails only. There the secret is
// minted by US the moment the NBFC switches a rail to "own", so "a secret
// exists" does not mean "the NBFC has started signing". On those rails a call
// with NO signature is still accepted (and logged) until strict mode; a call
// with a WRONG signature is always refused.
//
// Dependency-free apart from node:crypto, so it can be unit-tested directly.

import { createHmac, timingSafeEqual } from "node:crypto";
import { NextResponse } from "next/server";

/** What the caller presented: a proof that matches, one that does not, or nothing. */
export type WebhookProof = "valid" | "invalid" | "absent";

export type WebhookVerdict = "verified" | "unverified" | "refuse";

export function webhookAuthStrict(raw: string | undefined = process.env.WEBHOOK_AUTH_STRICT): boolean {
  const v = (raw ?? "").trim().toLowerCase();
  return v === "1" || v === "true" || v === "yes";
}

/** The decision for one call. Pure. */
export function webhookVerdict(input: {
  secretConfigured: boolean;
  proof: WebhookProof;
  strict?: boolean;
  allowUnsigned?: boolean;
}): WebhookVerdict {
  const strict = input.strict ?? webhookAuthStrict();
  if (!input.secretConfigured) return strict ? "refuse" : "unverified";
  if (input.proof === "valid") return "verified";
  if (input.proof === "absent" && input.allowUnsigned && !strict) return "unverified";
  return "refuse";
}

function safeEqual(a: string, b: string): boolean {
  const enc = new TextEncoder();
  const x = enc.encode(a);
  const y = enc.encode(b);
  // Length first: timingSafeEqual throws on a mismatch, and the length is not secret.
  return x.length === y.length && timingSafeEqual(x, y);
}

export function hmacSha256Hex(secret: string, rawBody: string): string {
  return createHmac("sha256", secret).update(rawBody, "utf8").digest("hex");
}

/**
 * An HMAC-SHA256 hex checksum of the raw body in a header — Digio's
 * `X-Digio-Checksum`, our own `X-iTarang-Signature: sha256=<hex>`. The
 * `sha256=` prefix and letter case are both tolerated.
 */
export function checksumProof(
  secret: string | null | undefined,
  rawBody: string,
  header: string | null | undefined,
): WebhookProof {
  const sent = (header ?? "").trim();
  if (!sent) return "absent";
  if (!secret) return "invalid";
  const hex = sent.replace(/^sha256=/i, "").toLowerCase();
  return safeEqual(hex, hmacSha256Hex(secret, rawBody)) ? "valid" : "invalid";
}

/** A shared secret sent as `Authorization: Bearer <secret>` (Bolna, NeoDove style). */
export function bearerProof(
  secret: string | null | undefined,
  authorization: string | null | undefined,
): WebhookProof {
  const sent = (authorization ?? "").trim();
  if (!sent) return "absent";
  const match = /^Bearer\s+(.+)$/i.exec(sent);
  if (!match || !secret) return "invalid";
  return safeEqual(match[1], secret) ? "valid" : "invalid";
}

// One log line per route per minute: a provider retrying a refused event, or a
// busy unverified webhook, must not flood the log.
const lastLogged = new Map<string, number>();
function shouldLog(key: string): boolean {
  const now = Date.now();
  if (now - (lastLogged.get(key) ?? 0) < 60_000) return false;
  lastLogged.set(key, now);
  return true;
}

export type WebhookCheck = {
  /** The route path, for the log line. */
  route: string;
  secret: string | null | undefined;
  proof: WebhookProof;
  /** How to configure the secret — named in the log so the fix is obvious. */
  configure: string;
  allowUnsigned?: boolean;
};

/** Decide and log. Use this where the route builds its own response. */
export function checkWebhook(check: WebhookCheck): WebhookVerdict {
  const verdict = webhookVerdict({
    secretConfigured: !!check.secret,
    proof: check.proof,
    allowUnsigned: check.allowUnsigned,
  });
  if (verdict === "refuse" && shouldLog(`refuse:${check.route}`)) {
    console.warn(
      `[webhook-auth] REFUSED ${check.route} — ` +
        (check.secret ? `proof ${check.proof}` : `no secret configured and WEBHOOK_AUTH_STRICT is on`) +
        `. ${check.configure}`,
    );
  }
  if (verdict === "unverified" && shouldLog(`unverified:${check.route}`)) {
    console.warn(
      `[webhook-auth] UNVERIFIED ${check.route} accepted — ` +
        (check.secret ? "the caller sent no signature" : "no secret configured") +
        `. ${check.configure}`,
    );
  }
  return verdict;
}

/** Decide, log, and return the 401 to send — or null when the call may proceed. */
export function guardWebhook(check: WebhookCheck): NextResponse | null {
  if (checkWebhook(check) !== "refuse") return null;
  return NextResponse.json({ success: false, error: "Unauthorized" }, { status: 401 });
}

// ── providers ───────────────────────────────────────────────────────────────

/**
 * Digio (iTarang's own account). Digio signs every webhook with
 * `X-Digio-Checksum` = HMAC-SHA256 hex of the request body, keyed with the
 * secret set in Enterprise Dashboard → Profile → Webhook. One secret per
 * account; sandbox and production have their own.
 */
export function guardDigioWebhook(headers: Headers, rawBody: string, route: string): NextResponse | null {
  const secret = process.env.DIGIO_WEBHOOK_SECRET;
  return guardWebhook({
    route,
    secret,
    proof: checksumProof(secret, rawBody, headers.get("x-digio-checksum")),
    configure:
      "Set DIGIO_WEBHOOK_SECRET to the webhook secret key from the Digio Enterprise Dashboard (Profile → Webhook).",
  });
}

/**
 * Bolna. No native signing; Bolna's webhook config takes custom headers, so the
 * scheme is `Authorization: Bearer <secret>` (see ai/bolna_ai/signature.ts).
 * `envName` is BOLNA_WEBHOOK_SECRET for call webhooks and BOLNA_TOOL_SECRET for
 * the in-call tool endpoints, which are configured separately on the agent.
 */
export function guardBolnaCall(
  headers: Headers,
  route: string,
  envName: "BOLNA_WEBHOOK_SECRET" | "BOLNA_TOOL_SECRET",
): NextResponse | null {
  const secret = process.env[envName];
  return guardWebhook({
    route,
    secret,
    proof: bearerProof(secret, headers.get("authorization")),
    configure: `Set ${envName} and configure Bolna to send "Authorization: Bearer <that value>" to this URL.`,
  });
}
