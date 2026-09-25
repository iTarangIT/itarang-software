/**
 * Green Energy News — pure normalisation helpers (E-306). No I/O; unit tested.
 */

import { createHash } from "node:crypto";

const TRACKING_PARAM = /^(utm_[a-z]+|fbclid|gclid|mc_cid|mc_eid|ref|source|cmpid|ncid|_hsenc|_hsmi|igshid)$/i;

/**
 * One URL per article: lowercase host, no fragment, no tracking params, no
 * trailing slash. Two feeds linking the same page with different utm tags hash
 * to the same row.
 */
export function canonicalUrl(raw: string): string {
  const trimmed = raw.trim();
  let u: URL;
  try {
    u = new URL(trimmed);
  } catch {
    return trimmed;
  }
  u.hash = "";
  u.hostname = u.hostname.toLowerCase();
  const keep: [string, string][] = [];
  u.searchParams.forEach((v, k) => {
    if (!TRACKING_PARAM.test(k)) keep.push([k, v]);
  });
  u.search = "";
  for (const [k, v] of keep) u.searchParams.append(k, v);
  if (u.pathname.length > 1 && u.pathname.endsWith("/")) u.pathname = u.pathname.slice(0, -1);
  let s = u.toString();
  // A bare origin serialises as "https://host/" — drop that slash too.
  if (u.pathname === "/" && !u.search) s = s.replace(/\/$/, "");
  return s;
}

export function urlHash(raw: string): string {
  return createHash("sha256").update(canonicalUrl(raw)).digest("hex");
}

const STOPWORDS = new Set([
  "a", "an", "the", "of", "in", "on", "at", "to", "for", "and", "or", "by", "with",
  "as", "is", "are", "was", "were", "be", "its", "it", "this", "that", "from", "into",
  "over", "after", "amid", "vs", "up", "down", "new", "says", "say", "said",
]);

/** Lowercase, punctuation-free, stopword-free, first 12 words — for near-dupes. */
export function normalizeTitle(title: string): string {
  return title
    .toLowerCase()
    .replace(/[‘’“”'"`]/g, "")
    .replace(/[^a-z0-9\s]+/g, " ")
    .split(/\s+/)
    .filter((w) => w && !STOPWORDS.has(w))
    .slice(0, 12)
    .join(" ");
}

export function titleHash(title: string): string {
  return createHash("sha256").update(normalizeTitle(title)).digest("hex");
}

const ENTITIES: Record<string, string> = {
  amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ", ndash: "–", mdash: "—",
  hellip: "…", rsquo: "’", lsquo: "‘", rdquo: "”", ldquo: "“", copy: "©", reg: "®",
};

/** Strip tags, decode common entities, collapse whitespace. */
export function stripHtml(html: string | null | undefined): string {
  if (!html) return "";
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&([a-z]+);/gi, (m, e) => ENTITIES[e.toLowerCase()] ?? m)
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Google News titles are "Headline - Publisher". Split them; leave anything
 * else alone (a headline with a dash in the middle is not a publisher).
 */
export function splitGoogleTitle(title: string): { title: string; publisher: string | null } {
  const m = title.match(/^(.*\S)\s+[-–—]\s+([^-–—]{2,60})$/);
  if (!m) return { title: title.trim(), publisher: null };
  return { title: m[1].trim(), publisher: m[2].trim() };
}

/** Cap a snippet for storage / prompts. */
export function clip(s: string, max: number): string {
  if (s.length <= max) return s;
  return s.slice(0, max - 1).replace(/\s+\S*$/, "") + "…";
}
