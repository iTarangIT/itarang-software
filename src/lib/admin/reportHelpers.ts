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

const ROLE_LABELS: Record<string, string> = {
    inside_sales_rep: "Inside Sales",
    sales_head: "Sales Head",
    sales_manager: "Sales Manager",
    sales_executive: "Sales Executive",
    asm: "ASM",
    ceo: "CEO",
    admin: "Admin",
};

/**
 * "inside_sales_rep" → "Inside Sales". An unmapped role shows its raw value
 * rather than blank, so a role nobody has labelled yet looks unfamiliar instead
 * of looking like missing data.
 */
export function roleLabel(role: string | null): string {
    if (!role) return "—";
    return ROLE_LABELS[role] ?? role;
}
