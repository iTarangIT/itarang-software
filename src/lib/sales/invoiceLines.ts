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
