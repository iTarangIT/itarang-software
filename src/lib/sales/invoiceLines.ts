/**
 * Invoice line items (E-322, tracker IDs 39, 70) — the shared rules for every
 * source that can supply lines: the one-time Zoho backfill and the weekly
 * Vyapar sales-register import.
 *
 * Batteries sold are counted from invoice lines only (Kartik, 26 Sep): stock
 * allocation is not used. A line is classified by its HSN code:
 *   8507…   → battery  (electric accumulators) — except 850790…, which is
 *             PARTS of accumulators ("LCD Display with Box", billed beside
 *             every battery): other. Counting it made one battery read as two.
 *   850440… → charger  (static converters)
 *   other   → other
 */

export const PRODUCT_CLASSES = ["battery", "charger", "other"] as const;
export type ProductClass = (typeof PRODUCT_CLASSES)[number];

/** Digits only, e.g. "8507.60.00" → "85076000". */
export function normalizeHsn(raw: unknown): string | null {
    const digits = String(raw ?? "").replace(/\D/g, "");
    return digits.length >= 4 ? digits.slice(0, 12) : null;
}

export function classifyHsn(raw: unknown): ProductClass {
    const hsn = normalizeHsn(raw);
    if (!hsn) return "other";
    if (hsn.startsWith("850790")) return "other";
    if (hsn.startsWith("8507")) return "battery";
    if (hsn.startsWith("850440")) return "charger";
    return "other";
}

/** The key a Vyapar item name is mapped by: lower-case, single spaces. */
export function itemKey(name: unknown): string {
    return String(name ?? "")
        .toLowerCase()
        .replace(/\s+/g, " ")
        .trim();
}

/**
 * The manufacturer's product code printed in an item name, e.g.
 * "…ER-57 (C-50)(FG3WMFG00035)Orange Color" → "fg3wmfg35". Leading zeros are
 * dropped because the same code is billed both ways ("FGCOMFG000002" and
 * "FGCOMFG00002"). null when the name carries none.
 */
export function productCode(name: unknown): string | null {
    const m = String(name ?? "").match(/\b(fg[a-z0-9]*?[a-z])0*(\d+)\b/i);
    return m ? `${m[1].toLowerCase()}${m[2]}` : null;
}

/**
 * An item name with what varies between invoices for the SAME product taken
 * out: the serial numbers billed on the next line, the product code, the
 * colour, a warranty note, "lithium" vs "li", and punctuation.
 */
export function cleanItemName(name: unknown): string {
    return String(name ?? "")
        .split(/\r?\n/)[0]
        .toLowerCase()
        .replace(/serial\s*no\.?\s*:.*$/i, " ")
        .replace(/\(\s*fg[a-z0-9]+\s*\)/gi, " ")
        .replace(/\bfg[a-z]*\d+\b/gi, " ")
        .replace(/\b(orange|black|white|blue|red|green|grey|gray)\s+colou?r\b/g, " ")
        .replace(/,?\s*\d+\s*(year|yr)s?\s*warranty/g, " ")
        .replace(/\blithium\b/g, "li")
        .replace(/[^a-z0-9]+/g, " ")
        .replace(/\s+/g, " ")
        .trim();
}

/**
 * The PRODUCT FAMILY an item name belongs to — its product code when it has
 * one, else its cleaned name. Spellings of one product share a family, so a
 * mapping made on one reaches the others, and a new invoice that bills the
 * product with this batch's serial numbers is mapped on arrival instead of
 * appearing as a new unmapped item. Stored in vyapar_item_map beside the
 * exact keys, prefixed "code:" / "name:" so the two can never collide.
 */
export function itemFamilyKey(name: unknown): string | null {
    const code = productCode(name);
    if (code) return `code:${code}`;
    const clean = cleanItemName(name);
    return clean ? `name:${clean}` : null;
}


/** Parse an Indian-formatted number cell ("1,23,456.50", "₹ 500", "(250)"). */
export function parseAmount(raw: unknown): number | null {
    if (raw == null || raw === "") return null;
    if (typeof raw === "number") return Number.isFinite(raw) ? raw : null;
    let s = String(raw).trim();
    const negative = /^\(.*\)$/.test(s) || s.startsWith("-");
    s = s.replace(/[^\d.]/g, "");
    if (!s) return null;
    const n = Number(s);
    if (!Number.isFinite(n)) return null;
    return negative ? -n : n;
}
