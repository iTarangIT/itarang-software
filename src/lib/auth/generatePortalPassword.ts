/**
 * The password iTarang mints for a portal account it creates on someone's
 * behalf — an NBFC partner at activation (E-002), an NBFC sub-user invite, a
 * scrap vendor onboarded by an admin (E-223).
 *
 * Extracted because it was defined THREE times before this file existed, once
 * per consumer, byte-identical. A password generator silently drifting between
 * copies is the kind of bug nobody finds until an audit.
 *
 * NOT `generateTemporaryPassword.ts` — that one is `Math.random()`, which is
 * not cryptographically random. Anything new should use this.
 */

import { randomInt } from "node:crypto";

// Ambiguous glyphs (I, O, l, o, 0, 1) are excluded from every pool: these
// passwords get read off a screen and typed by hand, and "was that an l or a
// 1" turns into a support ticket.
const PWD_UPPER = "ABCDEFGHJKLMNPQRSTUVWXYZ";
const PWD_LOWER = "abcdefghjkmnpqrstuvwxyz";
const PWD_DIGIT = "23456789";
const PWD_SYMBOL = "!@#$%^&*-_=+";
const PWD_ALL = PWD_UPPER + PWD_LOWER + PWD_DIGIT + PWD_SYMBOL;

function pickFrom(set: string): string {
  return set[randomInt(0, set.length)];
}

/**
 * High-entropy password: 20 characters, drawn from upper/lower/digit/symbol
 * pools so every category is represented at least once. Returns >= 16 chars
 * per non_functional rule.
 */
export function generatePortalPassword(): string {
  const chars: string[] = [
    pickFrom(PWD_UPPER),
    pickFrom(PWD_LOWER),
    pickFrom(PWD_DIGIT),
    pickFrom(PWD_SYMBOL),
  ];
  for (let i = chars.length; i < 20; i++) chars.push(pickFrom(PWD_ALL));
  // Shuffle (Fisher-Yates) using crypto random. Without this the first four
  // characters would always be upper/lower/digit/symbol in that order.
  for (let i = chars.length - 1; i > 0; i--) {
    const j = randomInt(0, i + 1);
    [chars[i], chars[j]] = [chars[j], chars[i]];
  }
  return chars.join("");
}
