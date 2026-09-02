/**
 * What counts as Tech Spend.
 *
 * THE PROBLEM THIS SOLVES. /operations/spend reads
 * `expense_submissions WHERE bucket = 'tech' AND status = 'approved'`. Nothing
 * in this repository writes `bucket` — the rows arrive already carrying
 * `bucket_source` values of 'rule' and 'ai' from a process that lives outside
 * it. Both of those classifiers are demonstrably wrong on real rows:
 *
 *   bucket_source = 'rule' appears to key on the vendor's legal name, so
 *     "ITARANG TECHNOLOGIES LLP" — OUR OWN ENTITY — is filed as tech for a
 *     line described "GST Payment". Across three spellings of ourselves that is
 *     ₹1,79,706 of statutory payments sitting in the technology run-rate.
 *     "Info Edge (India) Ltd" (Naukri, recruitment) arrives the same way.
 *
 *   bucket_source = 'ai' is an unvalidated model guess. extractInvoice.ts
 *     returns a `department_confidence` that no caller reads, and the row is
 *     inserted already approved. "Kartik Aggarwal — Consultation services",
 *     ₹1,95,390, arrived through that path.
 *
 * Since the misclassification cannot be corrected at its source from here, this
 * module corrects the READ. It can only ever narrow `bucket = 'tech'`, never
 * widen it, so no invoice can be invented — and every exclusion carries a
 * machine-readable reason that the page itemises on screen. An exclusion nobody
 * can see is indistinguishable from a bug.
 *
 * SCOPE: software, SaaS, cloud and paid APIs. Hardware, telecom lines,
 * recruitment, statutory payments and individual consultants are excluded even
 * when they are genuinely technology-adjacent, because "monthly tech burn" is
 * being read as a recurring run-rate and a one-off laptop purchase is not one.
 *
 * RULES KEY ON VENDOR IDENTITY AND DESCRIPTION — never on an invoice id, an
 * amount or a month. Hardcoding "exclude invoice #4471" would fix this month's
 * chart and silently rot; these rules generalise to invoices that do not exist
 * yet, which is the only property that makes them worth having.
 *
 * Pure: no database, no I/O. Covered by __tests__/techSpendRules.test.ts.
 */

import { canonicalVendor, vendorDef } from "./vendors";

/** Why a row is in, or out. Rendered to the operator verbatim. */
export type TechSpendReason =
  | "known-software-vendor"
  | "software-vendor-name"
  | "software-description"
  | "own-entity"
  | "statutory"
  | "recruitment"
  | "hardware-retail"
  | "telecom"
  | "training"
  | "professional-services"
  | "individual-consultant"
  | "unclassified";

export interface TechSpendVerdict {
  include: boolean;
  reason: TechSpendReason;
  /** One line an operator can act on, naming what matched. */
  explanation: string;
}

export interface ClassifiableExpense {
  vendor: string | null;
  description: string | null;
}

/**
 * Our own legal entity, in every spelling that appears in the data:
 * "iTarang Technologies LLP", "ITARANG TECHNOLOGIES LLP",
 * "Itarang Technologies Llp".
 *
 * An invoice from ourselves is not a purchase from a technology vendor — it is
 * an inter-entity transfer or a statutory payment filed under our own name. The
 * out-of-repo rule buckets these as tech because the entity name contains
 * "TECHNOLOGIES", which is exactly the failure mode that makes a name-substring
 * classifier unsafe.
 */
const OWN_ENTITY = /\bitarang\b/;

/**
 * Statutory and tax payments. Never technology spend regardless of who the
 * counterparty is or what their name contains.
 */
const STATUTORY = [
  "gst payment",
  "gst paid",
  "gstr",
  "tds payment",
  "tds paid",
  "tds deposit",
  // The literal description on the real ₹15,000 row.
  "tds/tcs",
  "payable by taxpayer",
  "income tax",
  "advance tax",
  "professional tax",
  "roc filing",
  "mca filing",
  "challan",
];

/** Recruitment and job boards. Naukri/Info Edge is the live example. */
const RECRUITMENT_VENDORS = ["info edge", "naukri", "linkedin", "indeed", "shine"];
const RECRUITMENT_TERMS = ["job posting", "recruitment", "resume database", "hiring"];

/**
 * Consumer-electronics and general retail. Real rows: "Vijay Sales (India) Pvt.
 * Ltd." ₹58,050 and "Samsung India Electronics Pvt. Ltd." ₹24,999.
 *
 * These are capital purchases, not a run-rate. Mixing a one-off device into a
 * monthly burn chart makes the month it lands in unreadable.
 */
const HARDWARE_VENDORS = [
  "vijay sales",
  "samsung",
  "croma",
  "reliance digital",
  "flipkart",
  "amazon retail",
  "providence techno",
];
const HARDWARE_TERMS = [
  "laptop",
  "elitebook",
  "notebook",
  "monitor",
  "keyboard",
  "printer",
  "hard disk",
  "ssd",
  "router",
  "mobile phone",
  "smartphone",
  "iphone",
  "ipad",
  "macbook",
  "tablet",
  "memory card",
  "wifi",
  "led tv",
  "qled",
  "smart tv",
  "television",
  "accessories",
];

/**
 * Training, courses and certifications.
 *
 * Checked BEFORE the software include rules, because their descriptions are
 * full of software words: the live example is "Agentic AI AgentOps
 * Specialization Bootcamp 3.0 with Cloud", which matched the include term
 * "cloud" and entered Tech Spend as if it were a cloud subscription. It is a
 * course — an L&D cost, and a one-off.
 */
const TRAINING_TERMS = [
  "bootcamp",
  "boot camp",
  "training",
  "course",
  "certification",
  "workshop",
  "seminar",
  "specialization",
  "specialisation",
];

/**
 * Consulting, implementation and support engagements — labour billed by a
 * company rather than a subscription to a product.
 *
 * Distinct from `individual-consultant`, which keys on the vendor looking like
 * a natural person. Both are labour; this one catches the incorporated case
 * ("Information Technology Consulting and Support Services").
 */
const PROFESSIONAL_SERVICE_TERMS = [
  "consulting service",
  "consultancy service",
  "consulting and support",
  "support services",
  "implementation service",
  "manpower",
  "staff augmentation",
];

/** Voice/data lines. "Maruti Nandan Telecomm LLP" is the live example. */
const TELECOM_VENDORS = ["telecom", "telecomm", "airtel", "jio infocomm", "vodafone", "bsnl"];
const TELECOM_TERMS = ["telecommunication", "voice call services", "sim card", "broadband", "data plan"];

/**
 * Software, SaaS, cloud and paid APIs — the description side of the include
 * rule, for genuine vendors that VENDORS does not name yet.
 */
const SOFTWARE_TERMS = [
  "subscription",
  "saas",
  "api usage",
  // Plural on purpose. Prepaid API balance is how ElevenLabs, OpenAI and
  // OpenRouter all describe their invoices ("Credits Top-Up", "API usage
  // credit", "OpenRouter Credits"). The singular would also match "credit
  // note", which is a refund, not a purchase.
  "credits",
  "api credit",
  "cloud",
  "hosting",
  "server",
  "vps",
  "kvm",
  "domain",
  "ssl certificate",
  "software", // "Platform & Software Fee", "software licence"
  "platform fee",
  "seat",
  "workspace plan",
  "developer plan",
];

/**
 * Vendor-name tokens that identify a software company on their own.
 *
 * DELIBERATELY NARROW, and "technologies" is deliberately absent. That token is
 * precisely what the out-of-repo rule keys on, and it is what files our own
 * "ITARANG TECHNOLOGIES LLP" GST payment as tech spend — half the companies in
 * India carry it regardless of what they sell. "software" and "infotech" name
 * the trade rather than the fashion, and they run only AFTER every exclusion,
 * so a hardware reseller called "X Software Ltd" is still caught by its
 * description first.
 */
const SOFTWARE_VENDOR_TOKENS = ["software", "infotech"];

/**
 * An invoice from a natural person rather than a company.
 *
 * Heuristic and deliberately conservative: two or three capitalised words with
 * no corporate suffix, no legal form and no term that suggests a product. A
 * consultant's invoice may well be for technology work, but it is labour, not a
 * software subscription, and lumping it into a SaaS run-rate is what made
 * "Kartik Aggarwal — Consultation services" the largest line in Tech Spend.
 */
const COMPANY_MARKERS =
  /\b(ltd|limited|llp|llc|lp|inc|corp|corporation|pvt|private|plc|pbc|gmbh|pte|pty|bv|ag|sa|co|company|technologies|technology|solutions|systems|services|enterprises|labs|software|digital|infotech|networks|media|consulting|group|holdings|ventures|partners)\b/;

const CONSULTANT_TERMS = ["consultation", "consulting service", "professional fee", "retainer", "freelance"];

/**
 * Does `haystack` contain `needle` as a WHOLE WORD (or whole phrase)?
 *
 * Never a bare `includes()`. Every term below is a real word, and real words
 * hide inside other real words: "OpenRouter Credits" contains "router", so a
 * substring match excluded ₹1,034.98 of LLM API spend as retail hardware.
 * "server" hides in "observer", "seat" in "seating", "cloud" in "cloudy". This
 * is the same defect as the three-character "aws" needle in vendors.ts, which
 * rendered "Kawsar Enterprises" as AWS.
 *
 * Boundaries are any non-alphanumeric character, not just whitespace: the real
 * Fireflies line reads "Pro Fireflies Plan (per seat)", where the boundary
 * after "seat" is a closing parenthesis.
 */
function has(haystack: string, needles: string[]): string | null {
  for (const n of needles) {
    const escaped = n.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    if (new RegExp(`(^|[^a-z0-9])${escaped}($|[^a-z0-9])`).test(haystack)) {
      return n;
    }
  }
  return null;
}

function looksLikeIndividual(vendor: string): boolean {
  const cleaned = vendor.toLowerCase().replace(/[.,]/g, " ").replace(/\s+/g, " ").trim();
  if (!cleaned) return false;
  if (COMPANY_MARKERS.test(cleaned)) return false;
  const words = cleaned.split(" ").filter(Boolean);
  if (words.length < 2 || words.length > 3) return false;
  // Every token alphabetic — "OpenRouter, Inc" and "3M India" are not names.
  return words.every((w) => /^[a-z]+$/.test(w));
}

/**
 * Decide whether one already-`bucket='tech'` row belongs in Tech Spend.
 *
 * Order is load-bearing. The exclusions run FIRST, because a vendor can satisfy
 * an include rule and still not be technology spend: "ITARANG TECHNOLOGIES LLP
 * — GST Payment" would otherwise pass on the strength of its own name.
 */
export function classifyTechSpend(row: ClassifiableExpense): TechSpendVerdict {
  const vendorRaw = (row.vendor ?? "").trim();
  const vendor = vendorRaw.toLowerCase();
  const description = (row.description ?? "").trim().toLowerCase();
  const both = `${vendor} ${description}`;

  // ---- exclusions --------------------------------------------------------

  if (OWN_ENTITY.test(vendor)) {
    return {
      include: false,
      reason: "own-entity",
      explanation:
        "Invoiced by our own entity — an inter-entity transfer or a statutory payment filed under our name, not a purchase from a technology vendor.",
    };
  }

  const statutory = has(both, STATUTORY);
  if (statutory) {
    return {
      include: false,
      reason: "statutory",
      explanation: `Statutory or tax payment (matched "${statutory}"), which is never technology spend.`,
    };
  }

  const recruiter = has(vendor, RECRUITMENT_VENDORS) ?? has(description, RECRUITMENT_TERMS);
  if (recruiter) {
    return {
      include: false,
      reason: "recruitment",
      explanation: `Recruitment or job-board spend (matched "${recruiter}"). Belongs to HR, not tech.`,
    };
  }

  // Description before vendor name for this pair: "Maruti Nandan Telecomm LLP —
  // Purchase of iPhone and accessories" is a device bought from a telecom
  // company. Both readings exclude it, but the operator is shown the accurate
  // reason rather than a plausible one.
  const hardware = has(description, HARDWARE_TERMS) ?? has(vendor, HARDWARE_VENDORS);
  if (hardware) {
    return {
      include: false,
      reason: "hardware-retail",
      explanation: `Hardware or retail electronics (matched "${hardware}"). A capital purchase, not a recurring technology run-rate.`,
    };
  }

  const telecom = has(vendor, TELECOM_VENDORS) ?? has(description, TELECOM_TERMS);
  if (telecom) {
    return {
      include: false,
      reason: "telecom",
      explanation: `Telecom or connectivity line (matched "${telecom}"), not software or cloud spend.`,
    };
  }

  // Before the software rules, not after — a course description is full of
  // software words. See TRAINING_TERMS.
  const training = has(description, TRAINING_TERMS);
  if (training) {
    return {
      include: false,
      reason: "training",
      explanation: `Training or certification (matched "${training}"). A learning-and-development cost, not a software subscription.`,
    };
  }

  const professional = has(description, PROFESSIONAL_SERVICE_TERMS);
  if (professional) {
    return {
      include: false,
      reason: "professional-services",
      explanation: `Consulting, implementation or support labour (matched "${professional}") rather than a subscription to a product.`,
    };
  }

  // ---- inclusions --------------------------------------------------------

  // A vendor this codebase already names and integrates against — the strongest
  // signal available, since we hold an API key for it.
  //
  // ORDERED BEFORE the individual-consultant heuristic, and that ordering is
  // load-bearing: "OpenAI OpCo, LLC" is three alphabetic words, so the name
  // heuristic read it as a natural person and dropped ₹476.35 of genuine API
  // spend. Every rule above this point keys on the DESCRIPTION and is evidence
  // of what was bought; the one below keys on the shape of a name and is a
  // guess. A guess must not overrule a vendor we can name.
  const canonical = canonicalVendor(vendorRaw);
  if (canonical?.matched && vendorDef(canonical.id)) {
    return {
      include: true,
      reason: "known-software-vendor",
      explanation: `Recognised technology vendor (${canonical.label}).`,
    };
  }

  const consultantTerm = has(description, CONSULTANT_TERMS);
  if (looksLikeIndividual(vendorRaw) || (consultantTerm && !vendor)) {
    return {
      include: false,
      reason: "individual-consultant",
      explanation:
        "Invoiced by an individual rather than a company — labour, not a software subscription. Reclassify at source if this is a software vendor trading under a personal name.",
    };
  }

  const softwareTerm = has(description, SOFTWARE_TERMS);
  if (softwareTerm) {
    return {
      include: true,
      reason: "software-description",
      explanation: `Software, SaaS, cloud or API spend (matched "${softwareTerm}").`,
    };
  }

  const vendorToken = has(vendor, SOFTWARE_VENDOR_TOKENS);
  if (vendorToken) {
    return {
      include: true,
      reason: "software-vendor-name",
      explanation: `Vendor trades as a software company (matched "${vendorToken}") and the line is not hardware, labour, telecom or training.`,
    };
  }

  // ---- neither -----------------------------------------------------------
  // Excluded, but surfaced. Silently keeping it would put unverified money in
  // the headline; silently dropping it would make the total unexplainable.
  return {
    include: false,
    reason: "unclassified",
    explanation:
      "Not recognisable as software, SaaS, cloud or API spend from the vendor name or description. Excluded pending review — add the vendor to VENDORS in vendors.ts if it belongs.",
  };
}

/** Human label for a reason code, for the exclusions table. */
export const REASON_LABELS: Record<TechSpendReason, string> = {
  "known-software-vendor": "Known software vendor",
  "software-vendor-name": "Software vendor",
  "software-description": "Software / SaaS / cloud",
  "own-entity": "Our own entity",
  statutory: "Statutory / tax",
  recruitment: "Recruitment",
  "hardware-retail": "Hardware / retail",
  telecom: "Telecom",
  training: "Training / certification",
  "professional-services": "Consulting / support labour",
  "individual-consultant": "Individual consultant",
  unclassified: "Unclassified",
};
