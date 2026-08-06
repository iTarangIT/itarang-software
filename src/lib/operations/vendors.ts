/**
 * Canonical vendor identity.
 *
 * The spend module has two independent halves that are supposed to agree:
 *
 *   metered — what we consumed, from our own tables (ai_call_logs,
 *             kyc_verifications, whatsapp_messages…), keyed by a code-level
 *             provider string like "elevenlabs";
 *   billed  — what we were actually invoiced, from expense_submissions, keyed
 *             by whatever the invoice's legal entity is called: "Eleven Labs
 *             Inc.", "Anthropic, PBC", "DIGIOTECH SOLUTIONS PRIVATE LIMITED".
 *
 * Those two never join on their own. This file is the one place that maps both
 * onto a single slug so the reconciliation table can put them side by side.
 *
 * DESIGN RULE: an unrecognised vendor is never dropped. It falls through to a
 * slug of its own name and renders as "unmatched" — a reconciliation table that
 * silently omits the invoice it cannot classify is worse than no table, because
 * the total stops adding up and nobody can tell why.
 */

export interface VendorDef {
  /** Canonical slug. Becomes the sample `source`, e.g. "vendor:elevenlabs". */
  id: string;
  label: string;
  /**
   * Normalised substrings that identify this vendor on an invoice. Matched
   * against normaliseVendorName(), so write them lowercase and without the
   * corporate suffixes that function strips.
   */
  match: string[];
  /** Where the metered half of this vendor's numbers comes from, if anywhere. */
  meteredFrom?: string;
}

/**
 * Every vendor we can name. Ordering matters only for readability — matching is
 * longest-substring-wins so that e.g. "google cloud" cannot be stolen by a
 * shorter "google" entry defined earlier.
 */
export const VENDORS: VendorDef[] = [
  {
    id: "elevenlabs",
    label: "ElevenLabs",
    match: ["eleven labs", "elevenlabs"],
    meteredFrom: "ai_call_logs (provider='elevenlabs')",
  },
  {
    id: "bolna",
    label: "Bolna",
    match: ["bolna"],
    meteredFrom: "ai_call_logs (provider='bolna')",
  },
  { id: "anthropic", label: "Anthropic", match: ["anthropic"] },
  { id: "openai", label: "OpenAI", match: ["openai", "open ai"] },
  { id: "google", label: "Google Cloud / Gemini", match: ["google"] },
  {
    id: "decentro",
    label: "Decentro",
    match: ["decentro"],
    meteredFrom: "kyc_verifications (api_provider like 'decentro%')",
  },
  {
    id: "digio",
    label: "DigiO",
    match: ["digio", "digiotech"],
    meteredFrom: "kyc_verifications (api_provider='digio')",
  },
  {
    id: "razorpay",
    label: "Razorpay / RazorpayX",
    match: ["razorpay"],
    meteredFrom: "facilitation_payments + emi_payment_attempts + buyback_gateway_transactions",
  },
  {
    id: "zoho",
    label: "Zoho",
    match: ["zoho"],
    meteredFrom: "zoho_invoices",
  },
  {
    id: "meta",
    label: "Meta WhatsApp",
    match: ["meta platforms", "whatsapp"],
    meteredFrom: "whatsapp_messages",
  },
  { id: "haptik", label: "Jio Haptik", match: ["haptik"] },
  { id: "neodove", label: "NeoDove", match: ["neodove"] },
  { id: "firecrawl", label: "Firecrawl", match: ["firecrawl"] },
  { id: "apify", label: "Apify", match: ["apify"] },
  { id: "aws", label: "AWS", match: ["amazon web services", "aws"] },
  { id: "vercel", label: "Vercel", match: ["vercel"] },
  { id: "supabase", label: "Supabase", match: ["supabase"] },
  { id: "upstash", label: "Upstash", match: ["upstash"] },
  { id: "github", label: "GitHub", match: ["github"] },
  { id: "cloudflare", label: "Cloudflare", match: ["cloudflare"] },
  { id: "hostinger", label: "Hostinger", match: ["hostinger"] },
  { id: "cibil", label: "CIBIL / Equifax", match: ["cibil", "transunion", "equifax"] },
];

/**
 * Strip an invoice entity name down to something matchable.
 *
 * Real values this has to cope with, straight from expense_submissions:
 * "Eleven Labs Inc.", "Anthropic, PBC", "Hostinger PTE",
 * "DIGIOTECH SOLUTIONS PRIVATE LIMITED", "Jio Haptik Technologies Limited".
 * The corporate suffix carries no information and differs per jurisdiction, so
 * it goes.
 */
export function normaliseVendorName(raw: string): string {
  return raw
    .toLowerCase()
    .replace(/[.,()]/g, " ")
    .replace(
      /\b(private limited|pvt\.? ?ltd|pvt|ltd|limited|llp|inc|incorporated|corp|corporation|co|company|gmbh|pte|plc|pbc|technologies|technology|solutions|systems|services|enterprises)\b/g,
      " ",
    )
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Lowercase and de-punctuate only — suffixes left intact.
 *
 * Needed alongside the aggressive form because the "corporate noise" list is
 * not noise for every vendor: stripping "services" turns "Amazon Web Services"
 * into "amazon web", so a pattern written as the vendor's actual name could
 * never match. Candidates are tested against BOTH forms.
 */
function lightlyNormalise(raw: string): string {
  return raw
    .toLowerCase()
    .replace(/[.,()]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

const BY_ID = new Map(VENDORS.map((v) => [v.id, v]));

/**
 * Resolve any vendor string — an invoice entity or a code-level provider — to a
 * canonical slug.
 *
 * Longest match wins. Without that, "google" would claim "Google Cloud" before
 * a more specific entry ever got a chance, and the first-defined vendor would
 * quietly absorb its neighbours.
 */
export function canonicalVendor(
  raw: string | null | undefined,
): { id: string; label: string; matched: boolean } | null {
  if (!raw || !raw.trim()) return null;

  // A code-level provider string is already canonical.
  const direct = BY_ID.get(raw.trim().toLowerCase());
  if (direct) return { id: direct.id, label: direct.label, matched: true };

  const normalised = normaliseVendorName(raw);
  const light = lightlyNormalise(raw);
  if (!normalised) return null;

  let best: VendorDef | null = null;
  let bestLength = 0;
  for (const vendor of VENDORS) {
    for (const needle of vendor.match) {
      // Either form may carry the match — see lightlyNormalise() for why the
      // aggressive one alone is not enough.
      const hit = normalised.includes(needle) || light.includes(needle);
      if (hit && needle.length > bestLength) {
        best = vendor;
        bestLength = needle.length;
      }
    }
  }

  if (best) return { id: best.id, label: best.label, matched: true };

  // Unrecognised: keep it, under a slug of its own name. See the design rule
  // at the top of this file — dropping it would break the totals.
  return {
    id: normalised.replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 40),
    label: raw.trim().slice(0, 60),
    matched: false,
  };
}

export function vendorLabel(id: string): string {
  return BY_ID.get(id)?.label ?? id;
}

export function vendorDef(id: string): VendorDef | undefined {
  return BY_ID.get(id);
}
