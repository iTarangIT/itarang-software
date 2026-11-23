/**
 * 23 Nov (point 1) — does an uploaded signed consent belong to THIS file?
 *
 * Every page of our consent form prints "Ref: CONSENT-… | Lead: LEAD-…" and
 * "Dear <customer name>" (lib/consent/consent-pdf-template). The signature
 * check reads those back; this compares them with the file. Pure.
 *
 *   match       — the printed lead id is this lead (a one-character misread is
 *                 forgiven when the name also agrees), or no id was readable
 *                 but the printed name is this customer's.
 *   mismatch    — the printed lead id is another lead, or the printed name is
 *                 clearly someone else → the upload is refused.
 *   unconfirmed — nothing readable to compare → stored for a HUMAN check, the
 *                 auto-verify clock is not started.
 */

export type ConsentOwnership = "match" | "mismatch" | "unconfirmed";

export interface ConsentPrinted {
  leadId?: string | null;
  consentRef?: string | null;
  customerName?: string | null;
}

export interface ConsentExpected {
  leadId: string;
  /** The applicant's name(s) on the file (customer, or co-borrower). */
  names: string[];
  /** Consent ids issued for this file (consent_records.id). */
  consentIds?: string[];
}

const BLANK = /^_+$/;

function normId(s: string | null | undefined): string {
  return (s ?? "").toUpperCase().replace(/[^A-Z0-9]/g, "");
}

function editDistance(a: string, b: string): number {
  if (Math.abs(a.length - b.length) > 2) return 99;
  const dp = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array(b.length).fill(0)]);
  for (let j = 1; j <= b.length; j++) dp[0][j] = j;
  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      dp[i][j] = Math.min(dp[i - 1][j] + 1, dp[i][j - 1] + 1, dp[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
  }
  return dp[a.length][b.length];
}

const HONORIFIC = new Set(["MR", "MRS", "MS", "SHRI", "SMT", "KUMARI", "DR", "SRI"]);

function nameTokens(s: string | null | undefined): string[] {
  return (s ?? "")
    .toUpperCase()
    .replace(/[^A-Z\s]/g, " ")
    .split(/\s+/)
    .filter((t) => t.length > 1 && !HONORIFIC.has(t));
}

/** "same" when the shorter name's words all appear (allowing one typo each) in the longer. */
export function compareNames(a: string | null | undefined, b: string | null | undefined): "same" | "different" | "unknown" {
  const x = nameTokens(a);
  const y = nameTokens(b);
  if (!x.length || !y.length) return "unknown";
  const [short, long] = x.length <= y.length ? [x, y] : [y, x];
  const hit = (t: string) => long.some((u) => u === t || (t.length >= 4 && editDistance(t, u) <= 1) || (t.length === 1 && u.startsWith(t)));
  const hits = short.filter(hit).length;
  if (hits === short.length) return "same";
  // A three-plus-word name with one word missing / unreadable is still the same person.
  if (short.length >= 3 && hits >= short.length - 1) return "same";
  return "different";
}

export function consentBelongsToFile(printed: ConsentPrinted, expected: ConsentExpected): {
  ownership: ConsentOwnership;
  note: string;
} {
  const pid = normId(printed.leadId);
  const eid = normId(expected.leadId);
  const rawName = (printed.customerName ?? "").trim();
  const printedName = rawName && !BLANK.test(rawName) ? rawName : null;
  const nameVerdicts = printedName ? expected.names.map((n) => compareNames(printedName, n)) : [];
  const nameSame = nameVerdicts.includes("same");
  const nameDifferent = nameVerdicts.length > 0 && nameVerdicts.every((v) => v === "different");

  if (pid && eid) {
    if (pid === eid) return { ownership: "match", note: "Consent form is for this file (lead id matches)." };
    if (editDistance(pid, eid) <= 1 && !nameDifferent) {
      return { ownership: "match", note: "Consent form is for this file (lead id matches allowing one misread character)." };
    }
    return {
      ownership: "mismatch",
      note: `Consent form belongs to another file: printed lead ${printed.leadId}, this file is ${expected.leadId}.`,
    };
  }

  const ref = normId(printed.consentRef);
  if (ref && (expected.consentIds ?? []).some((c) => normId(c) === ref) && !nameDifferent) {
    return { ownership: "match", note: "Consent form is for this file (consent ref matches)." };
  }

  if (printedName) {
    if (nameSame) return { ownership: "match", note: `Consent form names ${printedName} — matches this file.` };
    if (nameDifferent) {
      return {
        ownership: "mismatch",
        note: `Consent form names ${printedName}, but this file is for ${expected.names.filter(Boolean).join(" / ") || "another customer"}.`,
      };
    }
  }
  return { ownership: "unconfirmed", note: "Could not read the lead id or the customer name on the form — needs a human check that it is this customer's consent." };
}
