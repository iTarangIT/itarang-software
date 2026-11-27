/**
 * Step 1 of the two-step search path (doc §3.2, spike S1 fallback): find
 * LinkedIn profile URLs for keywords with a web search, using the CRM's
 * existing Firecrawl key. Bright Data then enriches the URLs.
 */
import { firecrawlKey } from "../../credentials";
import { normaliseProfileUrl, parseLinkedInTitle } from "../../lib/profile-url";
import { firstNameOf } from "../../lib/render-template";
import { ProviderNotConfiguredError, type ProfileRecord, type SearchInput } from "./types";

type WebHit = { url?: string; title?: string; description?: string };

type QueryInput = Pick<
  SearchInput,
  "keywords" | "location" | "company" | "country" | "state" | "city" | "title" | "industry" | "exclude" | "match"
>;

const clean = (v: string | null | undefined) => (v ?? "").replace(/["]/g, "").replace(/\s+/g, " ").trim();

/** "kirana, , used cars" → ["kirana", "used cars"]. Pure. */
export function splitList(v: string | null | undefined): string[] {
  return (v ?? "")
    .split(",")
    .map((w) => clean(w))
    .filter(Boolean);
}

/**
 * The site-restricted web-search query. Exported for tests.
 *
 * The search engine ranks by relevance, so every term is "fuzzy" unless it is
 * quoted. Broad: company stays quoted (as before), everything else plain.
 * Strict: company, title, city, state are exact phrases. Exclude words are
 * always `-"word"`. Country is always plain (it narrows, it does not exclude).
 */
export function discoveryQuery(input: QueryInput): string {
  const strict = input.match === "strict";
  const phrase = (v: string) => (strict ? `"${v}"` : v);
  const parts = [`site:linkedin.com/in`, clean(input.keywords)];
  const title = clean(input.title);
  const company = clean(input.company);
  const city = clean(input.city) || clean(input.location);
  const state = clean(input.state);
  const industry = clean(input.industry);
  const country = clean(input.country);
  if (title) parts.push(phrase(title));
  if (company) parts.push(`"${company}"`);
  if (industry) parts.push(industry);
  if (city) parts.push(phrase(city));
  if (state) parts.push(phrase(state));
  if (country) parts.push(country);
  for (const w of splitList(input.exclude)) parts.push(w.includes(" ") ? `-"${w}"` : `-${w}`);
  return parts.filter(Boolean).join(" ");
}

/** Countries offered on the Search screen → ISO code for the search engine's geo-targeting. */
export const SEARCH_COUNTRIES: Record<string, string> = {
  India: "IN",
  "United Arab Emirates": "AE",
  Singapore: "SG",
  "United Kingdom": "GB",
  "United States": "US",
};

/** Firecrawl `location` / `country` body fields for a search. Pure; exported for tests. */
// Country only: a free-typed city is not a canonical search-engine location
// name and could be rejected, so city / state stay in the query text instead.
export function geoTarget(input: Pick<SearchInput, "country">): { location?: string; country?: string } {
  const country = clean(input.country);
  const code = SEARCH_COUNTRIES[country];
  if (!country || !code) return {};
  return { location: country, country: code };
}

/** Web hits → profile records (deduped by slug). Pure; exported for tests. */
export function hitsToProfiles(hits: WebHit[]): ProfileRecord[] {
  const seen = new Set<string>();
  const out: ProfileRecord[] = [];
  for (const h of hits) {
    const key = normaliseProfileUrl(h.url);
    if (!key || seen.has(key.profileId)) continue;
    seen.add(key.profileId);
    const t = parseLinkedInTitle(h.title);
    out.push({
      profileUrl: key.publicUrl,
      fullName: t.fullName,
      firstName: firstNameOf(t.fullName),
      headline: t.headline,
      company: t.company,
      city: null,
      raw: { source: "web_search", title: h.title ?? null, description: h.description ?? null },
    });
  }
  return out;
}

export async function discoverProfiles(input: SearchInput): Promise<ProfileRecord[]> {
  const key = firecrawlKey();
  if (!key) throw new ProviderNotConfiguredError("No Firecrawl key on this server (SCRAPPER_API_KEY or FIRECRAWL_API_KEY) — profile discovery is off.");
  const limit = Math.min(Math.max(input.limit ?? 25, 1), 100);
  const res = await fetch("https://api.firecrawl.dev/v2/search", {
    method: "POST",
    headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      query: discoveryQuery(input),
      limit,
      sources: [{ type: "web" }],
      // Geo-targets the search engine itself (results as seen from that country).
      ...geoTarget(input),
    }),
    signal: AbortSignal.timeout(45_000),
  });
  if (!res.ok) {
    const text = await res.text();
    if (res.status === 402) {
      const resets = /"resets_at"\s*:\s*"([^"]+)"/.exec(text)?.[1];
      const when = resets ? ` Credits reset ${new Date(resets).toLocaleString("en-IN", { timeZone: "Asia/Kolkata" })} IST.` : "";
      throw new Error(`Profile discovery failed: the Firecrawl key has no credits left.${when} Top it up or set SCRAPPER_API_KEY to a key with credits.`);
    }
    throw new Error(`Profile discovery failed: Firecrawl ${res.status} ${text.slice(0, 200)}`);
  }
  const body = (await res.json()) as { data?: { web?: WebHit[] } | WebHit[] };
  const hits = Array.isArray(body.data) ? body.data : (body.data?.web ?? []);
  return hitsToProfiles(hits);
}
