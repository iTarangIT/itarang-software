/**
 * 23 Nov — the signed link in a dealer-check email / WhatsApp.
 *
 * Same idea as the quotation link (./quoteToken.ts): an HMAC over
 * (review id, recipient user id) needs no storage. Single use is enforced by
 * the decision itself — decideDealerReview only writes a PENDING check — so a
 * second tap, a forwarded email or another recipient's link finds the check
 * already decided and changes nothing. The recipient must still be on the
 * Settings › Dealer check alerts list when the link is used (checked by the
 * caller), so removing someone kills their links.
 */
import { createHmac, timingSafeEqual } from "node:crypto";

const SIG_LENGTH = 32;
const PREFIX = "dc1";

function secret(): string {
  const s =
    process.env.DEALER_CHECK_TOKEN_SECRET ||
    process.env.QUOTE_TOKEN_SECRET ||
    process.env.SUPABASE_SERVICE_ROLE_KEY ||
    process.env.NEXTAUTH_SECRET;
  if (!s) throw new Error("No signing secret for dealer-check links. Set DEALER_CHECK_TOKEN_SECRET.");
  return s;
}

function sign(payload: string): string {
  return createHmac("sha256", secret()).update(payload, "utf8").digest("hex").slice(0, SIG_LENGTH);
}

export function mintDealerCheckToken(reviewId: string, userId: string): string {
  const payload = `${PREFIX}:${reviewId}:${userId}`;
  return `${Buffer.from(payload, "utf8").toString("base64url")}.${sign(payload)}`;
}

/** The (review, recipient) a token was minted for, or null when it is not ours. */
export function readDealerCheckToken(token: string | null | undefined): { reviewId: string; userId: string } | null {
  if (!token || typeof token !== "string" || token.length > 400) return null;
  const dot = token.lastIndexOf(".");
  if (dot <= 0) return null;
  let payload: string;
  try {
    payload = Buffer.from(token.slice(0, dot), "base64url").toString("utf8");
  } catch {
    return null;
  }
  const m = /^dc1:([0-9a-f-]{36}):([0-9a-f-]{36})$/i.exec(payload);
  if (!m) return null;
  const given = Buffer.from(token.slice(dot + 1), "utf8");
  let expected: Buffer;
  try {
    expected = Buffer.from(sign(payload), "utf8");
  } catch {
    return null;
  }
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) return null;
  return { reviewId: m[1], userId: m[2] };
}

export function dealerCheckActionUrl(token: string): string {
  const base = (process.env.APP_URL || process.env.NEXT_PUBLIC_APP_URL || "https://crm.itarang.com").replace(/\/+$/, "");
  return `${base}/dealer-check-action/${encodeURIComponent(token)}`;
}
