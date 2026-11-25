/**
 * 25 Nov item 1 — "If the master product price changes while a quotation is
 * pending approval, automatically reject the pending quotation and notify the
 * Sales Manager to recheck and resubmit it."
 *
 * Both quote families. A PENDING quote (waiting for the CEO, not withdrawn) is
 * stale when a product on it now has a different OEM reference price or list
 * price in force than the one it was judged against / printed with (pure rule:
 * quotePriceChanges in ./quoteRules.ts). A stale quote is rejected by the
 * system with a reason naming the products, through the same writer as the
 * CEO's Reject, so the rep gets the same bell / WhatsApp and the same Revise
 * button (ID 216), which reopens it at the live prices (item 3).
 *
 * Three places run it, because a price "changes" in two ways:
 *   - a price saved to start now      → the price-book POST routes, right after save
 *   - a scheduled price reaching its day → the six-hourly OEM sweep ticker
 *   - either, missed by both          → the CEO's Approve re-checks first and
 *                                       rejects instead of releasing an old price
 *
 * Never throws from the sweep: a failure on one quote is logged and the rest go on.
 */
import { sql } from "drizzle-orm";
import { db } from "@/lib/db";
import type { CommercialsProductLine } from "@/lib/inside-sales/types";
import { loadLiveOemPrices } from "@/lib/leads/oemPrices";
import { loadLiveListPrices } from "@/lib/leads/listPrices";
import { rejectPendingLeadQuote } from "@/lib/leads/rejectQuote";
import { hasAccountQuotationTables } from "@/lib/accounts/quotations/access";
import { priceChangeReason, quotePriceChanges, type EvaluatedLine, type PriceChange } from "./quoteRules";

type PendingRow = {
    id: string;
    product_lines: CommercialsProductLine[] | null;
    oem_evaluation: { lines?: EvaluatedLine[] } | null;
};

/** What changed price on this quote, against the prices in force now. */
export async function priceChangesFor(row: Pick<PendingRow, "product_lines" | "oem_evaluation">): Promise<PriceChange[]> {
    const lines = Array.isArray(row.product_lines) ? row.product_lines : [];
    if (lines.length === 0) return [];
    const now = new Date();
    const [liveOem, liveList] = await Promise.all([
        loadLiveOemPrices(lines, undefined, now),
        loadLiveListPrices(lines, undefined, now),
    ]);
    return quotePriceChanges({ evaluationLines: row.oem_evaluation?.lines, productLines: lines, liveOem, liveList });
}

/** A pending lead quote's rejection reason when its prices moved, else null. */
export async function stalePendingLeadQuote(commercialId: string): Promise<string | null> {
    const rows = (await db.execute(sql`
        SELECT commercial_id::text AS id, product_lines, oem_evaluation
          FROM dealer_lead_commercials
         WHERE commercial_id = ${commercialId} AND approval_status = 'pending' AND withdrawn_at IS NULL
    `)) as unknown as PendingRow[];
    if (!rows[0]) return null;
    const changes = await priceChangesFor(rows[0]);
    return changes.length ? priceChangeReason(changes) : null;
}

/** A pending account quote's rejection reason when its prices moved, else null. */
export async function stalePendingAccountQuote(quotationId: string): Promise<string | null> {
    const rows = (await db.execute(sql`
        SELECT quotation_id::text AS id, product_lines, oem_evaluation
          FROM account_quotations
         WHERE quotation_id = ${quotationId}::uuid AND approval_status = 'pending' AND withdrawn_at IS NULL
    `)) as unknown as PendingRow[];
    if (!rows[0]) return null;
    const changes = await priceChangesFor(rows[0]);
    return changes.length ? priceChangeReason(changes) : null;
}

export type RecheckResult = { checked: number; rejected: number; failed: number };

/**
 * Reject every pending quote whose prices moved. With `product`, only quotes
 * carrying that product are read (the price-book save path); without it, all
 * pending quotes (the sweep).
 */
export async function recheckPendingQuotes(opts?: {
    product?: { asset_type: string; product_id: string };
}): Promise<RecheckResult> {
    const result: RecheckResult = { checked: 0, rejected: 0, failed: 0 };
    const containing = opts?.product
        ? sql`AND product_lines @> ${JSON.stringify([{ asset_type: opts.product.asset_type, product_id: opts.product.product_id }])}::jsonb`
        : sql``;

    let leadRows: PendingRow[] = [];
    try {
        leadRows = (await db.execute(sql`
            SELECT commercial_id::text AS id, product_lines, oem_evaluation
              FROM dealer_lead_commercials
             WHERE approval_status = 'pending' AND withdrawn_at IS NULL
               AND event_type IN ('quote_issue', 'quote_revision')
               ${containing}
        `)) as unknown as PendingRow[];
    } catch (err) {
        console.error("[priceChangeRecheck] lead read failed", err instanceof Error ? err.message : err);
    }
    for (const row of leadRows) {
        result.checked++;
        try {
            const changes = await priceChangesFor(row);
            if (changes.length === 0) continue;
            const r = await rejectPendingLeadQuote({
                commercialId: row.id,
                actor: { id: null, name: null },
                reason: priceChangeReason(changes),
            });
            if (r.status === 200) {
                result.rejected++;
                await r.notify();
            }
        } catch (err) {
            result.failed++;
            console.error("[priceChangeRecheck] lead quote", row.id, err instanceof Error ? err.message : err);
        }
    }

    if (!(await hasAccountQuotationTables())) return result;
    let accountRows: PendingRow[] = [];
    try {
        accountRows = (await db.execute(sql`
            SELECT quotation_id::text AS id, product_lines, oem_evaluation
              FROM account_quotations
             WHERE approval_status = 'pending' AND withdrawn_at IS NULL
               ${containing}
        `)) as unknown as PendingRow[];
    } catch (err) {
        console.error("[priceChangeRecheck] account read failed", err instanceof Error ? err.message : err);
    }
    if (accountRows.length === 0) return result;
    // Imported here: decision.ts imports this module (the Approve re-check), so a value import at the top would be a cycle.
    const { decideAccountQuotation } = await import("@/lib/accounts/quotations/decision");
    for (const row of accountRows) {
        result.checked++;
        try {
            const changes = await priceChangesFor(row);
            if (changes.length === 0) continue;
            await decideAccountQuotation({
                quotationId: row.id,
                decision: "reject",
                reason: priceChangeReason(changes),
                actor: { id: null, name: null },
            });
            result.rejected++;
        } catch (err) {
            result.failed++;
            console.error("[priceChangeRecheck] account quote", row.id, err instanceof Error ? err.message : err);
        }
    }
    return result;
}

/** Fire-and-forget wrapper for the price-book routes: the save has already succeeded. */
export async function recheckAfterPriceSave(product: { asset_type: string; product_id: string }, effectiveFrom: Date) {
    if (effectiveFrom.getTime() > Date.now()) return; // scheduled: the sweep picks it up on its day
    try {
        const r = await recheckPendingQuotes({ product });
        if (r.rejected > 0) {
            console.log(`[priceChangeRecheck] ${product.asset_type}:${product.product_id} rejected=${r.rejected} of ${r.checked}`);
        }
    } catch (err) {
        console.error("[priceChangeRecheck] after save failed", err instanceof Error ? err.message : err);
    }
}
