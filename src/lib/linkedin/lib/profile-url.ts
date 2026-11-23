/**
 * LinkedIn profile URL normalisation — the dedupe key (acceptance test 6).
 * "https://in.linkedin.com/in/Asha-Rao-12ab/?trk=x" → slug "asha-rao-12ab",
 * url "https://www.linkedin.com/in/asha-rao-12ab". Pure.
 */

export type ProfileKey = { profileId: string; publicUrl: string };

export function normaliseProfileUrl(input: string | null | undefined): ProfileKey | null {
  const raw = (input ?? "").trim();
  if (!raw) return null;
  let url: URL;
  try {
    url = new URL(/^https?:\/\//i.test(raw) ? raw : `https://${raw}`);
  } catch {
    return null;
  }
  if (!/(^|\.)linkedin\.com$/i.test(url.hostname)) return null;
  const m = /^\/(?:in|pub)\/([^/?#]+)/i.exec(url.pathname);
  if (!m) return null;
  let slug: string;
  try {
    slug = decodeURIComponent(m[1]);
  } catch {
    slug = m[1];
  }
  slug = slug.trim().toLowerCase();
  if (!slug) return null;
  return { profileId: slug, publicUrl: `https://www.linkedin.com/in/${encodeURIComponent(slug)}` };
}

/** "Asha Rao - Fleet Manager - Zippee | LinkedIn" → parts, for search-result titles. */
export function parseLinkedInTitle(title: string | null | undefined): {
  fullName: string | null;
  headline: string | null;
  company: string | null;
} {
  const t = (title ?? "").replace(/\s*[|–-]\s*LinkedIn\s*$/i, "").trim();
  if (!t) return { fullName: null, headline: null, company: null };
  const parts = t.split(/\s+[-–|]\s+/).map((p) => p.trim()).filter(Boolean);
  return {
    fullName: parts[0] ?? null,
    headline: parts[1] ?? null,
    company: parts[2] ?? null,
  };
}
