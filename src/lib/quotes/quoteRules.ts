/**
 * 25 Nov task list ("Quotations and dealer accounts", items 1, 4, 5) — the
 * rules both quote families share: lead quotes (dealer_lead_commercials) and
 * account quotes (account_quotations). Pure and CLIENT-SAFE (no db import), so
 * the writers, the CEO decision paths and the screens cannot drift on them.
 *
 *   quotePriceChanges   item 1 — which products on a PENDING quote changed
 *                       price since it was raised (OEM reference or list).
 *   quoteEditBlock      item 5 — no new version once an approved version
 *                       has been sent and the dealer has not turned it down.
 *   versionsToSupersede item 4 — the open versions a new version replaces
 *                       (pending, or approved and never sent): withdrawn, so
 *                       one quotation is active per dealer at a time.
 */

/** The map key. Product ids are only unique within their own master table. */
export const priceKey = (assetType: string, productId: string) => `${assetType}:${productId}`;

/** One line of a quote's stored OEM evaluation (oem_evaluation.lines). */
export type EvaluatedLine = {
    asset_type: string;
    product_id: string;
    product_name?: string | null;
    oem_price: number | string | null;
};

/** One stored product line. `list_price` is the E-321 snapshot; absent on older quotes. */
export type SnapshotLine = {
    asset_type: string;
    product_id: string;
    product_name?: string | null;
    list_price?: number | string | null;
};

export type PriceChange = {
    product_name: string;
    /** oem = the internal reference price (never shown with numbers); list = the printed MRP. */
    kind: "oem" | "list";
    from: number | null;
    to: number;
};

const num = (v: unknown): number | null => {
    if (v == null || v === "") return null;
    const n = Number(v);
    return Number.isFinite(n) ? Math.round(n * 100) / 100 : null;
};

/**
 * What changed price on this quote since it was judged. A product only counts
 * when a price is IN FORCE now and differs from the one the quote carries
 * (including "had none, has one now"). A price that simply lapsed is not a
 * change — the quote is not wrong, the price book has a gap.
 */
export function quotePriceChanges(input: {
    evaluationLines: EvaluatedLine[] | null | undefined;
    productLines: SnapshotLine[] | null | undefined;
    liveOem: ReadonlyMap<string, { oem_price: number | string }>;
    liveList: ReadonlyMap<string, { list_price: number | string }>;
}): PriceChange[] {
    const out: PriceChange[] = [];
    const seen = new Set<string>();
    for (const l of input.evaluationLines ?? []) {
        const key = priceKey(l.asset_type, l.product_id);
        if (seen.has(`oem|${key}`)) continue;
        seen.add(`oem|${key}`);
        const now = num(input.liveOem.get(key)?.oem_price);
        if (now == null) continue;
        const was = num(l.oem_price);
        if (was !== now) out.push({ product_name: l.product_name || l.product_id, kind: "oem", from: was, to: now });
    }
    for (const l of input.productLines ?? []) {
        // A line written before E-321 has no list_price key: nothing to compare.
        if (!("list_price" in l) || l.list_price === undefined) continue;
        const key = priceKey(l.asset_type, l.product_id);
        if (seen.has(`list|${key}`)) continue;
        seen.add(`list|${key}`);
        const now = num(input.liveList.get(key)?.list_price);
        if (now == null) continue;
        const was = num(l.list_price);
        if (was !== now) out.push({ product_name: l.product_name || l.product_id, kind: "list", from: was, to: now });
    }
    return out;
}

const inr = (n: number) => `₹${n.toLocaleString("en-IN", { maximumFractionDigits: 2 })}`;

/**
 * The rejection reason the sales side reads (bell, WhatsApp, the quote row).
 * The OEM price is internal, so its numbers are never printed — only that it
 * moved. The list price is the printed MRP, so its old and new figures are.
 */
export function priceChangeReason(changes: PriceChange[]): string {
    const parts = changes.map((c) =>
        c.kind === "list"
            ? `${c.product_name}: list price ${c.from != null ? `${inr(c.from)} → ` : "now "}${inr(c.to)}`
            : `${c.product_name}: reference price ${c.from != null ? "revised" : "now set"}`,
    );
    return `Product price changed while this quote waited for approval (${parts.join("; ")}). Recheck the prices and resubmit.`;
}

/** Prefix every automatic price-change rejection carries (screens and reports can tell them apart). */
export const PRICE_CHANGE_REJECT_PREFIX = "Product price changed while this quote waited for approval";

export function isPriceChangeRejection(reason: string | null | undefined): boolean {
    return !!reason && reason.startsWith(PRICE_CHANGE_REJECT_PREFIX);
}

/** A quote version as the create path sees it. `sent` = at least one successful dispatch. */
export type QuoteVersionState = {
    id: string;
    version_no: number;
    approval_status: string | null;
    withdrawn_at: string | Date | null;
    dealer_decision: string | null;
    sent: boolean;
};

export type QuoteFamily = "lead" | "account";

/**
 * Item 5 — may a new version be raised? Refused while an approved version
 * has gone to the dealer and is still open: not withdrawn and not declined.
 *
 *   lead     a dealer-ACCEPTED quote is final too (the lead is Dealer agreed;
 *            the way on is Mark Won / Mark Lost).
 *   account  a dealer-accepted quote is a finished order; the account's next
 *            order is a new quotation, so it does not block.
 *
 * The way out of a sent, unanswered quote is Withdraw (still allowed), then a
 * new version.
 */
export function quoteEditBlock(
    versions: readonly QuoteVersionState[],
    family: QuoteFamily,
): { version_no: number; message: string } | null {
    const blocking = versions
        .filter(
            (v) =>
                v.approval_status === "approved" &&
                !v.withdrawn_at &&
                v.sent &&
                (v.dealer_decision == null || (family === "lead" && v.dealer_decision === "approved")),
        )
        .sort((a, b) => b.version_no - a.version_no)[0];
    if (!blocking) return null;
    if (blocking.dealer_decision === "approved") {
        return {
            version_no: blocking.version_no,
            message: `The dealer accepted v${blocking.version_no}, so the quotation can no longer be edited. Mark the lead Won or Lost.`,
        };
    }
    return {
        version_no: blocking.version_no,
        message:
            `v${blocking.version_no} was approved and sent to the dealer, so it can no longer be edited. ` +
            `Withdraw it first if the dealer needs a new quotation.`,
    };
}

/**
 * Item 4 — the versions a new one replaces: every OPEN version (not withdrawn,
 * no dealer answer) that is still waiting for the CEO or approved but never
 * sent. They are withdrawn so the dealer has one active quotation.
 */
export function versionsToSupersede(versions: readonly QuoteVersionState[]): QuoteVersionState[] {
    return versions.filter(
        (v) =>
            !v.withdrawn_at &&
            v.dealer_decision == null &&
            (v.approval_status === "pending" || (v.approval_status === "approved" && !v.sent)),
    );
}

/** The withdraw reason stamped on a replaced version. */
export function supersededReason(newVersionNo: number): string {
    return `Replaced by v${newVersionNo} before it was sent to the dealer.`;
}
