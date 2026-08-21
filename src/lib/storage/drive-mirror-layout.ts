/**
 * E-255 — how S3 objects are laid out in the Google Drive backup.
 *
 * S3 keys are machine-shaped (`dealer-documents/upload-gst-certificate/<uuid>.pdf`,
 * `documents/kyc/LEAD-2026…/aadhaar.png`). The Drive copy is for PEOPLE — an
 * admin opening Drive should see "KYC Documents", "Dealer Onboarding", "Call
 * Recordings" — so each object is placed under a human-named category folder,
 * chosen from its bucket + key prefix, with the rest of the key path kept
 * beneath it (so files never collide and the per-lead / per-dealer grouping
 * survives).
 *
 * Rules are matched top to bottom; the first match wins; anything unmatched
 * lands in `Other/<bucket>/…`. Whether an object is actually COPIED is a
 * separate question answered by `isDriveMirrorExcluded` below — only the
 * categories in DRIVE_MIRROR_INCLUDED_FOLDERS are backed up. Add a rule here when a new
 * upload path appears; existing Drive files are NOT moved when a rule changes
 * (the mirror finds them by object tag and updates in place), so a change
 * only affects files uploaded after it.
 *
 * Pure module — no I/O — so it is unit-testable and safe to import anywhere.
 */

export interface LayoutRule {
  /** Logical S3 bucket, or "*" for any. */
  bucket: string;
  /** Key prefix (matched against the start of the key, segment-aligned) or "" for any. */
  prefix: string;
  /** Drive folder path under the root, e.g. ["KYC Documents"]. */
  folder: string[];
  /**
   * How many leading key segments the prefix "consumed" and should not be
   * repeated under the category folder. Defaults to the number of segments in
   * `prefix`. Set lower to keep a segment (e.g. keep the doc-type folder under
   * "Dealer Onboarding").
   */
  strip?: number;
  /** Shown on the admin page. */
  description: string;
}

/**
 * Category rules. Derived from the live bucket on 2026-08-19 — see the
 * prefix census in the E-255 checklist row. Order matters.
 */
export const DRIVE_LAYOUT_RULES: LayoutRule[] = [
  // ---- customer KYC & lead files (bucket "documents") ------------------
  {
    bucket: "documents",
    prefix: "kyc",
    folder: ["KYC Documents"],
    description: "Customer KYC uploads, consent PDFs, co-borrower docs — one sub-folder per lead",
  },
  {
    bucket: "documents",
    prefix: "leads",
    folder: ["Lead Documents"],
    description: "Other per-lead files (Step-4 pre-sanction bucket, requested docs)",
  },
  {
    bucket: "documents",
    prefix: "autofill",
    folder: ["Lead Documents", "Autofill scans"],
    description: "Documents scanned for lead-form autofill",
  },
  {
    bucket: "documents",
    prefix: "quotations",
    folder: ["Quotations"],
    description: "Generated quotation PDFs",
  },
  {
    bucket: "documents",
    prefix: "whatsapp",
    folder: ["WhatsApp Uploads"],
    description: "Files received over the WhatsApp onboarding / lead bot",
  },
  {
    bucket: "documents",
    prefix: "expenses",
    folder: ["Expenses"],
    description: "Expense bills — submitted and Drive-scanned invoices",
  },
  {
    bucket: "documents",
    prefix: "auction",
    folder: ["Battery Auction"],
    description: "Auction lot photos and settlement documents",
  },
  {
    bucket: "private-documents",
    prefix: "",
    folder: ["Private Documents"],
    description: "Private lead documents served only via signed URLs",
  },

  // ---- dealers (bucket "dealer-documents") ------------------------------
  {
    bucket: "dealer-documents",
    prefix: "buyback",
    folder: ["Battery Buyback"],
    description: "Buyback intake photos, vendor files, evidence, invoices",
  },
  {
    bucket: "dealer-documents",
    prefix: "agreements",
    folder: ["Dealer Agreements"],
    description: "Digio-signed dealer agreements and audit trails",
  },
  {
    bucket: "dealer-documents",
    prefix: "agreement-template-file",
    folder: ["Dealer Agreements", "Templates"],
    description: "Agreement templates uploaded by admin",
  },
  {
    bucket: "dealer-documents",
    prefix: "dealer-signed-agreement-upload",
    folder: ["Dealer Agreements", "Manually uploaded"],
    description: "Signed agreements uploaded by hand",
  },
  {
    bucket: "dealer-documents",
    prefix: "signed-agreement.pdf",
    folder: ["Dealer Agreements"],
    strip: 0,
    description: "Legacy signed agreement",
  },
  {
    bucket: "dealer-documents",
    prefix: "visit-photos",
    folder: ["Dealer Onboarding", "Visit photos"],
    description: "Field-visit photos",
  },
  {
    // Everything else in dealer-documents is an onboarding document type
    // (upload-gst-certificate, company-pan, 4-undated-cheques, ITR, bank
    // statement, photographs, Udyam, MOU/AOA, partnership deed…). Keep the
    // doc-type segment as a sub-folder so Drive reads "Dealer Onboarding /
    // GST Certificate / <file>".
    bucket: "dealer-documents",
    prefix: "",
    folder: ["Dealer Onboarding"],
    strip: 0,
    description: "Dealer onboarding documents — one sub-folder per document type (GST, PAN, cheques, ITR, bank statement, photos, Udyam, MOU/AOA…)",
  },

  // ---- NBFC (bucket "nbfc-documents") -----------------------------------
  {
    bucket: "nbfc-documents",
    prefix: "fi",
    folder: ["NBFC", "Field Investigation"],
    description: "FI photos and reports",
  },
  {
    bucket: "nbfc-documents",
    prefix: "fi-agents",
    folder: ["NBFC", "Field Investigation", "Agents"],
    description: "FI agent documents",
  },
  {
    bucket: "nbfc-documents",
    prefix: "vkyc",
    folder: ["NBFC", "Video KYC"],
    description: "Video-KYC recordings and screenshots",
  },
  {
    bucket: "nbfc-documents",
    prefix: "agreements",
    folder: ["NBFC", "Agreements"],
    description: "NBFC LSP agreements",
  },
  {
    bucket: "nbfc-documents",
    prefix: "",
    folder: ["NBFC", "Onboarding & Compliance"],
    strip: 0,
    description: "NBFC onboarding / compliance documents — one sub-folder per NBFC",
  },

];

/**
 * Buckets that are deliberately NOT backed up to Drive, whatever the key.
 * Call recordings are large audio files re-hosted from the dialer providers
 * (Bolna / Elevenlabs) — not documents.
 */
export const DRIVE_MIRROR_EXCLUDED_BUCKETS: readonly string[] = ["call-recordings"];

/**
 * The Drive categories that ARE backed up — an allow-list, decided by the
 * business on 2026-08-19. An object is mirrored only when the layout rule
 * that places it has exactly one of these folder paths. Everything else
 * (Quotations, Expenses, Battery Auction, Battery Buyback, Private Documents,
 * NBFC Field Investigation / Video KYC, autofill scans, visit photos, call
 * recordings, and anything that matches no rule at all) gets no ledger row
 * and is never copied. Add a path here to start backing a category up;
 * existing objects are picked up by the next backfill sweep.
 */
export const DRIVE_MIRROR_INCLUDED_FOLDERS: readonly (readonly string[])[] = [
  ["KYC Documents"],
  ["Lead Documents"],
  ["WhatsApp Uploads"],
  ["Dealer Agreements"],
  ["Dealer Agreements", "Templates"],
  ["Dealer Agreements", "Manually uploaded"],
  ["Dealer Onboarding"],
  ["NBFC", "Agreements"],
  ["NBFC", "Onboarding & Compliance"],
];

function sameFolder(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((seg, i) => seg === b[i]);
}

/** True when the rule's category is on the backup allow-list. */
export function isRuleIncluded(rule: LayoutRule | null): boolean {
  if (!rule) return false;
  return DRIVE_MIRROR_INCLUDED_FOLDERS.some((inc) => sameFolder(inc, rule.folder));
}

/**
 * True when an object must NOT be copied to Drive — excluded bucket, no
 * matching rule, or a rule whose category is not on the allow-list. The
 * upload hook, the backfill sweep and the ticker all consult this.
 */
export function isDriveMirrorExcluded(bucket: string, key: string): boolean {
  if (DRIVE_MIRROR_EXCLUDED_BUCKETS.includes(bucket)) return true;
  return !isRuleIncluded(driveFolderPathFor(bucket, key).rule);
}

/** Prettify a machine folder segment: "upload-gst-certificate" → "Upload Gst Certificate". */
export function prettifySegment(seg: string): string {
  // Leave ids / lead codes / filenames alone.
  if (/^[0-9a-f]{8}-[0-9a-f]{4}-/i.test(seg) || /^LEAD-/i.test(seg) || /\.[a-z0-9]{2,5}$/i.test(seg)) {
    return seg;
  }
  const words = seg.replace(/[_-]+/g, " ").trim();
  if (!words) return seg;
  const SMALL = new Set(["of", "and", "the", "to", "for", "by"]);
  return words
    .split(" ")
    .map((w) => {
      if (SMALL.has(w)) return w;
      // Short all-letter words are almost always acronyms here: gst, pan, itr, mou, aoa, fi.
      if (w.length <= 3 && /^[a-z]+$/.test(w)) return w.toUpperCase();
      return w[0].toUpperCase() + w.slice(1);
    })
    .join(" ");
}

function segmentPrefixMatch(keySegments: string[], prefix: string): boolean {
  if (!prefix) return true;
  const p = prefix.split("/").filter(Boolean);
  if (p.length > keySegments.length) return false;
  return p.every((s, i) => keySegments[i] === s);
}

/**
 * Drive folder path (under the root) for an object, plus the rule that placed
 * it. The last key segment (the file name) is never part of the folder path.
 */
export function driveFolderPathFor(
  bucket: string,
  key: string,
): { path: string[]; rule: LayoutRule | null } {
  const segments = key.split("/").filter(Boolean);
  const dirs = segments.slice(0, -1); // drop file name
  for (const rule of DRIVE_LAYOUT_RULES) {
    if (rule.bucket !== "*" && rule.bucket !== bucket) continue;
    if (!segmentPrefixMatch(dirs.length ? dirs : segments, rule.prefix)) continue;
    // Prefix rules that name a FILE (signed-agreement.pdf) match on the full
    // segments; folder rules match on dirs.
    const strip = rule.strip ?? rule.prefix.split("/").filter(Boolean).length;
    const rest = dirs.slice(strip).map(prettifySegment);
    return { path: [...rule.folder, ...rest], rule };
  }
  return { path: ["Other", bucket, ...dirs], rule: null };
}

/** The distinct top-level category folders the backup creates, for the admin page. */
export function driveTopLevelFolders(): string[] {
  const seen = new Set<string>();
  for (const r of DRIVE_LAYOUT_RULES) if (isRuleIncluded(r)) seen.add(r.folder[0]);
  return [...seen];
}
