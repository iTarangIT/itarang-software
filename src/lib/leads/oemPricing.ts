/**
 * E-226 — quotation auto-approval against the OEM reference price book.
 *
 * Pure rules, no database — the same split [[quoteApproval]] already uses, so the
 * decision that releases a price to a dealer can be tested without a connection
 * and the write path and the CEO queue cannot drift on what "below reference"
 * means.
 *
 * E-221 sent every quote to the CEO. This narrows that to the quotes worth a
 * human: a quote whose every line is at or above our reference price releases
 * immediately; anything else waits.
 */

import type { CommercialsProductLine } from "@/lib/inside-sales/types";

/**
 * Stamped into every evaluation. If the rule below ever changes, an old quote
 * still says which rule judged it — the alternative is a snapshot that silently
 * means something different than it did when it was written.
 */
export const OEM_RULE_VERSION = "per_line_v1";

export const OEM_LINE_STATUSES = [
    "at_or_above",
    "below",
    "no_reference",
    "unpriced",
] as const;
export type OemLineStatus = (typeof OEM_LINE_STATUSES)[number];

export const OEM_OUTCOMES = ["auto_approved", "manual_required"] as const;
export type OemOutcome = (typeof OEM_OUTCOMES)[number];

export const OEM_REASONS = [
    "at_or_above_reference",
    "below_reference",
    "missing_reference",
    "unpriced_line",
    "no_product_lines",
] as const;
export type OemReason = (typeof OEM_REASONS)[number];

/** The live reference price for one product, and the row it came from. */
export interface OemPriceRef {
    /** The exact oem_reference_prices row used. The audit anchor. */
    price_id: string;
    oem_price: number;
}

export interface OemLineVerdict {
    asset_type: string;
    product_id: string;
    product_name: string;
    quantity: number;
    quoted_unit_price: number | null;
    oem_price: number | null;
    price_id: string | null;
    /** quoted − reference, per unit. Negative means we are discounting. */
    delta: number | null;
    status: OemLineStatus;
}

export interface OemEvaluation {
    rule: typeof OEM_RULE_VERSION;
    evaluated_at: string;
    outcome: OemOutcome;
    reason: OemReason;
    /** Σ max(0, reference − quoted) × qty — the rupee value being given up. */
    shortfall_total: number;
    lines: OemLineVerdict[];
}

/** The map key. Product ids are only unique within their own master table. */
export function refKey(assetType: string, productId: string): string {
    return `${assetType}:${productId}`;
}

/**
 * Which reference prices an evaluation of these lines needs.
 * Deduplicated — the same product can legitimately appear on two lines.
 */
export function referenceKeysFor(lines: CommercialsProductLine[]): string[] {
    return [...new Set(lines.map((l) => refKey(l.asset_type, l.product_id)))];
}

function verdictFor(
    line: CommercialsProductLine,
    ref: OemPriceRef | undefined,
): OemLineVerdict {
    const base = {
        asset_type: line.asset_type,
        product_id: line.product_id,
        product_name: line.product_name,
        quantity: line.quantity,
        quoted_unit_price: line.unit_price,
    };

    // The rep left the price blank. There is no number to compare, so this is
    // not "fine by default" — it is exactly the case a human should look at.
    if (line.unit_price == null) {
        return {
            ...base,
            oem_price: ref?.oem_price ?? null,
            price_id: ref?.price_id ?? null,
            delta: null,
            status: "unpriced",
        };
    }

    // No reference on file — a new SKU, or one the price book has not reached.
    // Fail closed: an unpriced product is precisely the one nobody has
    // margin-checked.
    if (!ref) {
        return { ...base, oem_price: null, price_id: null, delta: null, status: "no_reference" };
    }

    const delta = line.unit_price - ref.oem_price;
    return {
        ...base,
        oem_price: ref.oem_price,
        price_id: ref.price_id,
        delta,
        // Equality passes: the spec is "at or above".
        status: delta >= 0 ? "at_or_above" : "below",
    };
}

/**
 * The rule. Auto-approve only if EVERY line clears its reference price.
 *
 * One discounted line is enough to send the whole quote to the CEO — a quote is
 * approved or not as a single document, and letting a healthy line subsidise a
 * loss-making one is the judgement call being escalated, not a detail to net
 * out silently.
 *
 * `reason` reports the most serious problem found, in the order below, so the
 * CEO panel can lead with the one thing that actually needs deciding.
 */
export function evaluateAgainstOemPrices(
    lines: CommercialsProductLine[],
    refs: Map<string, OemPriceRef>,
    at: Date,
): OemEvaluation {
    const verdicts = lines.map((l) =>
        verdictFor(l, refs.get(refKey(l.asset_type, l.product_id))),
    );

    // Multiplied by quantity even though the comparison is per unit: the CEO is
    // deciding about rupees on this deal, not about a per-unit gap.
    const shortfall_total = verdicts.reduce((sum, v) => {
        if (v.status !== "below" || v.delta == null) return sum;
        return sum + Math.abs(v.delta) * v.quantity;
    }, 0);

    const base = {
        rule: OEM_RULE_VERSION,
        evaluated_at: at.toISOString(),
        shortfall_total,
        lines: verdicts,
    } as const;

    // A quote carrying only a lump-sum final_price has nothing to check against.
    // Fail closed rather than release an unexamined number.
    if (verdicts.length === 0) {
        return { ...base, outcome: "manual_required", reason: "no_product_lines" };
    }
    if (verdicts.some((v) => v.status === "below")) {
        return { ...base, outcome: "manual_required", reason: "below_reference" };
    }
    if (verdicts.some((v) => v.status === "no_reference")) {
        return { ...base, outcome: "manual_required", reason: "missing_reference" };
    }
    if (verdicts.some((v) => v.status === "unpriced")) {
        return { ...base, outcome: "manual_required", reason: "unpriced_line" };
    }
    return { ...base, outcome: "auto_approved", reason: "at_or_above_reference" };
}

/**
 * The evaluation, expressed in the columns E-221 already owns.
 *
 * Deliberately no new `approval_status` value: 'approved' means the same thing
 * however it was reached, and a fourth status would have to be taught to every
 * site that compares this column to a string literal. `mode` carries the HOW.
 */
export function resolveQuoteApproval(evaluation: OemEvaluation): {
    status: "approved" | "pending";
    mode: "auto" | "manual";
} {
    return evaluation.outcome === "auto_approved"
        ? { status: "approved", mode: "auto" }
        : { status: "pending", mode: "manual" };
}

/** How many lines are the reason this quote is waiting. For the CEO panel. */
export function linesNeedingAttention(evaluation: OemEvaluation): number {
    return evaluation.lines.filter((l) => l.status !== "at_or_above").length;
}
