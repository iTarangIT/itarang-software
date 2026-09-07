/**
 * E-280 — decide which iTarang entity a sales invoice belongs to.
 *
 * Both entities trade as ITARANG TECHNOLOGIES LLP and differ only by GST
 * registration, so the entity is never stated in words on the document. Four
 * independent signals carry it, and the live folder proves that none of them is
 * present on every file:
 *
 *   seller GSTIN     07AALFI7813E1ZC → Delhi, 06… → Haryana. The legal truth,
 *                    but it comes out of a vision model and can be misread.
 *   invoice number   ITD/… → Delhi, ITG/… → Haryana. Also read off the page.
 *   filename         ITD_202627_013.pdf. Absent on the 19 Nov/Dec 2025 files,
 *                    which are named things like "P M MOTORS INVOICE.pdf".
 *   folder path      "… / Sale / Delhi", "… / Sale / Delhi GST". Absent for
 *                    Nov/Dec 2025, which file everything flat under
 *                    "Sales Invoices" with no entity sub-folder.
 *
 * So rather than ranking one signal above the others and hoping it is there,
 * every signal votes. The majority wins; ties fall back to the priority order
 * above (document-derived beats human filing, because the folder is where
 * somebody put the file, not what the invoice says).
 *
 * Disagreement is REPORTED, never silently resolved. An invoice filed under
 * Delhi that carries a Haryana GSTIN is either a filing mistake or a
 * misextraction, and both are worth a human looking — the row still imports,
 * flagged, because a wrong entity understates nothing today (every CEO figure
 * is a company-wide sum) but would quietly corrupt any future per-entity split.
 */

/**
 * Zoho organization ids, reused verbatim from E-171 so a GROUP BY spans both
 * sources instead of splitting one legal entity in two.
 */
export const ORG_DELHI = "60064046518";
export const ORG_HARYANA = "60060919257";

export type SalesOrgCode = "ITD" | "ITG";

export interface SalesOrg {
  /** Zoho organization id, or null when nothing identified the entity. */
  organizationId: string | null;
  code: SalesOrgCode | null;
  /** Human label for the admin panel. */
  label: string | null;
  /** True when the signals did not all agree. */
  conflict: boolean;
  /** One line per signal that fired, for the attention reason. */
  signals: string[];
}

const ORG_BY_CODE: Record<SalesOrgCode, { id: string; label: string }> = {
  ITD: { id: ORG_DELHI, label: "Delhi" },
  ITG: { id: ORG_HARYANA, label: "Haryana" },
};

/** Indian GST state codes: the first two digits of a GSTIN. */
const GST_STATE_TO_CODE: Record<string, SalesOrgCode> = {
  "07": "ITD", // Delhi
  "06": "ITG", // Haryana
};

function fromGstin(gstin: string | null | undefined): SalesOrgCode | null {
  if (!gstin) return null;
  const cleaned = gstin.replace(/[^0-9A-Za-z]/g, "");
  if (cleaned.length < 2) return null;
  return GST_STATE_TO_CODE[cleaned.slice(0, 2)] ?? null;
}

/**
 * Leading ITD/ITG on an invoice number or a filename.
 *
 * The boundary is written as a negative lookahead rather than `\b` on purpose:
 * underscore is a word character, so `/^ITD\b/` does NOT match
 * "ITD_202627_013.pdf" — which is how every single Drive filename is spelled.
 * A `\b` here silently disabled the filename signal for all 116 files that
 * have one.
 */
function fromSeriesPrefix(value: string | null | undefined): SalesOrgCode | null {
  if (!value) return null;
  const m = value.trim().toUpperCase().match(/^(ITD|ITG)(?![A-Z0-9])/);
  return (m?.[1] as SalesOrgCode | undefined) ?? null;
}

/**
 * Entity named anywhere in the Drive path.
 *
 * Matched as a word so "Delhi" and "Delhi GST" both hit while a customer
 * folder called "New Delhi Motors" does not steal the vote from a real entity
 * folder — the path is checked segment by segment, and only a segment that
 * STARTS with the entity name counts.
 */
function fromFolderPath(folderPath: string | null | undefined): SalesOrgCode | null {
  if (!folderPath) return null;
  for (const segment of folderPath.split("/")) {
    const s = segment.trim().toLowerCase();
    if (/^delhi\b/.test(s)) return "ITD";
    if (/^haryana\b/.test(s)) return "ITG";
    if (/^gurgaon\b/.test(s) || /^gurugram\b/.test(s)) return "ITG";
  }
  return null;
}

export interface ResolveSalesOrgInput {
  sellerGstin?: string | null;
  invoiceNumber?: string | null;
  fileName?: string | null;
  folderPath?: string | null;
}

export function resolveSalesOrg(input: ResolveSalesOrgInput): SalesOrg {
  // Priority order, highest first. Used only to break a tie — otherwise every
  // signal counts equally and the majority wins.
  const votes: Array<{ source: string; code: SalesOrgCode | null }> = [
    { source: "seller GSTIN", code: fromGstin(input.sellerGstin) },
    { source: "invoice number", code: fromSeriesPrefix(input.invoiceNumber) },
    { source: "filename", code: fromSeriesPrefix(input.fileName) },
    { source: "folder path", code: fromFolderPath(input.folderPath) },
  ];

  const cast = votes.filter((v): v is { source: string; code: SalesOrgCode } =>
    Boolean(v.code),
  );
  if (cast.length === 0) {
    return {
      organizationId: null,
      code: null,
      label: null,
      conflict: false,
      signals: [],
    };
  }

  const tally = new Map<SalesOrgCode, number>();
  for (const v of cast) tally.set(v.code, (tally.get(v.code) ?? 0) + 1);

  // Majority; on a tie the earliest-listed (highest priority) signal wins,
  // which `cast` is already ordered by.
  let winner = cast[0].code;
  let best = tally.get(winner) ?? 0;
  for (const v of cast) {
    const n = tally.get(v.code) ?? 0;
    if (n > best) {
      winner = v.code;
      best = n;
    }
  }

  const conflict = tally.size > 1;
  const org = ORG_BY_CODE[winner];
  return {
    organizationId: org.id,
    code: winner,
    label: org.label,
    conflict,
    signals: cast.map((v) => `${v.source}=${v.code}`),
  };
}
