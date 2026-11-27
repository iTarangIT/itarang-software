/**
 * Post-search filtering for the Search screen's "Strict" match mode. Pure.
 *
 * The web search ranks by relevance, so a "Pune" search can still return a
 * Mumbai profile. In strict mode each filled-in field must appear (case-
 * insensitive substring) in the text we hold for the profile: name / headline /
 * company / city, plus the search-result title + snippet (discovery) or the
 * Bright Data record's location / position / experience (enrichment).
 * Exclude words drop a profile in BOTH modes.
 */
import { splitList } from "../providers/search/discovery";
import type { ProfileRecord } from "../providers/search/types";

export type MatchFilters = {
  match?: "broad" | "strict" | null;
  title?: string | null;
  company?: string | null;
  city?: string | null;
  location?: string | null; // legacy city / region
  state?: string | null;
  exclude?: string | null;
};

const norm = (v: unknown) => (typeof v === "string" ? v.toLowerCase().replace(/\s+/g, " ").trim() : "");

/** Every bit of text we know about a profile, lower-cased, for substring checks. */
export function profileText(r: Pick<ProfileRecord, "fullName" | "headline" | "company" | "city" | "raw">): string {
  const parts: unknown[] = [r.fullName, r.headline, r.company, r.city];
  const raw = r.raw && typeof r.raw === "object" ? (r.raw as Record<string, unknown>) : null;
  if (raw) {
    for (const k of ["title", "description", "location", "city", "position", "headline", "about", "country_code", "current_company_name"]) {
      parts.push(raw[k]);
    }
    const cc = raw.current_company as Record<string, unknown> | undefined;
    if (cc && typeof cc === "object") parts.push(cc.name);
    if (Array.isArray(raw.experience)) {
      for (const e of raw.experience.slice(0, 3)) {
        if (e && typeof e === "object") {
          const x = e as Record<string, unknown>;
          parts.push(x.title, x.company, x.location);
        }
      }
    }
  }
  return parts.map(norm).filter(Boolean).join(" | ");
}

export type MatchResult = { ok: true } | { ok: false; reason: string };

export function matchesFilters(
  r: Pick<ProfileRecord, "fullName" | "headline" | "company" | "city" | "raw">,
  f: MatchFilters,
): MatchResult {
  const text = profileText(r);
  for (const w of splitList(f.exclude)) {
    if (text.includes(w.toLowerCase())) return { ok: false, reason: `mentions "${w}"` };
  }
  if (f.match !== "strict") return { ok: true };
  const checks: [string, string | null | undefined][] = [
    ["title", f.title],
    ["company", f.company],
    ["city", f.city || f.location],
    ["state", f.state],
  ];
  for (const [label, value] of checks) {
    const v = norm(value);
    if (v && !text.includes(v)) return { ok: false, reason: `${label} is not "${value}"` };
  }
  return { ok: true };
}
