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

/** The site-restricted query. Exported for tests. */
export function discoveryQuery(input: Pick<SearchInput, "keywords" | "location" | "company">): string {
  const parts = [`site:linkedin.com/in`, input.keywords.trim()];
  if (input.company?.trim()) parts.push(`"${input.company.trim()}"`);
  if (input.location?.trim()) parts.push(input.location.trim());
  return parts.join(" ");
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
    body: JSON.stringify({ query: discoveryQuery(input), limit, sources: [{ type: "web" }] }),
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
