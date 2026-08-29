/**
 * Grouping log lines that are "the same error".
 *
 * One bug repeated 10,000 times is one problem; ten distinct new ones are ten.
 * A log explorer that cannot tell those apart is a wall of text — and this
 * codebase already learned that lesson expensively (see src/lib/log.ts: a
 * single repeated stack trace produced a 60 GB log file and filled a disk).
 *
 * The fingerprint is a hash of service + level + the message with its volatile
 * parts removed, so `user 41ab-… not found` and `user 92cd-… not found` land in
 * the same group while genuinely different errors stay apart.
 *
 * STABILITY MATTERS. The fingerprint is stored on every row; changing the
 * normalisation rules re-buckets history, so old rows group by the old rules
 * and new rows by the new ones. Treat this file as append-only in spirit: add a
 * rule only when the grouping is visibly wrong, and expect a discontinuity in
 * the "top errors" table on the day it ships.
 */

import { createHash } from "node:crypto";

/** Longest message we hash or store. Matches the ingest route's truncation. */
export const MAX_MESSAGE_CHARS = 2000;

/**
 * Strip the parts of a message that differ between occurrences of one error.
 *
 * Order matters: the more specific patterns run first, so a UUID is replaced as
 * a UUID rather than being chewed up by the generic number rule.
 */
export function normaliseMessage(message: string): string {
  return (
    message
      .slice(0, MAX_MESSAGE_CHARS)
      // ISO-8601 and the `YYYY/MM/DD HH:MM:SS` form nginx uses.
      .replace(
        /\d{4}[-/]\d{2}[-/]\d{2}[T ]\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:?\d{2})?/g,
        "<ts>",
      )
      .replace(/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi, "<uuid>")
      // IPs before the number rule, or they become <n>.<n>.<n>.<n>.
      .replace(/\b\d{1,3}(?:\.\d{1,3}){3}(?::\d+)?\b/g, "<ip>")
      // Long hex runs: request ids, commit SHAs, hashes.
      .replace(/\b[0-9a-f]{8,}\b/gi, "<hex>")
      // Any remaining number, including decimals and negatives. This is what
      // collapses "took 1423ms" / "took 91ms" and "route.ts:88:12".
      //
      // Leading \b only, deliberately NO trailing one. A number followed by a
      // unit has no word boundary after it ("1423ms" — "3" and "m" are both
      // word characters), so requiring one meant every timing line stayed
      // ungrouped. The leading boundary is what still protects identifiers
      // that merely contain digits: "utf8", "sha256" and "ipv4" have no
      // boundary before their digits and survive intact.
      .replace(/-?\b\d+(?:\.\d+)?/g, "<n>")
      // Whitespace last: the replacements above can leave doubled spaces.
      .replace(/\s+/g, " ")
      .trim()
      .toLowerCase()
  );
}

/**
 * Stable 64-char hex id for a log line's group.
 *
 * sha256 hex is exactly 64 characters, which is exactly
 * ops_log_events.fingerprint's width — no truncation, no collision surface
 * beyond sha256's own.
 */
export function fingerprint(
  service: string,
  level: string,
  message: string,
): string {
  return createHash("sha256")
    .update(
      `${service.trim().toLowerCase()}|${level.trim().toLowerCase()}|${normaliseMessage(message)}`,
    )
    .digest("hex");
}

/** Levels the console understands. Anything else is filed as "info". */
const KNOWN_LEVELS = new Set(["error", "warn", "info"]);

/**
 * Coerce whatever the agent sent into one of the three stored levels.
 *
 * Agents parse level out of free-form log text, so this sees "ERROR", "warning",
 * "err", "crit", "fatal" and worse. Mapping here rather than at each producer
 * means the UI's level filter has exactly three options forever.
 */
export function normaliseLevel(level: string): "error" | "warn" | "info" {
  const raw = level.trim().toLowerCase();
  if (KNOWN_LEVELS.has(raw)) return raw as "error" | "warn" | "info";
  if (/^(err|fatal|crit|alert|emerg|panic)/.test(raw)) return "error";
  if (/^(warn|notice)/.test(raw)) return "warn";
  return "info";
}
