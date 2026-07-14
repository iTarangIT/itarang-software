/**
 * Invoice ↔ lock comparison (M12).
 *
 *   AC: "one edited line blocks approval EVEN IF THE TOTAL MATCHES"
 *
 * That sentence is the whole reason this is a function and not an `if`. A dealer
 * who bills ₹5,500 on one variant and ₹2,700 on another — when the locks say
 * ₹5,200 and ₹3,000 — has produced an invoice whose TOTAL is exactly right and
 * whose every line is wrong. A total check waves it through. This does not.
 *
 * PURE: no I/O, no DB. Every case below is a unit test, because approving a bad
 * invoice is how iTarang pays out money it never agreed to.
 *
 * EXACT comparison, no tolerance. Prices are NUMERIC(12,2) on both sides, so
 * "exactly equal" is well-defined and there is nothing to round. A ₹1/unit
 * tolerance sounds harmless until someone shaves ₹1 across 200 units.
 *
 * The design prototype's `approveInv` sets the status to Approved and toasts
 * "Matched locked price ✓" WITHOUT COMPARING ANYTHING. That is the bug this file
 * exists to make impossible.
 */

export interface InvoiceLineInput {
  line_id: string;
  quantity: number;
  price_per_unit: number | string;
}

export interface LockedLine {
  line_id: string;
  quantity: number;
  /** ₹/unit the dealer accepted, from deal_line_locks. The source of truth. */
  dealer_price: number | string;
  /** For the human-readable reason. */
  label?: string;
}

export type MismatchCode =
  | "PRICE_MISMATCH"
  | "QUANTITY_MISMATCH"
  | "LINE_NOT_ON_DEAL"
  | "LINE_MISSING";

export interface LineVerdict {
  line_id: string;
  label: string;
  matched: boolean;
  code?: MismatchCode;
  billed_price?: number;
  locked_price?: number;
  billed_quantity?: number;
  locked_quantity?: number;
  reason?: string;
}

export interface MatchResult {
  ok: boolean;
  verdicts: LineVerdict[];
  /** Both are reported precisely so the "total matches, lines don't" case is visible. */
  billed_total: number;
  locked_total: number;
  /** The one-sentence reason an invoice was returned. */
  summary: string | null;
}

const money = (v: number | string): number => Math.round(Number(v) * 100) / 100;

export function matchInvoiceToLocks(
  invoiceLines: InvoiceLineInput[],
  locks: LockedLine[],
): MatchResult {
  const byLock = new Map(locks.map((l) => [l.line_id, l]));
  const byInvoice = new Map(invoiceLines.map((l) => [l.line_id, l]));
  const verdicts: LineVerdict[] = [];

  // 1. Every invoiced line must exist on the deal, at the locked price and quantity.
  for (const billed of invoiceLines) {
    const lock = byLock.get(billed.line_id);
    const label = lock?.label ?? billed.line_id;

    if (!lock) {
      verdicts.push({
        line_id: billed.line_id,
        label,
        matched: false,
        code: "LINE_NOT_ON_DEAL",
        reason: "This line is not part of the deal.",
      });
      continue;
    }

    const billedPrice = money(billed.price_per_unit);
    const lockedPrice = money(lock.dealer_price);

    if (billed.quantity !== lock.quantity) {
      verdicts.push({
        line_id: billed.line_id,
        label,
        matched: false,
        code: "QUANTITY_MISMATCH",
        billed_quantity: billed.quantity,
        locked_quantity: lock.quantity,
        reason: `Billed for ${billed.quantity}, but ${lock.quantity} were agreed.`,
      });
      continue;
    }

    if (billedPrice !== lockedPrice) {
      verdicts.push({
        line_id: billed.line_id,
        label,
        matched: false,
        code: "PRICE_MISMATCH",
        billed_price: billedPrice,
        locked_price: lockedPrice,
        billed_quantity: billed.quantity,
        locked_quantity: lock.quantity,
        reason: `Billed at ₹${billedPrice.toLocaleString("en-IN")}/unit, agreed at ₹${lockedPrice.toLocaleString("en-IN")}/unit.`,
      });
      continue;
    }

    verdicts.push({
      line_id: billed.line_id,
      label,
      matched: true,
      billed_price: billedPrice,
      locked_price: lockedPrice,
      billed_quantity: billed.quantity,
      locked_quantity: lock.quantity,
    });
  }

  // 2. ...and every line on the deal must be invoiced. An invoice that quietly
  //    OMITS a variant is not "partially right" — it is a different invoice, and
  //    approving it would settle a deal for goods we took but never paid for.
  for (const lock of locks) {
    if (byInvoice.has(lock.line_id)) continue;
    verdicts.push({
      line_id: lock.line_id,
      label: lock.label ?? lock.line_id,
      matched: false,
      code: "LINE_MISSING",
      locked_price: money(lock.dealer_price),
      locked_quantity: lock.quantity,
      reason: "This battery is on the deal but is missing from the invoice.",
    });
  }

  const billedTotal = invoiceLines.reduce((s, l) => s + l.quantity * money(l.price_per_unit), 0);
  const lockedTotal = locks.reduce((s, l) => s + l.quantity * money(l.dealer_price), 0);

  const bad = verdicts.filter((v) => !v.matched);
  const ok = bad.length === 0;

  let summary: string | null = null;
  if (!ok) {
    const first = bad[0];
    summary =
      bad.length === 1
        ? `${first.label}: ${first.reason}`
        : `${bad.length} lines do not match what was agreed. First: ${first.label} — ${first.reason}`;

    // Name the trap explicitly. An admin staring at two totals that agree needs
    // to be told why the invoice is still being returned.
    if (money(billedTotal) === money(lockedTotal)) {
      summary +=
        " (The invoice total happens to match, but the individual battery prices do not — so this cannot be approved.)";
    }
  }

  return {
    ok,
    verdicts,
    billed_total: money(billedTotal),
    locked_total: money(lockedTotal),
    summary,
  };
}
