/**
 * Pure helpers for the admin reports.
 *
 * Separate from reports.ts because that module imports the Drizzle client,
 * which throws at import time when DATABASE_URL is unset — so anything living
 * there is unreachable from a unit test. Same split the rest of the codebase
 * uses (salesWindow.ts imports db/schema, never db/index).
 */

/**
 * Postgres "column does not exist" (42703) — in this codebase, an environment
 * that has not had a migration applied yet.
 *
 * Walks the cause chain. Drizzle wraps the driver error in its own "Failed
 * query" Error which carries no `code`, so checking only the top level matches
 * nothing and the caller's fallback silently never fires — which is exactly
 * how the E-220 fallback failed the first time.
 *
 * The `seen` set guards a self-referential cause; a cyclic chain would
 * otherwise spin forever inside a catch block.
 */
export function isUndefinedColumn(e: unknown): boolean {
    const seen = new Set<unknown>();
    for (let cur = e; cur && !seen.has(cur); cur = (cur as { cause?: unknown }).cause) {
        seen.add(cur);
        if ((cur as { code?: string }).code === "42703") return true;
    }
    return false;
}

export const ROLE_LABELS: Record<string, string> = {
    inside_sales_rep: "Inside Sales",
    sales_head: "Sales Head",
    sales_manager: "Sales Manager",
    sales_executive: "Sales Executive",
    asm: "ASM",
    ceo: "CEO",
    admin: "Admin",
    // ID 215 (14 Nov): every role a CEO page can show, in words.
    business_head: "Business Head",
    finance_controller: "Finance",
    inventory_manager: "Inventory Manager",
    service_engineer: "Service Engineer",
    sales_order_manager: "Sales Order Manager",
    dealer: "Dealer",
};

/**
 * "inside_sales_rep" → "Inside Sales" (roleLabel, below). An unmapped role reads as words
 * ("field_lead" → "Field lead") rather than blank or a code (ID 215), so it never looks
 * like missing data.
 */
/**
 * Funnel by Owner's "Conversion %": conversions credited to the person ÷ leads
 * they worked in the period (tracker ID 117).
 *
 * The two are counted from different sets since the conversion went to the
 * CLOSING owner: a lead someone closed earlier can be approved in a period in
 * which they logged nothing on it. So the share is null with no work to divide
 * by, and capped at 100 — "150%" would read as a bug, not as a late approval.
 */
export function ownerConversionRate(converted: number, touched: number): number | null {
    if (touched <= 0) return null;
    return Math.min(100, Math.round((converted / touched) * 100));
}

export function roleLabel(role: string | null | undefined): string {
    if (!role) return "—";
    // ID 215: an unlabelled role still reads as words, never as a code ("field_lead" → "Field lead").
    return ROLE_LABELS[role] ?? role.replace(/_/g, " ").replace(/^./, (c) => c.toUpperCase());
}
