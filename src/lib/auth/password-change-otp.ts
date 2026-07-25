import { createHash, randomInt } from "node:crypto";

// E-213 — tuning constants and helpers for the in-app Change Password OTP.
// Everything the routes, the email copy and the modal's countdown derive from
// lives here, so they cannot drift apart.

// 4 digits, as specified. Worth knowing the tradeoff: every OTHER OTP in this
// app is 6 digits, so this is a 10,000-code space rather than 1,000,000. It is
// acceptable here because this endpoint is SESSION-GATED — an attacker must
// already hold the victim's Supabase cookie to call it at all — and the
// attempt/send ladder below caps a session at 3 attempts x 3 sends per 30
// minutes, i.e. at most 9 guesses per half hour. Change this one constant to
// move to 6; generateOtp and the UI both read it.
export const OTP_LENGTH = 4;

export const OTP_TTL_MS = 10 * 60 * 1000; // 10 minutes
export const OTP_MAX_SENDS = 3;
export const OTP_SEND_COOLDOWN_MS = 30 * 60 * 1000; // after MAX_SENDS
export const OTP_RESEND_MIN_INTERVAL_MS = 30 * 1000; // stops double-click storms
export const OTP_MAX_ATTEMPTS = 3;
export const OTP_LOCK_MS = 5 * 60 * 1000; // after MAX_ATTEMPTS wrong entries

// Rows older than this are pruned opportunistically on each send, so the table
// cannot grow forever without a cron.
export const OTP_RETENTION_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

/**
 * Cryptographically-random zero-padded code.
 *
 * `randomInt`, NOT `Math.random()`. The legacy OTP paths (consent-service,
 * step-5 dispatch, calculator) all use
 * `Math.floor(100000 + Math.random() * 900000)`, whose output is predictable
 * from a handful of observed samples. src/lib/auth/reset-token.ts already uses
 * node:crypto; this follows that.
 *
 * The padStart also matters: `randomInt(0, 10**4)` + pad covers "0000".."9999",
 * whereas the legacy `Math.floor(1000 + rand*9000)` idiom silently drops every
 * code with a leading zero and shrinks the space by 10%.
 */
export function generateOtp(): string {
  return String(randomInt(0, 10 ** OTP_LENGTH)).padStart(OTP_LENGTH, "0");
}

export function hashOtp(code: string): string {
  return createHash("sha256").update(code).digest("hex");
}

export function otpExpiry(now: Date = new Date()): Date {
  return new Date(now.getTime() + OTP_TTL_MS);
}

/** Matches exactly OTP_LENGTH digits — used to reject malformed input without burning an attempt. */
export const OTP_FORMAT_RE = new RegExp(`^\\d{${OTP_LENGTH}}$`);
