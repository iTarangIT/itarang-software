import { createHash, randomBytes } from "node:crypto";
import type { NextRequest } from "next/server";
import { publicOrigin } from "@/lib/public-origin";

// E-212 — single-use password-reset tokens for the "Forgot password?" flow.
// Same shape as src/lib/nbfc/act-token.ts: the raw token rides only in the
// emailed URL, and only sha256(raw) is stored in
// password_reset_tokens.token_hash, so a DB read alone cannot forge a reset.

// 30 minutes. act-token.ts uses 7 days, but that token is NOT a sole
// authenticator — the act route still calls requireAdminAppUser. A reset token
// IS the sole authenticator: whoever holds it takes over the account, and this
// app's accounts include ceo, admin and finance_controller. 30 min keeps the
// window in which a forwarded/leaked email URL is dangerous down to half an
// hour while still leaving room for mail delivery latency. If deliverability
// turns out poor (see sendPasswordResetEmail's note on the AgentMail sender),
// raise THIS constant rather than weakening anything else — the email copy and
// the expiry error copy both derive from it, so they cannot drift.
export const PASSWORD_RESET_TTL_MS = 30 * 60 * 1000;

// Per-account throttle, enforced against password_reset_tokens itself (durable
// and shared, unlike the per-IP limiter in ./reset-throttle).
export const RESET_MIN_INTERVAL_MS = 60 * 1000; // min gap between two requests
export const RESET_WINDOW_MS = 15 * 60 * 1000; // rolling window
export const RESET_MAX_PER_WINDOW = 3;

// Rows older than this are pruned opportunistically on each new request, so the
// table cannot grow forever without a cron.
export const RESET_RETENTION_MS = 30 * 24 * 60 * 60 * 1000; // 30 days

export function generateResetToken(): { rawToken: string; tokenHash: string } {
  const rawToken = randomBytes(32).toString("hex");
  return { rawToken, tokenHash: hashResetToken(rawToken) };
}

export function hashResetToken(rawToken: string): string {
  return createHash("sha256").update(rawToken).digest("hex");
}

export function resetTokenExpiry(now: Date = new Date()): Date {
  return new Date(now.getTime() + PASSWORD_RESET_TTL_MS);
}

/**
 * Absolute URL of the reset page.
 *
 * Deliberately uses publicOrigin() — which puts NEXT_PUBLIC_APP_URL FIRST and
 * rejects ngrok/localhost hosts in production-like envs — rather than
 * act-token.ts's request-host-first order. This flow mails a real person, and
 * .env.local points DATABASE_URL at the SHARED database-1 RDS while
 * NEXT_PUBLIC_APP_URL is localhost:3000. Without this precedence a developer
 * who typed a real user's address would mail that user a dead localhost (or
 * worse, an ephemeral tunnel) link. Throws PublicOriginError if nothing safe
 * is available — callers must treat that as "do not send".
 */
export function buildResetLink(rawToken: string, req?: NextRequest): string {
  const base = publicOrigin(req ? { req } : {}).replace(/\/$/, "");
  return `${base}/reset-password?token=${rawToken}`;
}

/**
 * "anirudh@itarang.com" → "a*****h@itarang.com". Shown on the reset page so the
 * user can confirm WHICH account they are resetting without the page becoming
 * an address-disclosure surface.
 */
export function maskEmail(email: string): string {
  const at = email.lastIndexOf("@");
  if (at <= 0) return "•••";
  const local = email.slice(0, at);
  const domain = email.slice(at);
  if (local.length <= 2) return `${local[0]}•${domain}`;
  return `${local[0]}${"•".repeat(Math.min(local.length - 2, 6))}${local[local.length - 1]}${domain}`;
}
