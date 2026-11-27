/**
 * 27 Nov 2026 — "auto-select the most relevant loan product, so the Sales Head
 * does not have to". Pure (no I/O; unit-tested). The DB side is
 * bestFitTarget() in ./nbfc-routing.ts.
 *
 * Input: the BRE-eligible candidates for one lead (every product already
 * passed dealer permission, location, battery category, amount band and
 * "not already with that NBFC"). Output: the candidates ranked, best first,
 * each with a plain-language reason.
 *
 * Order, most important first:
 *   1. The admin's pinned default for this dealer / city / state
 *      (Settings › Loan Product) — a configured preference beats a guess.
 *   2. The dealer's track record with that NBFC — files from this dealer the
 *      NBFC approved (assignment status 'selected'), then files it took at all.
 *   3. Cheapest for the customer — lowest minimum ROI, then lowest upfront
 *      charges (processing fee + fixed file charge).
 *   4. Fastest disbursement (TAT hours, unknown last).
 *   5. Lowest product id — a stable tie-break, never random.
 */

export interface BestFitCandidate {
  nbfcId: number;
  nbfcName: string;
  loanProductId: number;
  productName: string;
  minRoiPct: number;
  processingFeeRupees: number | null;
  fileChargeFixedRupees: number | null;
  disbursementTatHours: number | null;
}

export interface DealerNbfcHistory {
  /** This dealer's files the NBFC approved. */
  approved: number;
  /** This dealer's files the NBFC was sent at all. */
  sent: number;
}

export interface RankedCandidate extends BestFitCandidate {
  reason: string;
}

const upfront = (c: BestFitCandidate) => (c.processingFeeRupees ?? 0) + (c.fileChargeFixedRupees ?? 0);
const tat = (c: BestFitCandidate) => c.disbursementTatHours ?? Number.POSITIVE_INFINITY;

export function rankBestFit(
  candidates: BestFitCandidate[],
  ctx: {
    /** "nbfcId:productId" of the pinned default that applies, if any. */
    pinnedKey?: string | null;
    history?: Map<number, DealerNbfcHistory>;
  } = {},
): RankedCandidate[] {
  const hist = (id: number) => ctx.history?.get(id) ?? { approved: 0, sent: 0 };
  const key = (c: BestFitCandidate) => `${c.nbfcId}:${c.loanProductId}`;

  const sorted = [...candidates].sort((a, b) => {
    const pa = key(a) === ctx.pinnedKey ? 1 : 0;
    const pb = key(b) === ctx.pinnedKey ? 1 : 0;
    if (pa !== pb) return pb - pa;
    const ha = hist(a.nbfcId);
    const hb = hist(b.nbfcId);
    if (ha.approved !== hb.approved) return hb.approved - ha.approved;
    if (ha.sent !== hb.sent) return hb.sent - ha.sent;
    if (a.minRoiPct !== b.minRoiPct) return a.minRoiPct - b.minRoiPct;
    if (upfront(a) !== upfront(b)) return upfront(a) - upfront(b);
    if (tat(a) !== tat(b)) return tat(a) - tat(b);
    return a.loanProductId - b.loanProductId;
  });

  return sorted.map((c, i) => ({ ...c, reason: i === 0 ? reasonFor(c, sorted, ctx.pinnedKey ?? null, hist) : "" }));
}

function reasonFor(
  best: BestFitCandidate,
  all: BestFitCandidate[],
  pinnedKey: string | null,
  hist: (id: number) => DealerNbfcHistory,
): string {
  if (all.length === 1) return "the only loan product that fits this lead";
  if (`${best.nbfcId}:${best.loanProductId}` === pinnedKey) return "the default loan product set for this dealer / location";
  const h = hist(best.nbfcId);
  // Explain against the next-best OTHER lender — two products of the same
  // NBFC often share a rate, which says nothing about why that NBFC won.
  // (Compared by name too: one lender can exist as two NBFC records.)
  const second =
    all.find((x) => x.nbfcId !== best.nbfcId && x.nbfcName.trim().toLowerCase() !== best.nbfcName.trim().toLowerCase()) ??
    all.find((x) => x.nbfcId !== best.nbfcId) ??
    all[1];
  const h2 = hist(second.nbfcId);
  if (h.approved > h2.approved) {
    return `${best.nbfcName} approved ${h.approved} earlier file${h.approved === 1 ? "" : "s"} from this dealer`;
  }
  if (h.sent > h2.sent) return `this dealer's files already go to ${best.nbfcName}`;
  if (best.minRoiPct < second.minRoiPct) return `lowest interest rate (from ${best.minRoiPct}%) among ${all.length} fitting products`;
  if (upfront(best) < upfront(second)) return `lowest upfront charges among ${all.length} fitting products`;
  if (tat(best) < tat(second)) return `fastest disbursement among ${all.length} fitting products`;
  return `best fit among ${all.length} fitting products`;
}
