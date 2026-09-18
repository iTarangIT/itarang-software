/**
 * E-297 — the pure half of Quotation CC. No database import, so it is
 * unit-testable (src/lib/leads/__tests__/quotationCc.test.ts); the I/O half
 * lives in ./quotationCc.ts and re-exports these.
 */

/** Hard cap on per-send extra CC addresses (the send route enforces it too). */
export const MAX_EXTRA_CC = 10;
/** Hard cap on the admin fixed list. */
export const MAX_FIXED_CC = 50;

// Deliberately loose: one @, something either side, a dot in the domain. The
// route validates extras with zod's .email(); this only has to keep obvious
// junk (blank strings, names typed into the list) out of a mail header.
const EMAIL_RE = /^[^\s@,;<>]+@[^\s@,;<>]+\.[^\s@,;<>]+$/;

export function isPlausibleEmail(raw: unknown): raw is string {
  return typeof raw === "string" && EMAIL_RE.test(raw.trim());
}

export interface BuildCcListInput {
  ownerEmail?: string | null;
  /** Whoever is pressing Send — B4 replaced the quote APPROVER with this. */
  actorEmail?: string | null;
  fixed?: readonly (string | null | undefined)[] | null;
  extra?: readonly (string | null | undefined)[] | null;
  /** The TO address. Never CC'd back to itself. */
  dealerEmail?: string | null;
}

/**
 * Owner, actor, fixed list, extras — in that order — trimmed, validated,
 * deduped case-insensitively (first spelling wins) and with the dealer's own
 * address removed. Inactive users are filtered before this is called: an
 * inactive owner arrives here as null.
 *
 * B4 (2026-09-18): the quote APPROVER is no longer a CC rule. Approvals are
 * mostly the CEO's, and copying that login on every quotation was the
 * behaviour business asked to remove; the people who should always see a
 * quote go out are now named in the admin fixed list instead.
 */
export function buildCcList(input: BuildCcListInput): string[] {
  const dealerKey = (input.dealerEmail ?? "").trim().toLowerCase();
  const seen = new Set<string>();
  const out: string[] = [];

  const candidates = [
    input.ownerEmail,
    input.actorEmail,
    ...(input.fixed ?? []),
    ...(input.extra ?? []),
  ];

  for (const raw of candidates) {
    if (!isPlausibleEmail(raw)) continue;
    const email = raw.trim();
    const key = email.toLowerCase();
    if (key === dealerKey || seen.has(key)) continue;
    seen.add(key);
    out.push(email);
  }
  return out;
}

/**
 * Normalise whatever is stored (or PUT) as the fixed list: accepts an array or
 * a comma/semicolon/newline-separated string, drops invalid entries, dedupes
 * case-insensitively, caps at MAX_FIXED_CC. Never throws.
 */
export function normalizeCcEmails(raw: unknown): string[] {
  let items: unknown[] = [];
  if (Array.isArray(raw)) items = raw;
  else if (typeof raw === "string") items = raw.split(/[\s,;]+/);

  const seen = new Set<string>();
  const out: string[] = [];
  for (const item of items) {
    if (!isPlausibleEmail(item)) continue;
    const email = item.trim();
    const key = email.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(email);
    if (out.length >= MAX_FIXED_CC) break;
  }
  return out;
}
