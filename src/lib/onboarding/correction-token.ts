import { createHash, randomBytes } from "node:crypto";
import type { NextRequest } from "next/server";

// Magic-link tokens for the dealer correction form.
// We hand out the raw token in email exactly once. Only sha256(rawToken) is
// stored in dealer_correction_rounds.token_hash, so a DB compromise alone
// can't impersonate a dealer.

export const CORRECTION_TOKEN_TTL_MS = 14 * 24 * 60 * 60 * 1000; // 14 days

export function generateCorrectionToken(): { rawToken: string; tokenHash: string } {
  const rawToken = randomBytes(32).toString("hex");
  return { rawToken, tokenHash: hashCorrectionToken(rawToken) };
}

export function hashCorrectionToken(rawToken: string): string {
  return createHash("sha256").update(rawToken).digest("hex");
}

export function correctionTokenExpiry(now: Date = new Date()): Date {
  return new Date(now.getTime() + CORRECTION_TOKEN_TTL_MS);
}

// Derive the absolute URL the dealer should click. Order of preference:
//   1. The host the admin is currently on (x-forwarded-host / host header) —
//      this auto-tracks localhost vs ngrok vs Vercel without env-var drift.
//   2. NEXT_PUBLIC_APP_URL — fallback for cron jobs / cases where no request
//      object is available.
// If both fail we throw — better to surface the bug than ship an email with a
// half-baked relative URL.
export function buildCorrectionLink(rawToken: string, req?: NextRequest | Request): string {
  let base = "";

  if (req) {
    const headers = req.headers;
    const forwardedHost = headers.get("x-forwarded-host");
    const host = forwardedHost || headers.get("host") || "";
    if (host) {
      const forwardedProto = headers.get("x-forwarded-proto");
      const proto =
        forwardedProto ||
        (host.startsWith("localhost") || host.startsWith("127.0.0.1")
          ? "http"
          : "https");
      base = `${proto}://${host}`;
    }
  }

  if (!base) {
    base = (process.env.NEXT_PUBLIC_APP_URL || "").replace(/\/$/, "");
  }

  if (!base) {
    throw new Error(
      "Cannot build correction link: no request host and NEXT_PUBLIC_APP_URL is unset",
    );
  }

  return `${base.replace(/\/$/, "")}/onboarding/correct/${rawToken}`;
}
