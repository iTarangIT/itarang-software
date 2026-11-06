/**
 * ID 205 — the one-time fix (decided 2 Nov, Kartik): on quotes saved before
 * the 29 Oct fix (f01958e6), a line's "list price" may be the OEM price —
 * snapshotListPrices used to fall back to it when the product had no list
 * price. A PDF re-made from such a quote would print the OEM figure as
 * "List price". This decides which line list prices to clear. Pure; the
 * database work is scripts/fix-id205-oem-list-prices.ts.
 *
 * A line's list price is cleared only when BOTH hold:
 *   1. no real list price covered that product when the quote was saved
 *      (so the figure cannot have come from product_list_prices), and
 *   2. it equals the OEM price the quote's own evaluation recorded for that
 *      product (so it is the OEM figure, not something typed).
 * A line that fails only check 2 is left alone and reported as "unclear".
 */
export type FixLine = {
    asset_type?: string | null;
    product_id?: string | null;
    list_price?: number | string | null;
    [k: string]: unknown;
};

export type OemEvalLine = { asset_type?: string | null; product_id?: string | null; oem_price?: number | string | null };

export type LineVerdict = "clear" | "keep_real_list_price" | "unclear" | "no_list_price";

const num = (v: unknown): number | null => {
    const n = typeof v === "string" ? Number(v) : typeof v === "number" ? v : NaN;
    return Number.isFinite(n) ? n : null;
};

const key = (a: string | null | undefined, p: string | null | undefined) => `${a ?? ""}:${p ?? ""}`;

export function lineVerdict(
    line: FixLine,
    oemLines: OemEvalLine[],
    hadRealListPrice: (assetType: string, productId: string) => boolean,
): LineVerdict {
    const lp = num(line.list_price);
    if (lp == null) return "no_list_price";
    if (line.asset_type && line.product_id && hadRealListPrice(line.asset_type, line.product_id)) {
        return "keep_real_list_price";
    }
    const oem = oemLines.find((o) => key(o.asset_type, o.product_id) === key(line.asset_type, line.product_id));
    const oemPrice = num(oem?.oem_price);
    return oemPrice != null && Math.abs(oemPrice - lp) < 0.005 ? "clear" : "unclear";
}

/** The quote's product lines with every "clear" line's list price set to null. */
export function clearedLines(
    lines: FixLine[],
    oemLines: OemEvalLine[],
    hadRealListPrice: (assetType: string, productId: string) => boolean,
): { lines: FixLine[]; cleared: number; unclear: number } {
    let cleared = 0;
    let unclear = 0;
    const out = lines.map((l) => {
        const v = lineVerdict(l, oemLines, hadRealListPrice);
        if (v === "unclear") unclear++;
        if (v !== "clear") return l;
        cleared++;
        return { ...l, list_price: null };
    });
    return { lines: out, cleared, unclear };
}
