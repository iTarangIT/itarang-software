/**
 * E-218 — deterministic bucket rules.
 *
 * Most spend is repeat spend. The same twenty vendors account for nearly every
 * invoice in the folder, so asking a model which bucket a Trontek bill belongs
 * to is both a cost and a risk: two runs can answer differently, and a bucket
 * that flips between scans makes the month-on-month comparison lie.
 *
 * These rules run FIRST and beat the model (see resolveBucket.ts). A vendor
 * named here always lands in the same bucket, for free, forever. The model only
 * sees what the rules could not name.
 *
 * Adding a vendor here is the cheap fix when the CEO says a bucket looks wrong —
 * cheaper than re-prompting, and it fixes every past and future invoice from
 * that vendor at once.
 */
import { type ExpenseBucket } from "@/lib/expenses";

export interface BucketRuleInput {
  vendor?: string | null;
  description?: string | null;
  project_tag?: string | null;
  /** The manual-submission category (`Travel`, `Software/SaaS`, …). */
  category?: string | null;
}

export interface BucketRuleMatch {
  bucket: ExpenseBucket;
  /** Which rule fired, for the backfill report and for debugging a wrong bucket. */
  rule: string;
}

/**
 * Vendor name fragments → bucket. Matched as a substring of the normalised
 * vendor name, so "Trontek Electronics Limited" and "TRONTEK" both hit.
 *
 * First match wins. Most fragments are disjoint so their order is irrelevant,
 * with ONE exception, called out below: the generic "electronics" catch-all is
 * broad enough to swallow consumer-electronics retailers, so the vendors it gets
 * wrong are listed ahead of it.
 */
export const VENDOR_BUCKET_RULES: ReadonlyArray<
  readonly [fragment: string, bucket: ExpenseBucket]
> = [
  // --- ORDER-DEPENDENT: these must precede the "electronics" fragment below ---
  // E-224 — "electronics" was catching retailers as raw material: a ₹24,999
  // Samsung mobile phone and two Dawntech televisions were bucketed `rm`, and
  // E-224's department rule would then have filed them under Operations. They
  // are IT hardware, which is what the tech bucket is for.
  ["samsung", "tech"],
  ["dawntech", "tech"],

  // --- Raw material / components ---
  ["trontek", "rm"],
  ["ecostar", "rm"],
  ["ampfusion", "rm"],
  ["amp fusion", "rm"],
  ["ayansh", "rm"],
  ["exide", "rm"],
  ["amaron", "rm"],
  ["livguard", "rm"],
  ["okaya", "rm"],
  ["lohum", "rm"],
  ["battery", "rm"],
  // Broad on purpose — it is the safety net for the next unnamed component
  // supplier called "X Electronics". See the order-dependent block at the top.
  ["electronics", "rm"],

  // --- Tech / SaaS / cloud ---
  ["krishai", "tech"],
  ["anthropic", "tech"],
  ["openai", "tech"],
  ["amazon web services", "tech"],
  ["aws", "tech"],
  ["google cloud", "tech"],
  ["google workspace", "tech"],
  ["microsoft", "tech"],
  ["vercel", "tech"],
  ["supabase", "tech"],
  ["upstash", "tech"],
  ["github", "tech"],
  ["atlassian", "tech"],
  ["slack", "tech"],
  ["zoho", "tech"],
  ["razorpay", "tech"],
  ["decentro", "tech"],
  ["digio", "tech"],
  ["bolna", "tech"],
  ["elevenlabs", "tech"],
  ["firecrawl", "tech"],
  ["apify", "tech"],
  ["twilio", "tech"],
  ["canva", "tech"],
  ["fireflies", "tech"],
  ["hostinger", "tech"],
  ["godaddy", "tech"],
  ["cloudflare", "tech"],
  ["figma", "tech"],
  ["notion", "tech"],
  ["technologies", "tech"],
];

/**
 * The eight manual-submission categories (api/expenses/submit/route.ts).
 * Anything not listed as Tech is running-the-business spend.
 */
export const CATEGORY_BUCKET_RULES: Readonly<Record<string, ExpenseBucket>> = {
  "software/saas": "tech",
  travel: "misc",
  office: "misc",
  marketing: "misc",
  utilities: "misc",
  "vehicle/fuel": "misc",
  "food/hospitality": "misc",
  misc: "misc",
};

/**
 * Keyword fragments matched against description + project tag, in this order.
 * `rm` is checked before `tech` because a "battery management software" line is
 * far more likely to be a component purchase in this business than a SaaS bill.
 */
export const KEYWORD_BUCKET_RULES: ReadonlyArray<
  readonly [bucket: ExpenseBucket, fragments: readonly string[]]
> = [
  [
    "rm",
    [
      "raw material",
      "battery",
      "batteries",
      "cell",
      "charger",
      "wiring",
      "harness",
      "motor",
      "controller",
      "component",
      "spare part",
      "chassis",
      "tyre",
      "bms",
    ],
  ],
  [
    "tech",
    [
      "saas",
      "subscription",
      "licence",
      "license",
      "server",
      "cloud",
      "hosting",
      "domain",
      "software",
      "api ",
      "laptop",
      "ai dialer",
      "ai dialler",
    ],
  ],
  [
    "misc",
    [
      "tax payment",
      "gst",
      "tds",
      "audit",
      "salary",
      "payroll",
      "rent",
      "electricity",
      "travel",
      "courier",
      "freight",
      "logistics",
      "stationery",
      "insurance",
      "professional fee",
    ],
  ],
];

function normalise(value: string | null | undefined): string {
  return (value ?? "").toLowerCase().replace(/\s+/g, " ").trim();
}

/**
 * Classify an expense from what is already known about it, without a model call.
 *
 * Returns `null` when nothing matched — that is the signal to fall through to
 * the classifier, not an error.
 */
export function bucketFromRules(input: BucketRuleInput): BucketRuleMatch | null {
  const vendor = normalise(input.vendor);
  if (vendor) {
    for (const [fragment, bucket] of VENDOR_BUCKET_RULES) {
      if (vendor.includes(fragment)) {
        return { bucket, rule: `vendor:${fragment}` };
      }
    }
  }

  const category = normalise(input.category);
  // 'invoice' is the placeholder every AI/Drive row carries, not a real
  // category — it says nothing, so skip it rather than mapping it to a bucket.
  if (category && category !== "invoice") {
    const bucket = CATEGORY_BUCKET_RULES[category];
    if (bucket) return { bucket, rule: `category:${category}` };
  }

  const text = normalise(
    [input.description, input.project_tag].filter(Boolean).join(" "),
  );
  if (text) {
    for (const [bucket, fragments] of KEYWORD_BUCKET_RULES) {
      for (const fragment of fragments) {
        if (text.includes(fragment)) {
          return { bucket, rule: `keyword:${fragment.trim()}` };
        }
      }
    }
  }

  return null;
}
