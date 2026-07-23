import { createHash, randomBytes } from "node:crypto";
import type { NextRequest } from "next/server";

// Magic-link tokens for the admin "act from email" confirm page (Change 5).
// The raw token rides only in the email URL; only sha256(raw) is stored in
// nbfc_doc_requests.act_token_hash, so a DB read alone can't forge an action.
// The confirm page authenticates with the token, then the admin forwards/pushes.

export const ACT_TOKEN_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

export function generateActToken(): { rawToken: string; tokenHash: string } {
  const rawToken = randomBytes(32).toString("hex");
  return { rawToken, tokenHash: hashActToken(rawToken) };
}

export function hashActToken(rawToken: string): string {
  return createHash("sha256").update(rawToken).digest("hex");
}

export function actTokenExpiry(now: Date = new Date()): Date {
  return new Date(now.getTime() + ACT_TOKEN_TTL_MS);
}

// Absolute URL to the confirm page. Prefer the request host (auto-tracks
// localhost vs tunnel vs prod), fall back to NEXT_PUBLIC_APP_URL.
export function buildActLink(
  requestId: string,
  rawToken: string,
  req?: NextRequest | Request,
): string {
  let base = "";
  if (req) {
    const h = req.headers;
    const host = h.get("x-forwarded-host") || h.get("host") || "";
    if (host) {
      const proto =
        h.get("x-forwarded-proto") ||
        (host.startsWith("localhost") || host.startsWith("127.0.0.1")
          ? "http"
          : "https");
      base = `${proto}://${host}`;
    }
  }
  if (!base) base = (process.env.NEXT_PUBLIC_APP_URL || "").replace(/\/$/, "");
  if (!base) {
    throw new Error(
      "Cannot build act link: no request host and NEXT_PUBLIC_APP_URL is unset",
    );
  }
  return `${base.replace(/\/$/, "")}/request-action/${requestId}?token=${rawToken}`;
}
