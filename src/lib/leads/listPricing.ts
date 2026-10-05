/**
 * E-323 — list price rules (tracker IDs 4 and 47, decided 26 Sep 2026).
 *
 * PURE: no database, so the rules are unit-tested. The database half is
 * ./listPrices.ts.
 *
 *   OEM price    internal, never shown as such, decides CEO approval. Unchanged.
 *   List price   set by Admin or CEO, optional, printed on the quotation.
 *                Always >= the OEM price in the same window.
 *   Discount     list price − the negotiated (net) price, per line, before GST.
 *                Printed only when positive; there is never a negative discount.
 *
 * A product with no list price prints its OEM price as the list price; and the
 * printed list price is never below the net price, so a line sold above list
 * simply shows no discount.
 */

/** Half-open [from, until); null until = open-ended. */
export interface PriceWindow {
    from: Date;
    until: Date | null;
}

export function windowsOverlap(a: PriceWindow, b: PriceWindow): boolean {
    const aEnds = a.until?.getTime() ?? Infinity;
    const bEnds = b.until?.getTime() ?? Infinity;
    return a.from.getTime() < bEnds && b.from.getTime() < aEnds;
}

/**
 * The first OEM window, overlapping this list-price window, whose OEM price is
 * ABOVE the list price — the save must be refused. null = the list price holds
 * for every date it covers, scheduled OEM changes included.
 */
export function firstOemAboveList<T extends PriceWindow & { price: number }>(
    list: PriceWindow & { price: number },
    oemWindows: T[],
): T | null {
    return oemWindows.find((o) => windowsOverlap(list, o) && o.price > list.price) ?? null;
}

/** The mirror check when an OEM price is saved: a list price it would overtake. */
export function firstListBelowOem<T extends PriceWindow & { price: number }>(
    oem: PriceWindow & { price: number },
    listWindows: T[],
): T | null {
    return listWindows.find((l) => windowsOverlap(oem, l) && l.price < oem.price) ?? null;
}

/** What is frozen on the quote. list_price null = no list price was set for that product. */
export interface ListPriceSnapshot {
    lines: Array<{
        asset_type: string;
        product_id: string;
        list_price: number | null;
        list_price_id: string | null;
    }>;
}

/**
 * What one quotation line prints.
 *
 *   list     the admin list price; else the OEM price; else nothing to print
 *   printed  never below the net price
 *   discount printed − net, per unit; 0 when the dealer pays list or more
 *
 * null = this line has no list price to print at all (no list price, no OEM
 * price), so it prints its rate only.
 */
export function printedListPrice(input: {
    listPrice: number | null | undefined;
    oemPrice: number | null | undefined;
    netPrice: number;
}): { listPrice: number; discount: number } | null {
    const pick = (v: number | null | undefined) => (v != null && Number.isFinite(Number(v)) && Number(v) > 0 ? Number(v) : null);
    const candidate = pick(input.listPrice) ?? pick(input.oemPrice);
    if (candidate == null) return null;
    const net = Number.isFinite(input.netPrice) ? input.netPrice : 0;
    const listPrice = Math.max(candidate, net);
    return { listPrice, discount: Math.round((listPrice - net) * 100) / 100 };
}
